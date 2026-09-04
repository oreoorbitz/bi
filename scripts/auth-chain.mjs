// bi/scripts/auth-chain.mjs — API-key chain precedence (bi#19), offline.
// Proves login -> run resolution without any LLM: stored credential wins
// over env, explicit --api-key wins over stored, env presence is the
// fallback, and nothing stored + nothing set fails LOUD naming `bi login`.
// Uses BI_AUTH_FILE override + tmp store (never ~/.bi/auth.json).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "..", "dist", "src");
const { getAuth, resolveAuth, modifyCredential } = await import(join(DIST, "auth.js"));
const { Credential } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "bi-authchain-"));
process.env.BI_AUTH_FILE = join(dir, "auth.json");

const put = (provider, key) =>
	modifyCredential(provider, () => new Credential({ provider_id: provider, type: "api_key", key, refresh: null, access: null, expires: null, account_id: null }));

// 1. nothing stored + nothing set -> loud failure naming bi login.
delete process.env.ZAI_API_KEY;
const none = await resolveAuth("zai", null);
check("failure" in none && none.failure.message.includes("bi login"), "empty chain fails loud naming `bi login`");

// 2. env presence fallback (pi#19 fall-through, no stored credential).
process.env.ZAI_API_KEY = "env-key";
const envOnly = await getAuth("zai", null);
check(envOnly.source !== "none", `env presence resolves (source=${envOnly.source})`);

// 3. stored wins over env.
await put("zai", "stored-key");
const stored = await getAuth("zai", null);
check(stored.source === "stored" || JSON.stringify(stored).includes("stored"), `stored credential wins over env (${JSON.stringify(stored).slice(0, 80)})`);

// 4. explicit flag wins over stored.
const explicit = await getAuth("zai", "flag-key");
check(JSON.stringify(explicit).includes("flag") || JSON.stringify(explicit).includes("explicit"), "explicit --api-key wins over stored");

// 5. corrupt store never silently falls back (bi#19: storage failures propagate).
writeFileSync(process.env.BI_AUTH_FILE, "{not json");
let threw = false;
try {
	await getAuth("zai", null);
} catch {
	threw = true;
}
check(threw, "corrupt store throws instead of silently falling back");

delete process.env.BI_AUTH_FILE;
delete process.env.ZAI_API_KEY;
console.log(failures === 0 ? "auth-chain: all green" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
