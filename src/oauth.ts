// OAuth core (bi#22) — pi `auth/oauth/{pkce,device-code,oauth-page}.ts` +
// the refresh-inside-modify half of `auth/resolve.ts`, minus per-provider
// flows (bi#23/24 register those). Bun-isms are gone: the callback server
// is plain `node:http` (pi's anthropic flow already used it; only the
// loader was Bun-specific).
//
// Split: BAML owns URL shape + expiry arithmetic
// (BuildAuthorizeUrl/TokenExpiry/OAuthNeedsRefresh in auth.baml); this
// file owns randomness, sockets, timers, fetch, and the flow registry.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
	BuildAuthorizeUrl_async,
	Credential,
	OAuthNeedsRefresh_async,
	TokenExpiry_async,
} from "../baml_sdk/index.js";
import { modifyCredential } from "./auth.js";

// --- PKCE (pi pkce.ts, node:crypto instead of Web Crypto: bi is CLI-only) ---

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

// --- Callback page (pi oauth-page.ts, trimmed: no logo) ---

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(title: string, heading: string, message: string, details?: string): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>${details ? `<pre>${escapeHtml(details)}</pre>` : ""}</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage("Authentication successful", "Authentication successful", message);
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage("Authentication failed", "Authentication failed", message, details);
}

// --- Loopback callback server (pi anthropic.ts startCallbackServer) ---

export interface LoopbackServer {
	redirectUri: string;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	cancelWait: () => void;
	close: () => Promise<void>;
}

export async function startLoopbackServer(opts: {
	port?: number;
	path?: string;
	/** Bind/URI host: pre-registered redirect URIs pin this (codex uses localhost). */
	host?: string;
	expectedState: string;
	providerName?: string;
}): Promise<LoopbackServer> {
	const path = opts.path ?? "/callback";
	const host = opts.host ?? "127.0.0.1";
	const name = opts.providerName ?? "OAuth";
	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		let settled = false;
		const settle = (value: { code: string; state: string } | null) => {
			if (settled) return;
			settled = true;
			settleWait?.(value);
		};
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			settleWait = resolveWait;
		});
		const server: Server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== path) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml(`${name} authentication did not complete.`, `Error: ${error}`));
					return;
				}
				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}
				if (state !== opts.expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml(`${name} authentication completed. You can close this window.`));
				settle({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});
		server.on("error", reject);
		server.listen(opts.port ?? 0, host, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
			resolve({
				redirectUri: `http://${host}:${port}${path}`,
				waitForCode: () => waitForCodePromise,
				cancelWait: () => settle(null),
				close: () => new Promise((resClose) => server.close(() => resClose())),
			});
		});
	});
}

// --- Token HTTP (pi postJson: 30s cap, caller signal honored) ---

export async function postToken(
	url: string,
	body: Record<string, string | number>,
	signal?: AbortSignal,
): Promise<string> {
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		signal: combined,
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

export interface TokenSet {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

// Form-encoded token endpoint (pi codex: application/x-www-form-urlencoded).
export async function postTokenForm(
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<string> {
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		signal: combined,
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

// JWT account claim (pi codex getAccountId): payload segment of the
// access token. The claim path may itself contain slashes (pi codex uses
// a URL as the top-level key), so every split point is tried longest
// first: the left side must be an existing key, the rest walks down.
export function decodeJwtAccountId(accessToken: string, claimPath: string): string | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return null;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const segs = claimPath.split("/");
		for (let i = segs.length; i >= 1; i--) {
			const left = segs.slice(0, i).join("/");
			if (typeof payload !== "object" || payload === null || !(left in payload)) continue;
			let cur: unknown = (payload as Record<string, unknown>)[left];
			let ok = true;
			for (const s of segs.slice(i)) {
				if (typeof cur !== "object" || cur === null || !(s in (cur as Record<string, unknown>))) {
					ok = false;
					break;
				}
				cur = (cur as Record<string, unknown>)[s];
			}
			if (ok && typeof cur === "string" && cur.length > 0) return cur;
		}
		return null;
	} catch {
		return null;
	}
}

export function parseTokenResponse(url: string, responseBody: string): TokenSet {
	let data: unknown;
	try {
		data = JSON.parse(responseBody);
	} catch (error) {
		throw new Error(`Token endpoint returned invalid JSON. url=${url}; body=${responseBody}; details=${String(error)}`);
	}
	const d = data as Partial<TokenSet>;
	if (typeof d.access_token !== "string" || typeof d.refresh_token !== "string" || typeof d.expires_in !== "number") {
		throw new Error(`Token endpoint omitted access_token/refresh_token/expires_in. url=${url}; body=${responseBody}`);
	}
	return { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in };
}

// --- Device-code poll (pi device-code.ts, RFC 8628 §3.5) ---

export type DevicePollResult<T> =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string }
	| { status: "complete"; value: T };

export function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(cancelMessage));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function pollDeviceCodeFlow<T>(opts: {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	waitBeforeFirstPoll?: boolean;
	poll: () => Promise<DevicePollResult<T>>;
	signal: AbortSignal;
}): Promise<T> {
	const minIntervalMs = 1000;
	const deadline =
		typeof opts.expiresInSeconds === "number" ? Date.now() + opts.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(minIntervalMs, Math.floor((opts.intervalSeconds ?? 5) * 1000));
	let slowDowns = 0;
	if (opts.waitBeforeFirstPoll) {
		const remainingMs = deadline - Date.now();
		if (remainingMs > 0) await abortableSleep(Math.min(intervalMs, remainingMs), opts.signal, "Login cancelled");
	}
	while (Date.now() < deadline) {
		if (opts.signal.aborted) throw new Error("Login cancelled");
		const result = await opts.poll();
		if (result.status === "complete") return result.value;
		if (result.status === "failed") throw new Error(result.message);
		if (result.status === "slow_down") {
			slowDowns += 1;
			intervalMs =
				typeof result.intervalSeconds === "number" && result.intervalSeconds > 0
					? Math.max(minIntervalMs, Math.floor(result.intervalSeconds * 1000))
					: Math.max(minIntervalMs, intervalMs + 5000);
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), opts.signal, "Login cancelled");
	}
	throw new Error(slowDowns > 0 ? "Device flow timed out after slow_down responses (check VM clock drift)" : "Device flow timed out");
}

// --- Flow registry (bi#23/24 fill this; pi load.ts is the equivalent) ---

export interface OAuthFlow {
	id: string;
	name: string;
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string;
	callbackPath?: string;
	/** Pre-registered redirect URIs pin this (e.g. Anthropic :53692); 0/undefined = ephemeral. */
	callbackPort?: number;
	/** Pre-registered redirect host (codex uses localhost, not 127.0.0.1). */
	callbackHost?: string;
	extraAuthorizeParams?: Record<string, string>;
	/** Token endpoint body: pi anthropic takes JSON, pi codex takes form. */
	tokenBodyFormat?: "json" | "form";
	/** Pi codex uses a separate random state; anthropic reuses the verifier. */
	separateState?: boolean;
	/** Pi codex requires the chatgpt account id from the access JWT. */
	requireAccountId?: boolean;
	accountClaimPath?: string;
	/** TokenExpiry skew override (codex: none). Defaults to BAML's 5 minutes. */
	expirySkewMs?: number;
}

export const DEFAULT_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth/chatgpt_account_id";

const flows = new Map<string, OAuthFlow>();

export function registerOAuthFlow(flow: OAuthFlow): void {
	flows.set(flow.id, flow);
}

let builtinsRegistered = false;

export function getOAuthFlow(providerId: string): OAuthFlow | undefined {
	if (!builtinsRegistered) {
		builtinsRegistered = true;
		registerBuiltinOAuthFlows();
	}
	return flows.get(providerId);
}

function tokenRequest(flow: OAuthFlow, params: Record<string, string>, signal?: AbortSignal): Promise<string> {
	if (flow.tokenBodyFormat === "form") return postTokenForm(flow.tokenUrl, params, signal);
	return postToken(flow.tokenUrl, params, signal);
}

async function credentialFromTokenResponse(
	flow: OAuthFlow,
	tokenUrl: string,
	responseBody: string,
): Promise<Credential> {
	const tokens = parseTokenResponse(tokenUrl, responseBody);
	let accountId: string | null = null;
	if (flow.requireAccountId) {
		accountId = decodeJwtAccountId(tokens.access_token, flow.accountClaimPath ?? DEFAULT_ACCOUNT_CLAIM_PATH);
		if (!accountId) throw new Error(`Failed to extract account id from ${flow.name} access token`);
	}
	const skew = flow.expirySkewMs ?? 300000;
	return new Credential({
		provider_id: flow.id,
		type: "oauth",
		key: null,
		refresh: tokens.refresh_token,
		access: tokens.access_token,
		expires: await TokenExpiry_async(tokens.expires_in, Date.now(), { skew_ms: skew }),
		account_id: accountId,
	});
}

export interface OAuthInteraction {
	signal: AbortSignal;
	notify: (n: { type: "auth_url" | "progress"; url?: string; message?: string; instructions?: string }) => void;
	prompt: (message: string, placeholder?: string, signal?: AbortSignal) => Promise<string>;
}

// Manual-code parsing (pi parseAuthorizationInput): full redirect URL,
// code#state, query string, or a bare code.
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// not a URL
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

// PKCE authorize-code login (pi loginAnthropic/loginOpenAICodex,
// generalized over the flow: JSON/form token bodies, verifier or separate
// random state, account-id extraction, per-flow expiry skew).
export async function loginPKCEFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	const { verifier, challenge } = generatePKCE();
	const expectedState = flow.separateState ? randomBytes(16).toString("hex") : verifier;
	const server = await startLoopbackServer({
		port: flow.callbackPort ?? 0,
		path: flow.callbackPath ?? "/callback",
		host: flow.callbackHost,
		expectedState,
		providerName: flow.name,
	});
	const manualAbort = new AbortController();
	const onAbort = () => server.cancelWait();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	if (interaction.signal.aborted) onAbort();
	let code: string | undefined;
	let state: string | undefined;
	let manualInput: string | undefined;
	let manualError: Error | undefined;
	try {
		let url = await BuildAuthorizeUrl_async(
			flow.authorizeUrl,
			flow.clientId,
			encodeURIComponent(server.redirectUri),
			encodeURIComponent(flow.scopes),
			challenge,
			expectedState,
		);
		if (flow.extraAuthorizeParams) url += `&${new URLSearchParams(flow.extraAuthorizeParams).toString()}`;
		interaction.notify({
			type: "auth_url",
			url,
			instructions: "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const manualPromise = interaction
			.prompt("Complete login in your browser, or paste the authorization code / redirect URL here:", server.redirectUri, manualAbort.signal)
			.then((input) => {
				manualInput = input;
				server.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				server.cancelWait();
			});
		const takeManual = () => {
			if (!manualInput) return;
			const parsed = parseAuthorizationInput(manualInput);
			if (parsed.state && parsed.state !== expectedState) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? expectedState;
		};
		const result = await server.waitForCode();
		if (manualError) throw manualError;
		if (result?.code) {
			code = result.code;
			state = result.state;
		} else {
			takeManual();
		}
		if (!code) {
			await manualPromise;
			if (manualError) throw manualError;
			takeManual();
		}
		if (!code) throw new Error("Missing authorization code");
		if (!state) throw new Error("Missing OAuth state");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const body = await tokenRequest(
			flow,
			{
				grant_type: "authorization_code",
				client_id: flow.clientId,
				code,
				state,
				redirect_uri: server.redirectUri,
				code_verifier: verifier,
			},
			interaction.signal,
		);
		return credentialFromTokenResponse(flow, flow.tokenUrl, body);
	} finally {
		interaction.signal.removeEventListener("abort", onAbort);
		manualAbort.abort();
		await server.close();
	}
}

// Refresh inside the serialized modify (pi resolve.ts): re-check expiry
// under the lock so concurrent requests refresh exactly once. Failure
// throws — the caller (getAuth) must not silently fall back to env.
export async function refreshOAuthCredential(
	providerId: string,
	opts?: { signal?: AbortSignal; minOAuthValidityMs?: number },
): Promise<void> {
	const flow = getOAuthFlow(providerId);
	if (!flow) throw new Error(`No OAuth flow registered for ${providerId} (bi#23/24)`);
	const minValidity = opts?.minOAuthValidityMs ?? 300000;
	await modifyCredential(providerId, async (cur) => {
		if (!cur || cur.type !== "oauth" || !cur.refresh) return cur;
		if (!(await OAuthNeedsRefresh_async(cur.expires, Date.now(), { min_validity_ms: minValidity }))) return cur;
		const body = await tokenRequest(
			flow,
			{ grant_type: "refresh_token", client_id: flow.clientId, refresh_token: cur.refresh },
			opts?.signal,
		);
		return credentialFromTokenResponse(flow, flow.tokenUrl, body);
	});
}

// bi#23: builtin flows (pi `auth/oauth/{anthropic,openai-codex}.ts`
// constants verbatim). Lazily registered on first getOAuthFlow so every
// entry point (CLI, REPL, probes) sees them without import order games.
export function registerBuiltinOAuthFlows(): void {
	registerOAuthFlow({
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		authorizeUrl: "https://claude.ai/oauth/authorize",
		tokenUrl: "https://platform.claude.com/v1/oauth/token",
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		callbackPath: "/callback",
		callbackPort: 53692,
	});
	registerOAuthFlow({
		id: "openai-codex",
		name: "OpenAI (ChatGPT Plus/Pro)",
		authorizeUrl: "https://auth.openai.com/oauth/authorize",
		tokenUrl: "https://auth.openai.com/oauth/token",
		clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
		scopes: "openid profile email offline_access",
		callbackPath: "/auth/callback",
		callbackPort: 1455,
		callbackHost: "localhost",
		extraAuthorizeParams: {
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "bi",
		},
		tokenBodyFormat: "form",
		separateState: true,
		requireAccountId: true,
		expirySkewMs: 0,
	});
}
