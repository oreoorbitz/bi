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
import { listProviders, providerExists } from "./provider.js";

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
	if (!(await providerExists(provider))) {
		throw new AuthCliError(`Unknown provider: ${provider} — bi list-providers lists known ids`);
	}
	if (args.includes("--oauth")) {
		throw new AuthCliError(`OAuth login is not supported yet (bi#22) — run \`bi login ${provider}\` to store an API key`);
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
