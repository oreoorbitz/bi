// bi login/logout/status commands (bi#20) — login orchestration is
// app-owned in pi, so this module is host through and through. BAML owns
// the policy predicates (SupportsOAuth, ValidateCredential,
// CredentialStatusLine) and the picker-row annotations
// (login_picker_annotation, bi#195); this file owns TTY prompting, file
// effects, and exit messaging. Arg-path secrets are read from /dev/tty
// with echo disabled — never from piped stdin, never echoed, never
// logged; the interactive path (bi#195) reads them through the masked
// askSecret modal (prompt.ts), same guarantees.

import { closeSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
	Credential,
	CredentialStatusLine_async,
	LoginPickerRow,
	ProviderAuthEnv_async,
	SupportsOAuth_async,
	ValidateCredential_async,
	login_picker_annotation_async,
} from "../baml_sdk/index.js";
import { listCredentials, modifyCredential, readCredential } from "./auth.js";
import { runLoginDialog } from "./login_dialog.js";
import { getOAuthFlow, resolveFlowLogin, type OAuthInteraction } from "./oauth.js";
import { listProviders, providerExists } from "./provider.js";
import { createInterface } from "node:readline";
import { promptAvailable, askText, askSecret, pickList, type ScreenRow } from "./prompt.js";
import { releaseReplTui, retainReplTui } from "./tui.js";

export class AuthCliError extends Error {}

// Prompt on stderr, read one cooked line from /dev/tty with echo off
// (icanon stays on, so kernel line editing works). Returns the trimmed
// line, "" for an empty line, null on EOF.
export function readSecret(prompt: string): string | null {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r");
	} catch {
		throw new AuthCliError("bi login needs a terminal to read the key — refusing non-TTY stdin (keys never echo, never touch history)");
	}
	try {
		process.stderr.write(prompt);
		const off = spawnSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] });
		if (off.status !== 0) throw new AuthCliError("cannot disable terminal echo — refusing to read the key visibly");
		const chunks: Buffer[] = [];
		const buf = Buffer.alloc(1);
		for (;;) {
			if (chunks.length > 8192) throw new AuthCliError("key too long — aborting");
			const n = readSync(fd, buf, 0, 1, null);
			if (n === 0) return null;
			if (buf[0] === 0x0a) break;
			if (buf[0] !== 0x0d) chunks.push(Buffer.from([buf[0]]));
		}
		return Buffer.concat(chunks).toString("utf8").trim();
	} finally {
		spawnSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] });
		process.stderr.write("\n");
		closeSync(fd);
	}
}

// Validate + store + confirm one API key. Shared by the arg path and the
// interactive picker (bi#195) so both print the exact same lines.
async function storeApiKey(provider: string, key: string): Promise<void> {
	const cred = new Credential({
		provider_id: provider,
		type: "api_key",
		key,
		refresh: null,
		access: null,
		expires: null,
		account_id: null,
	});
	if (!(await ValidateCredential_async(cred))) {
		throw new AuthCliError(`Refusing to store invalid credential for ${provider}`);
	}
	await modifyCredential(provider, () => cred);
	console.log(`Stored api_key for ${provider} in ~/.bi/auth.json.`);
	const v = await ProviderAuthEnv_async(provider);
	if (v && process.env[v]) console.log(`(${v} is also set — the stored key wins per bi#19.)`);
	if (await SupportsOAuth_async(provider)) {
		console.log(`(Note: ${provider} also supports OAuth, coming in bi#22+ — API key stored for now.)`);
	}
}

// bi#195: bare `/login` / bare `bi login` — the interactive path. Pick a
// provider from the catalog (rows annotated api-key vs oauth by
// getOAuthFlow registration, already-authenticated rows marked with the
// /oauth staleness signal), then branch: api-key picks get a hidden key
// input in the same modal envelope (askSecret — never echoed, never in
// history), oauth picks hand off to the bi#94 device-flow dialog
// unchanged. Esc at any step cancels with nothing stored; success prints
// the same confirmation lines the arg path prints. Pipes never open the
// picker — same loud refusal readSecret enforces.
export async function runInteractiveLogin(): Promise<void> {
	if (!promptAvailable()) {
		throw new AuthCliError("bi login needs a terminal for the interactive picker — refusing non-TTY stdin (keys never echo, never touch history)");
	}
	const providers = await listProviders();
	const stored = await listCredentials();
	const now = Date.now();
	const rows: ScreenRow[] = [];
	for (const p of providers) {
		const env = await ProviderAuthEnv_async(p.id);
		const s = stored.find((c) => c.provider_id === p.id);
		const source = s ? "stored" : env && process.env[env] ? "env" : "none";
		rows.push({
			label: p.id,
			description: await login_picker_annotation_async(
				new LoginPickerRow({
					provider_id: p.id,
					kind: getOAuthFlow(p.id) ? "oauth" : "api-key",
					source,
					cred_type: s?.type ?? null,
					auth_env: env,
					expires: s?.expires ?? null,
				}),
				now,
			),
		});
	}
	const pick = await pickList("Log in — pick a provider", rows);
	if (pick === null) {
		console.log("Login cancelled — nothing stored.");
		return;
	}
	const provider = providers[pick]!.id;
	if (getOAuthFlow(provider)) {
		try {
			const cred = await runLoginDialog(provider);
			await modifyCredential(provider, () => cred);
			console.log(`Stored oauth credential for ${provider} in ~/.bi/auth.json.`);
		} catch (e) {
			// Esc/expiry inside the dialog already printed its cancelled
			// line — swallow that one path, propagate real failures.
			if (e instanceof Error && e.message === "Login cancelled") return;
			throw e;
		}
		return;
	}
	const key = await askSecret(`API key for ${provider} (input hidden, Esc cancels)`);
	if (key === null || key.trim() === "") {
		console.log("Login cancelled — nothing stored.");
		return;
	}
	await storeApiKey(provider, key.trim());
}

export async function runLogin(args: string[]): Promise<void> {
	const provider = args[1];
	if (!provider) {
		await runInteractiveLogin();
		return;
	}
	if (args.includes("--oauth")) {
		// bi#23: flow ids without a turn backend yet (openai-codex lands
		// in bi#15) can still log in — resolution activates with the
		// backend. API-key login stays catalog-bound below.
		if (!(await providerExists(provider)) && !getOAuthFlow(provider)) {
			const hint = provider === "radius" ? " (Radius needs RADIUS_GATEWAY set to the gateway origin)" : "";
			throw new AuthCliError(`Unknown provider: ${provider}${hint} — bi list-providers lists known ids`);
		}
		await runOAuthLogin(provider);
		return;
	}
	if (!(await providerExists(provider))) {
		throw new AuthCliError(`Unknown provider: ${provider} — bi list-providers lists known ids`);
	}
	const key = readSecret(`API key for ${provider} (input hidden): `);
	if (!key) throw new AuthCliError("No key entered — nothing stored");
	await storeApiKey(provider, key);
}

// bi#22: PKCE login against the provider's registered OAuth flow. The
// authorize URL prints for the browser; the code/redirect URL is read
// visibly (it is single-use, not a stored secret).
export async function runOAuthLogin(provider: string): Promise<void> {
	const flow = getOAuthFlow(provider);
	if (!flow) {
		throw new AuthCliError(
			`No OAuth flow registered for ${provider} yet (bi#23/24) — run \`bi login ${provider}\` to store an API key`,
		);
	}
	const ctl = new AbortController();
	const interaction: OAuthInteraction = {
		signal: ctl.signal,
		notify: (n) => {
			if (n.type === "auth_url") {
				console.log(`\nComplete login in your browser:\n${n.url}\n${n.instructions ?? ""}`);
			} else if (n.type === "device_code") {
				console.log(`\nEnter this code at ${n.verificationUri}:\n  ${n.userCode}\n`);
			} else if (n.type === "progress") {
				console.log(n.message);
			}
		},
		prompt: (message, _placeholder, signal) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Login cancelled"));
					return;
				}
				// Slice 6: TTY gets the pi-tui text modal; Esc cancels
				// the login (same rejection as abort). Mid-modal abort
				// does not close the widget — Esc is the cancel path.
				// Pipes keep the line reader byte-identical.
				if (promptAvailable()) {
					askText(message).then((value) => {
						if (value === null) reject(new Error("Login cancelled"));
						else resolve(value.trim());
					}, reject);
					return;
				}
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				const onAbort = () => {
					rl.close();
					reject(new Error("Login cancelled"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				rl.question(`${message} `, (answer) => {
					signal?.removeEventListener("abort", onAbort);
					rl.close();
					resolve(answer.trim());
				});
			}),
	};
	// bi#162: one lease for the whole login — repeated code/URL
	// prompts share a single negotiation instead of one per modal.
	retainReplTui();
	let cred: Credential;
	try {
		cred = await resolveFlowLogin(flow)(flow, interaction);
	} finally {
		await releaseReplTui();
	}
	await modifyCredential(provider, () => cred);
	console.log(`Stored oauth credential for ${provider} in ~/.bi/auth.json.`);
}

export async function runLogout(args: string[]): Promise<void> {
	const provider = args[1];
	if (!provider) throw new AuthCliError("bi logout requires <provider>");
	if (!(await providerExists(provider))) {
		throw new AuthCliError(`Unknown provider: ${provider} — bi list-providers lists known ids`);
	}
	const cur = await readCredential(provider);
	if (!cur) {
		console.log(`No stored credential for ${provider} — nothing to do.`);
		return;
	}
	await modifyCredential(provider, () => null);
	console.log(`Removed stored ${cur.type} credential for ${provider}.`);
}

export async function runAuthStatus(): Promise<void> {
	const list = await listCredentials();
	if (!list.length) {
		console.log("No stored credentials — `bi login <provider>` to add one.");
		return;
	}
	const sorted = [...list].sort((a, b) => (a.provider_id < b.provider_id ? -1 : 1));
	for (const info of sorted) {
		const full = await readCredential(info.provider_id);
		const hasSecret = !!full && !!(full.key ?? full.access);
		console.log(await CredentialStatusLine_async(info, hasSecret));
	}
}
