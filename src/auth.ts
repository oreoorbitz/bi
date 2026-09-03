// bi/src/auth.ts — host side of provider auth (bi#13).
//
// Split: BAML owns WHICH env var (Provider.auth_env via ProviderAuthEnv);
// this file owns READING it. Pre-wire check so a missing key fails fast
// naming the provider's own var, instead of reaching the client (whose
// canonical fallback — e.g. OPENAI_API_KEY for every ChatClient — would
// mislead a groq user). Mirrors pi's envApiKeyAuth precedence minus the
// stored-credential layer: explicit --api-key wins, else env, else a
// classified failure.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import {
	AuthDecision,
	Credential,
	CredentialInfo,
	MissingKeyMessage_async,
	ProviderAuthEnv_async,
	ResolveAuth_async,
	TurnFailure,
	ValidateCredential_async,
} from "../baml_sdk/index.js";

export { AuthDecision, Credential, CredentialInfo } from "../baml_sdk/index.js";

// bi#19: pi resolveProviderAuth precedence over host-observed inputs. A
// stored credential owns the provider: the canonical env var's PRESENCE
// (never its value — env secrets stay late-bound in BAML via
// baml.env.ref) is consulted only when nothing is stored. Storage
// failures propagate; a corrupt store must never silently fall back.
export async function getAuth(provider: string, apiKey?: string | null): Promise<AuthDecision> {
	const stored = await readCredential(provider);
	const valid = stored && (await ValidateCredential_async(stored)) ? stored : null;
	// bi#22 owns expiry-aware refresh: until then, a valid stored
	// credential without a usable secret (hand-written oauth without
	// access) falls through the chain below. No UI can produce that
	// state yet; refresh-or-fail closes it.
	const storedKey = valid ? (valid.key ?? valid.access ?? null) : null;
	const v = await ProviderAuthEnv_async(provider);
	const hasEnv = !!v && !!process.env[v];
	return ResolveAuth_async(provider, apiKey ?? null, storedKey, hasEnv);
}

export async function authFailure(provider: string, auth: AuthDecision): Promise<TurnFailure | null> {
	if (auth.source != "none") return null;
	return new TurnFailure({
		kind: "invalid_argument",
		message: await MissingKeyMessage_async(provider),
		retry_safe: false,
	});
}

export async function missingKeyFailure(provider: string, apiKey?: string | null): Promise<TurnFailure | null> {
	return authFailure(provider, await getAuth(provider, apiKey));
}

// --- Credential store (bi#18) ---
//
// ~/.bi/auth.json, one credential per provider id, file mode 0600.
// Mirrors pi's CredentialStore contract: `read` resolves undefined for
// missing entries and rejects only on storage failure; `modify` is the
// only write path, serialized through a chain so concurrent OAuth
// refreshes (bi#22) cannot double-refresh. `list` exposes metadata only.

const AUTH_DIR = join(homedir(), ".bi");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

// BI_AUTH_FILE overrides the store path (tests, multi-profile use).
function authFile(): string {
	return process.env.BI_AUTH_FILE ?? AUTH_FILE;
}

type StoredFile = Record<string, {
	provider_id: string;
	type: string;
	key: string | null;
	refresh: string | null;
	access: string | null;
	expires: number | null;
}>;

function toStored(c: Credential): StoredFile[string] {
	return {
		provider_id: c.provider_id,
		type: c.type,
		key: c.key,
		refresh: c.refresh,
		access: c.access,
		expires: c.expires,
	};
}

async function loadFile(): Promise<StoredFile> {
	let raw: string;
	try {
		raw = await readFile(authFile(), "utf8");
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		throw e;
	}
	return JSON.parse(raw) as StoredFile;
}

async function saveFile(data: StoredFile): Promise<void> {
	const file = authFile();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
	await chmod(file, 0o600);
}

export async function readCredential(providerId: string): Promise<Credential | undefined> {
	const data = await loadFile();
	const raw = data[providerId];
	if (!raw) return undefined;
	return new Credential(raw);
}

// Metadata only — secret fields are dropped, never listed.
export async function listCredentials(): Promise<CredentialInfo[]> {
	const data = await loadFile();
	return Object.values(data).map(
		(c) => new CredentialInfo({ provider_id: c.provider_id, type: c.type }),
	);
}

let writeChain: Promise<void> = Promise.resolve();

// Serialized write. `fn` sees the current credential; returning a
// Credential stores it, returning null/undefined deletes the entry
// (bi#20 logout). The returned promise settles with this mutation's
// outcome; the chain itself survives failures.
export function modifyCredential(
	providerId: string,
	fn: (current: Credential | undefined) => Promise<Credential | null | undefined> | Credential | null | undefined,
): Promise<void> {
	const run = writeChain.then(async () => {
		const data = await loadFile();
		const cur = data[providerId];
		const next = await fn(cur ? new Credential(cur) : undefined);
		if (next) data[providerId] = toStored(next);
		else delete data[providerId];
		await saveFile(data);
	});
	writeChain = run.catch(() => {});
	return run;
}
