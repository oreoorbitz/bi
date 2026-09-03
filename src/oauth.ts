// OAuth core (bi#22) — pi `auth/oauth/{pkce,device-code,oauth-page}.ts` +
// the refresh-inside-modify half of `auth/resolve.ts`, minus per-provider
// flows (bi#23/24 register those). Bun-isms are gone: the callback server
// is plain `node:http` (pi's anthropic flow already used it; only the
// loader was Bun-specific).
//
// Split: BAML owns URL shape + expiry arithmetic
// (BuildAuthorizeUrl/TokenExpiry/OAuthNeedsRefresh in auth.baml); this
// file owns randomness, sockets, timers, fetch, and the flow registry.

import { createHash, randomBytes, randomUUID } from "node:crypto";
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
	/** Undefined skips the state check (openrouter carries no state). */
	expectedState?: string;
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
				const state = url.searchParams.get("state") ?? "";
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml(`${name} authentication did not complete.`, `Error: ${error}`));
					return;
				}
				if (!code || (opts.expectedState !== undefined && !state)) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}
				if (opts.expectedState !== undefined && state !== opts.expectedState) {
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

export interface TokenHttpResult {
	ok: boolean;
	status: number;
	bodyText: string;
}

// Never throws except on network/abort: device polling needs the error
// body to map authorization_pending/slow_down/denied names.
export async function requestToken(
	url: string,
	opts: {
		format: "json" | "form";
		params: Record<string, string>;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	},
): Promise<TokenHttpResult> {
	const timeout = AbortSignal.timeout(30_000);
	const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const isForm = opts.format === "form";
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
			Accept: "application/json",
			...opts.headers,
		},
		body: isForm ? new URLSearchParams(opts.params).toString() : JSON.stringify(opts.params),
		signal: combined,
	});
	return { ok: response.ok, status: response.status, bodyText: await response.text() };
}

export async function postToken(
	url: string,
	body: Record<string, string | number>,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<string> {
	const params: Record<string, string> = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
	const res = await requestToken(url, { format: "json", params, headers, signal });
	if (!res.ok) {
		throw new Error(`HTTP request failed. status=${res.status}; url=${url}; body=${res.bodyText}`);
	}
	return res.bodyText;
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
	headers?: Record<string, string>,
): Promise<string> {
	const res = await requestToken(url, { format: "form", params, headers, signal });
	if (!res.ok) {
		throw new Error(`HTTP request failed. status=${res.status}; url=${url}; body=${res.bodyText}`);
	}
	return res.bodyText;
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

export interface DeviceCodeConfig {
	codeUrl: string;
	tokenUrl: string;
	scope?: string;
	extraParams?: Record<string, string>;
	/** First set env var replaces the origin of both URLs (kimi host override). */
	hostEnvVars?: string[];
	/** Used when the server omits the field (kimi defaults). Unset = strict. */
	expiresDefaultS?: number;
	intervalDefaultS?: number;
	/** Trusted verification-URI schemes (xai: https only). */
	verificationSchemes?: ("https" | "http")[];
}

export interface OAuthFlow {
	id: string;
	name: string;
	/** Omitted for device-only flows (xai/kimi/copilot). */
	authorizeUrl?: string;
	tokenUrl: string;
	/** Omitted when the flow has no client id (openrouter). */
	clientId?: string;
	scopes: string;
	callbackPath?: string;
	/** Pre-registered redirect URIs pin this (e.g. Anthropic :53692); 0/undefined = ephemeral. */
	callbackPort?: number;
	/** Pre-registered redirect host (codex uses localhost, not 127.0.0.1). */
	callbackHost?: string;
	extraAuthorizeParams?: Record<string, string>;
	/** Extra headers on token/device HTTP (copilot's User-Agent). */
	extraHeaders?: Record<string, string>;
	/** Token endpoint body: pi anthropic takes JSON, pi codex takes form. */
	tokenBodyFormat?: "json" | "form";
	/** Pi codex uses a separate random state; anthropic reuses the verifier. */
	separateState?: boolean;
	/** Pi codex requires the chatgpt account id from the access JWT. */
	requireAccountId?: boolean;
	accountClaimPath?: string;
	/** TokenExpiry skew override (codex/kimi: none). Defaults to BAML's 5 minutes. */
	expirySkewMs?: number;
	/** RFC 8628 device authorization grant (xai/kimi/copilot-shaped). */
	deviceCode?: DeviceCodeConfig;
	/** xai: a refresh response may omit refresh_token (keep the previous). */
	keepRefreshToken?: boolean;
	/** Used when a token response omits expires_in (xai: 3600). Unset = strict. */
	defaultLifetimeS?: number;
	/** Kimi retries refresh on network/429/5xx (1s exponential backoff). */
	refreshMaxRetries?: number;
	/** Opaque gateway origin for gateway-relative flows (radius). */
	gateway?: string;
	/** Fully custom login (openrouter/copilot/radius). Default: device flow when deviceCode is set, else PKCE. */
	login?: (flow: OAuthFlow, interaction: OAuthInteraction) => Promise<Credential>;
	/** Fully custom refresh (copilot's Bearer exchange). Default: generic refresh_token grant. */
	refresh?: (flow: OAuthFlow, current: Credential, signal?: AbortSignal) => Promise<Credential>;
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
	if (flow.tokenBodyFormat === "form") return postTokenForm(flow.tokenUrl, params, signal, flow.extraHeaders);
	return postToken(flow.tokenUrl, params, signal, flow.extraHeaders);
}

export interface ParsedTokenBody {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

function readTokenBody(tokenUrl: string, responseBody: string): ParsedTokenBody {
	let data: unknown;
	try {
		data = JSON.parse(responseBody);
	} catch (error) {
		throw new Error(`Token endpoint returned invalid JSON. url=${tokenUrl}; body=${responseBody}; details=${String(error)}`);
	}
	const d = (data ?? {}) as Partial<ParsedTokenBody>;
	if (typeof d.access_token !== "string" || !d.access_token) {
		throw new Error(`Token endpoint omitted access_token. url=${tokenUrl}; body=${responseBody}`);
	}
	return d as ParsedTokenBody;
}

async function credentialFromTokenResponse(flow: OAuthFlow, tokenUrl: string, responseBody: string): Promise<Credential> {
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

// Lenient variant for device/refresh responses: xai may omit
// refresh_token (keep the previous) and expires_in (default lifetime).
async function credentialFromLenientToken(
	flow: OAuthFlow,
	tokenUrl: string,
	responseBody: string,
	prevRefresh?: string,
): Promise<Credential> {
	const d = readTokenBody(tokenUrl, responseBody);
	const refresh = d.refresh_token ?? (flow.keepRefreshToken ? prevRefresh : undefined);
	if (typeof refresh !== "string" || !refresh) {
		throw new Error(`Token endpoint omitted refresh_token. url=${tokenUrl}; body=${responseBody}`);
	}
	const lifetime = d.expires_in ?? flow.defaultLifetimeS;
	if (typeof lifetime !== "number" || !Number.isFinite(lifetime) || lifetime <= 0) {
		throw new Error(`Token endpoint omitted expires_in. url=${tokenUrl}; body=${responseBody}`);
	}
	const skew = flow.expirySkewMs ?? 300000;
	return new Credential({
		provider_id: flow.id,
		type: "oauth",
		key: null,
		refresh,
		access: d.access_token,
		expires: await TokenExpiry_async(lifetime, Date.now(), { skew_ms: skew }),
		account_id: null,
	});
}

export interface DeviceCodeNotice {
	type: "device_code";
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthInteraction {
	signal: AbortSignal;
	notify: (
		n:
			| { type: "auth_url"; url: string; instructions?: string }
			| { type: "progress"; message: string }
			| DeviceCodeNotice,
	) => void;
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

// First set env var wins; replaces the URL origin keeping the path
// (kimi host override: KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST).
function applyHostOverride(url: string, envVars?: string[]): string {
	if (!envVars) return url;
	for (const v of envVars) {
		const host = process.env[v]?.replace(/\/+$/, "");
		if (!host) continue;
		const u = new URL(url);
		const h = new URL(host);
		u.protocol = h.protocol;
		u.host = h.host;
		return u.toString();
	}
	return url;
}

export function checkVerificationUri(raw: unknown, schemes: ("https" | "http")[] | undefined, flowName: string): string {
	if (typeof raw !== "string" || !raw) throw new Error(`Invalid device authorization response for ${flowName}`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Untrusted verification URI in ${flowName} OAuth response`);
	}
	const allowed = schemes ?? ["https"];
	if (!allowed.some((s) => `${s}:` === url.protocol)) {
		throw new Error(`Untrusted verification URI in ${flowName} OAuth response`);
	}
	return url.href;
}

// Generic RFC 8628 device login (pi xai/kimi shapes): form device-code
// request, user-code notify, device_code-grant polling, lenient token
// mapping. Copilot/openrouter/radius override `login` with custom fns.
export async function loginDeviceFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	const dc = flow.deviceCode;
	if (!dc) throw new Error(`No device-code config for ${flow.name}`);
	if (!flow.clientId) throw new Error(`Device login needs a client_id for ${flow.name}`);
	const codeUrl = applyHostOverride(dc.codeUrl, dc.hostEnvVars);
	const tokenUrl = applyHostOverride(dc.tokenUrl, dc.hostEnvVars);
	const codeParams: Record<string, string> = { client_id: flow.clientId };
	if (dc.scope) codeParams.scope = dc.scope;
	Object.assign(codeParams, dc.extraParams);
	const codeRes = await requestToken(codeUrl, {
		format: "form",
		params: codeParams,
		headers: flow.extraHeaders,
		signal: interaction.signal,
	});
	if (!codeRes.ok) {
		throw new Error(`${flow.name} device authorization failed (status ${codeRes.status}): ${codeRes.bodyText}`);
	}
	let codeBody: Record<string, unknown>;
	try {
		codeBody = JSON.parse(codeRes.bodyText) as Record<string, unknown>;
	} catch {
		throw new Error(`${flow.name} device authorization returned invalid JSON: ${codeRes.bodyText}`);
	}
	const required = (field: string): string => {
		const v = codeBody[field];
		if (typeof v !== "string" || !v) throw new Error(`Invalid ${flow.name} device authorization field: ${field}`);
		return v;
	};
	const intervalRaw = codeBody.interval;
	const intervalSeconds =
		typeof intervalRaw === "number" && Number.isFinite(intervalRaw) && intervalRaw > 0
			? intervalRaw
			: dc.intervalDefaultS;
	const expiresRaw = codeBody.expires_in;
	const expiresInSeconds =
		typeof expiresRaw === "number" && Number.isFinite(expiresRaw) && expiresRaw > 0
			? expiresRaw
			: dc.expiresDefaultS;
	if (typeof expiresInSeconds !== "number") {
		throw new Error(`Invalid ${flow.name} device authorization field: expires_in`);
	}
	const verificationUri = checkVerificationUri(codeBody.verification_uri, dc.verificationSchemes, flow.name);
	const completeRaw = codeBody.verification_uri_complete;
	const verificationComplete =
		typeof completeRaw === "string" && completeRaw
			? checkVerificationUri(completeRaw, dc.verificationSchemes, flow.name)
			: undefined;
	interaction.notify({
		type: "device_code",
		userCode: required("user_code"),
		verificationUri: verificationComplete ?? verificationUri,
		intervalSeconds,
		expiresInSeconds,
	});
	return pollDeviceCodeFlow<Credential>({
		intervalSeconds,
		expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal: interaction.signal,
		poll: async () => {
			let res: TokenHttpResult;
			try {
				res = await requestToken(tokenUrl, {
					format: "form",
					params: {
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: flow.clientId as string,
						device_code: required("device_code"),
					},
					headers: flow.extraHeaders,
					signal: interaction.signal,
				});
			} catch (error) {
				if (interaction.signal.aborted) throw new Error("Login cancelled");
				throw error;
			}
			if (res.ok) {
				try {
					return { status: "complete", value: await credentialFromLenientToken(flow, tokenUrl, res.bodyText) };
				} catch (error) {
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}
			let errBody: { error?: unknown } = {};
			try {
				errBody = JSON.parse(res.bodyText) as { error?: unknown };
			} catch {
				// status-only decision below
			}
			const errName = typeof errBody.error === "string" ? errBody.error : undefined;
			if (errName === "authorization_pending") return { status: "pending" };
			if (errName === "slow_down") {
				const parsed = errBody as { interval?: unknown };
				return {
					status: "slow_down",
					intervalSeconds: typeof parsed.interval === "number" && parsed.interval > 0 ? parsed.interval : undefined,
				};
			}
			if (errName === "access_denied" || errName === "authorization_denied") {
				return { status: "failed", message: `${flow.name} device authorization was denied` };
			}
			if (errName === "expired_token") {
				return { status: "failed", message: `${flow.name} device code expired` };
			}
			return { status: "failed", message: `${flow.name} device token polling failed (status ${res.status}): ${res.bodyText}` };
		},
	});
}

// Loopback-vs-manual race shared by the browser logins (pi pattern):
// the loopback usually wins; a pasted redirect URL/code takes over when
// the browser cannot reach it. expectedState is skipped when undefined
// (openrouter carries no state).
export async function raceManualCode(
	server: LoopbackServer,
	interaction: OAuthInteraction,
	expectedState?: string,
): Promise<{ code: string; state: string }> {
	const manualAbort = new AbortController();
	const onAbort = () => server.cancelWait();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	if (interaction.signal.aborted) onAbort();
	let code: string | undefined;
	let state: string | undefined;
	let manualInput: string | undefined;
	let manualError: Error | undefined;
	try {
		const manualPromise = interaction
			.prompt(
				"Complete login in your browser, or paste the authorization code / redirect URL here:",
				server.redirectUri,
				manualAbort.signal,
			)
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
			if (expectedState && parsed.state && parsed.state !== expectedState) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? expectedState ?? "";
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
		if (expectedState && !state) throw new Error("Missing OAuth state");
		return { code, state: state ?? "" };
	} finally {
		interaction.signal.removeEventListener("abort", onAbort);
		manualAbort.abort();
	}
}

// PKCE authorize-code login (pi loginAnthropic/loginOpenAICodex,
// generalized over the flow: JSON/form token bodies, verifier or separate
// random state, account-id extraction, per-flow expiry skew).
export async function loginPKCEFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	if (!flow.authorizeUrl) throw new Error(`No authorize URL for ${flow.name}`);
	if (!flow.clientId) throw new Error(`PKCE login needs a client_id for ${flow.name}`);
	const { verifier, challenge } = generatePKCE();
	const expectedState = flow.separateState ? randomBytes(16).toString("hex") : verifier;
	const server = await startLoopbackServer({
		port: flow.callbackPort ?? 0,
		path: flow.callbackPath ?? "/callback",
		host: flow.callbackHost,
		expectedState,
		providerName: flow.name,
	});
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
		const { code, state } = await raceManualCode(server, interaction, expectedState);
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
		if (flow.refresh) return flow.refresh(flow, cur, opts?.signal);
		return refreshWithGrant(flow, cur.refresh, opts?.signal);
	});
}

// Generic refresh_token grant with per-flow variance: form/JSON body,
// keep-previous-refresh + default lifetime (xai), bounded retry on
// network/429/5xx (kimi). 401/403/invalid_grant fail fast — the stored
// credential is dead and only re-login helps.
async function refreshWithGrant(flow: OAuthFlow, refreshToken: string, signal?: AbortSignal): Promise<Credential> {
	if (!flow.clientId) throw new Error(`OAuth refresh needs a client_id for ${flow.name}`);
	// Device flows resolve their token origin the same way at login and
	// refresh (kimi host override); PKCE flows use the static tokenUrl.
	const tokenUrl = flow.deviceCode ? applyHostOverride(flow.tokenUrl, flow.deviceCode.hostEnvVars) : flow.tokenUrl;
	const maxRetries = flow.refreshMaxRetries ?? 0;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = 1000 * 2 ** (attempt - 1);
			if (signal) await abortableSleep(delay, signal, "Login cancelled");
			else await new Promise((r) => setTimeout(r, delay));
		}
		if (signal?.aborted) throw new Error("Login cancelled");
		let res: TokenHttpResult;
		try {
			res = await requestToken(tokenUrl, {
				format: flow.tokenBodyFormat === "form" ? "form" : "json",
				params: { grant_type: "refresh_token", client_id: flow.clientId, refresh_token: refreshToken },
				headers: flow.extraHeaders,
				signal,
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (signal?.aborted) throw lastError;
			continue;
		}
		if (res.ok) {
			return credentialFromLenientToken(flow, tokenUrl, res.bodyText, refreshToken);
		}
		let body: ParsedTokenBody & { error?: unknown; error_description?: unknown } = { access_token: "" };
		try {
			body = { access_token: "", ...(JSON.parse(res.bodyText) as Record<string, unknown>) };
		} catch {
			// keep empty body; status-only decision below
		}
		const code = typeof body.error === "string" ? body.error : undefined;
		if (res.status === 401 || res.status === 403 || code === "invalid_grant") {
			const desc = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
			throw new Error(`${flow.name} token refresh unauthorized (status ${res.status})${desc}`);
		}
		lastError = new Error(`${flow.name} token refresh failed (status ${res.status}): ${res.bodyText}`);
		if (!isRetryableRefreshStatus(res.status) || attempt >= maxRetries) throw lastError;
	}
	throw lastError ?? new Error(`${flow.name} token refresh failed`);
}

function isRetryableRefreshStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

export function resolveFlowLogin(flow: OAuthFlow): (flow: OAuthFlow, interaction: OAuthInteraction) => Promise<Credential> {
	if (flow.login) return flow.login;
	if (flow.deviceCode) return loginDeviceFlow;
	return loginPKCEFlow;
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
	// --- Batch 2 (bi#24) ---
	registerOAuthFlow({
		id: "xai",
		name: "xAI (Grok/X subscription)",
		tokenUrl: "https://auth.x.ai/oauth2/token",
		clientId: "b1a00492-073a-47ea-816f-4c329264a828",
		scopes: "openid profile email offline_access grok-cli:access api:access",
		tokenBodyFormat: "form",
		keepRefreshToken: true,
		defaultLifetimeS: 3600,
		deviceCode: {
			codeUrl: "https://auth.x.ai/oauth2/device/code",
			tokenUrl: "https://auth.x.ai/oauth2/token",
			scope: "openid profile email offline_access grok-cli:access api:access",
			extraParams: { referrer: "bi" },
		},
	});
	registerOAuthFlow({
		id: "openrouter",
		name: "OpenRouter OAuth",
		authorizeUrl: "https://openrouter.ai/auth",
		tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
		scopes: "",
		login: loginOpenRouterFlow,
		refresh: (_flow, current) => Promise.resolve(current),
	});
	registerOAuthFlow({
		id: "github-copilot",
		name: "GitHub Copilot",
		tokenUrl: "https://api.individual.githubcopilot.com/copilot_internal/v2/token",
		clientId: "Iv1.b507a08c87ecfe98",
		scopes: "read:user",
		extraHeaders: { "User-Agent": "GitHubCopilotChat/0.35.0" },
		login: loginCopilotFlow,
		refresh: refreshCopilotFlow,
		deviceCode: {
			codeUrl: "https://github.com/login/device/code",
			tokenUrl: "https://github.com/login/oauth/access_token",
			verificationSchemes: ["https", "http"],
		},
	});
	registerOAuthFlow({
		id: "kimi-coding",
		name: "Kimi Code (subscription)",
		tokenUrl: "https://auth.kimi.com/api/oauth/token",
		clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
		scopes: "",
		tokenBodyFormat: "form",
		expirySkewMs: 0,
		refreshMaxRetries: 3,
		deviceCode: {
			codeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
			tokenUrl: "https://auth.kimi.com/api/oauth/token",
			hostEnvVars: ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"],
			expiresDefaultS: 900,
			intervalDefaultS: 5,
			verificationSchemes: ["https", "http"],
		},
	});
	// Radius is a self-hosted gateway: registration needs RADIUS_GATEWAY.
	// "pi-gateway" is the client id the gateway software expects (protocol
	// constant, like codex's app id) — not our brand.
	const radiusGateway = process.env.RADIUS_GATEWAY?.replace(/\/+$/, "");
	if (radiusGateway) {
		registerOAuthFlow({
			id: "radius",
			name: "Radius gateway",
			tokenUrl: `${radiusGateway}/v1/oauth/token`,
			clientId: "pi-gateway",
			scopes: "gateway offline_access",
			callbackPath: "/oauth/callback",
			callbackPort: 1456,
			extraAuthorizeParams: { handoff: "url" },
			tokenBodyFormat: "form",
			expirySkewMs: 60000,
			gateway: radiusGateway,
			login: loginRadiusFlow,
		});
	}
}

// --- Batch 2 custom logins (bi#24) ---

// OpenRouter exchanges the code for a permanent user API key rather than
// an expiring pair (pi openrouter.ts): random callback path, no state,
// no client id, no refresh (the key does not rotate).
export async function loginOpenRouterFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	const { verifier, challenge } = generatePKCE();
	const server = await startLoopbackServer({
		path: `/oauth/callback/${randomUUID()}`,
		providerName: flow.name,
	});
	try {
		if (!flow.authorizeUrl) throw new Error(`No authorize URL for ${flow.name}`);
		const url = new URL(flow.authorizeUrl);
		url.search = new URLSearchParams({
			callback_url: server.redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		interaction.notify({ type: "progress", message: `Listening for OpenRouter OAuth callback on ${server.redirectUri}` });
		interaction.notify({
			type: "auth_url",
			url: url.toString(),
			instructions: "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const { code } = await raceManualCode(server, interaction);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for an API key..." });
		const body = await postToken(
			flow.tokenUrl,
			{ code, code_verifier: verifier, code_challenge_method: "S256" },
			interaction.signal,
			flow.extraHeaders,
		);
		let key: unknown;
		try {
			key = (JSON.parse(body) as { key?: unknown }).key;
		} catch {
			throw new Error("OpenRouter OAuth returned invalid JSON");
		}
		if (typeof key !== "string" || !key) throw new Error('OpenRouter OAuth response carries no "key"');
		return new Credential({
			provider_id: flow.id,
			type: "oauth",
			key: null,
			refresh: "",
			access: key,
			expires: Number.MAX_SAFE_INTEGER,
			account_id: null,
		});
	} finally {
		await server.close();
	}
}

// GitHub Copilot device login (pi github-copilot.ts, login half): prompt
// the enterprise domain (github.com only for now), device-code grant,
// then exchange the GitHub token for a Copilot token. Model catalog
// fetch + policy enablement stay out — that is model management, owned
// by the copilot backend when it lands (bi#15).
export async function loginCopilotFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	const answer = (
		await interaction.prompt(
			"GitHub Enterprise URL/domain (blank for github.com)",
			"company.ghe.com",
			interaction.signal,
		)
	).trim();
	if (answer) throw new Error("GitHub Enterprise login is not supported yet — leave blank for github.com");
	const dc = flow.deviceCode;
	if (!dc) throw new Error(`No device-code config for ${flow.name}`);
	const codeRes = await requestToken(dc.codeUrl, {
		format: "form",
		params: { client_id: flow.clientId as string, scope: "read:user" },
		headers: flow.extraHeaders,
		signal: interaction.signal,
	});
	if (!codeRes.ok) throw new Error(`${flow.name} device authorization failed (status ${codeRes.status}): ${codeRes.bodyText}`);
	const device = JSON.parse(codeRes.bodyText) as {
		device_code?: unknown;
		user_code?: unknown;
		verification_uri?: unknown;
		interval?: unknown;
		expires_in?: unknown;
	};
	if (
		typeof device.device_code !== "string" ||
		typeof device.user_code !== "string" ||
		typeof device.verification_uri !== "string" ||
		typeof device.expires_in !== "number"
	) {
		throw new Error(`Invalid ${flow.name} device code response`);
	}
	checkVerificationUri(device.verification_uri, ["https", "http"], flow.name);
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: typeof device.interval === "number" ? device.interval : undefined,
		expiresInSeconds: device.expires_in,
	});
	const githubToken = await pollDeviceCodeFlow<string>({
		intervalSeconds: typeof device.interval === "number" ? device.interval : undefined,
		expiresInSeconds: device.expires_in,
		waitBeforeFirstPoll: true,
		signal: interaction.signal,
		poll: async () => {
			const res = await requestToken(dc.tokenUrl, {
				format: "form",
				params: {
					client_id: flow.clientId as string,
					device_code: device.device_code as string,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				},
				headers: flow.extraHeaders,
				signal: interaction.signal,
			});
			let raw: { access_token?: unknown; error?: unknown; error_description?: unknown; interval?: unknown } = {};
			try {
				raw = JSON.parse(res.bodyText) as typeof raw;
			} catch {
				return { status: "failed", message: `Invalid ${flow.name} device token response` };
			}
			if (typeof raw.access_token === "string") return { status: "complete", value: raw.access_token };
			if (raw.error === "authorization_pending") return { status: "pending" };
			if (raw.error === "slow_down") {
				return {
					status: "slow_down",
					intervalSeconds: typeof raw.interval === "number" ? raw.interval : undefined,
				};
			}
			const desc = typeof raw.error_description === "string" ? `: ${raw.error_description}` : "";
			return { status: "failed", message: `Device flow failed: ${String(raw.error ?? res.status)}${desc}` };
		},
	});
	return exchangeCopilotToken(flow, githubToken, interaction.signal);
}

async function exchangeCopilotToken(flow: OAuthFlow, githubToken: string, signal?: AbortSignal): Promise<Credential> {
	const res = await fetch(flow.tokenUrl, {
		headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}`, ...flow.extraHeaders },
		signal,
	});
	if (!res.ok) throw new Error(`${flow.name} token exchange failed (${res.status}): ${await res.text()}`);
	const data = (await res.json()) as { token?: unknown; expires_at?: unknown };
	if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
		throw new Error(`Invalid ${flow.name} token response fields`);
	}
	return new Credential({
		provider_id: flow.id,
		type: "oauth",
		key: null,
		refresh: githubToken,
		access: data.token,
		expires: data.expires_at * 1000 - 300000,
		account_id: null,
	});
}

export async function refreshCopilotFlow(flow: OAuthFlow, current: Credential, signal?: AbortSignal): Promise<Credential> {
	if (!current.refresh) throw new Error(`${flow.name} token refresh needs the stored GitHub token`);
	return exchangeCopilotToken(flow, current.refresh, signal);
}

// Radius browser login (pi radius.ts loginWithBrowser): gateway
// discovery, then PKCE against the discovered endpoint. Device-code
// login stays deferred like codex's (browser-first for bi#24).
export async function loginRadiusFlow(flow: OAuthFlow, interaction: OAuthInteraction): Promise<Credential> {
	const gateway = flow.gateway;
	if (!gateway) throw new Error("Radius OAuth needs RADIUS_GATEWAY set to the gateway origin");
	const discoveryRes = await fetch(new URL("/v1/oauth", gateway), {
		headers: { accept: "application/json" },
		signal: interaction.signal,
	});
	if (!discoveryRes.ok) {
		throw new Error(`Could not load Radius OAuth config from ${gateway}: ${discoveryRes.status} ${await discoveryRes.text()}`);
	}
	const discovery = (await discoveryRes.json()) as { authorizationEndpoint?: unknown };
	if (typeof discovery.authorizationEndpoint !== "string") {
		throw new Error(`Invalid Radius OAuth config from ${gateway}`);
	}
	if (!flow.clientId) throw new Error(`PKCE login needs a client_id for ${flow.name}`);
	const { verifier, challenge } = generatePKCE();
	// Pi uses crypto.randomUUID; an opaque hex nonce is equivalent here.
	const state = randomBytes(16).toString("hex");
	const redirectUri = `http://127.0.0.1:${flow.callbackPort ?? 1456}${flow.callbackPath ?? "/oauth/callback"}`;
	const url = new URL(discovery.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: flow.clientId,
		redirect_uri: redirectUri,
		scope: flow.scopes,
		code_challenge: challenge,
		code_challenge_method: "S256",
		handoff: "url",
		state,
		...flow.extraAuthorizeParams,
	}).toString();
	const server = await startLoopbackServer({
		port: flow.callbackPort ?? 1456,
		path: flow.callbackPath ?? "/oauth/callback",
		expectedState: state,
		providerName: flow.name,
	});
	try {
		interaction.notify({ type: "progress", message: `Listening for OAuth callback on ${redirectUri}` });
		interaction.notify({ type: "auth_url", url: url.toString(), instructions: "Continue in your browser." });
		const { code } = await raceManualCode(server, interaction, state);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const body = await tokenRequest(
			flow,
			{
				grant_type: "authorization_code",
				client_id: flow.clientId,
				redirect_uri: redirectUri,
				code,
				code_verifier: verifier,
			},
			interaction.signal,
		);
		return credentialFromTokenResponse(flow, flow.tokenUrl, body);
	} finally {
		await server.close();
	}
}
