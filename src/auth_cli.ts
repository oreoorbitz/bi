// bi login/logout/status commands (bi#20) — login orchestration is
// app-owned in pi, so this module is host through and through. BAML owns
// the policy predicates (SupportsOAuth, ValidateCredential,
// CredentialStatusLine); this file owns TTY prompting, file effects, and
// exit messaging. Secrets are read from /dev/tty with echo disabled —
// never from piped stdin, never echoed, never logged.

import { closeSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
	Credential,
	CredentialStatusLine_async,
	ProviderAuthEnv_async,
	SupportsOAuth_async,
	ValidateCredential_async,
} from "../baml_sdk/index.js";
import { listCredentials, modifyCredential, readCredential } from "./auth.js";
import { getOAuthFlow, loginPKCEFlow, type OAuthInteraction } from "./oauth.js";
import { listProviders, providerExists } from "./provider.js";
import { createInterface } from "node:readline";

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

export async function runLogin(args: string[]): Promise<void> {
	const provider = args[1];
	if (!provider) {
		console.log("usage: bi login <provider> [--oauth]");
		for (const p of await listProviders()) console.log(`  ${p.id}`);
		return;
	}
	if (args.includes("--oauth")) {
		// bi#23: flow ids without a turn backend yet (openai-codex lands
		// in bi#15) can still log in — resolution activates with the
		// backend. API-key login stays catalog-bound below.
		if (!(await providerExists(provider)) && !getOAuthFlow(provider)) {
			throw new AuthCliError(`Unknown provider: ${provider} — bi list-providers lists known ids`);
		}
		await runOAuthLogin(provider);
		return;
	}
	if (!(await providerExists(provider))) {
		throw new AuthCliError(`Unknown provider: ${provider} — bi list-providers lists known ids`);
	}
	const key = readSecret(`API key for ${provider} (input hidden): `);
	if (!key) throw new AuthCliError("No key entered — nothing stored");
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
			if (n.url) console.log(`\nComplete login in your browser:\n${n.url}\n${n.instructions ?? ""}`);
			else if (n.message) console.log(n.message);
		},
		prompt: (message, _placeholder, signal) =>
			new Promise((resolve, reject) => {
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				if (signal?.aborted) {
					rl.close();
					reject(new Error("Login cancelled"));
					return;
				}
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
	const cred = await loginPKCEFlow(flow, interaction);
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
