// bi/scripts/model-auth.mjs — missing-auth warning drill (bi#203).
//
// /model switches land first, then warn LOUD naming the concrete fix
// (exact env var or /login) when the new provider has no auth
// configured; the resolved default gets the same one-line check at
// startup (startup stays permissive per bi#121 — warn-first per bi#55).
// BI_SCREEN=0 keeps the run modal-free; fixture providers are real
// catalog ids (xai/grok-4.6) with scrubbed env + an isolated store.
//
//   ma-switch-warn    unauthed switch: `backend now` lands AND the
//                     warning names xai + XAI_API_KEY; settings persist
//   ma-switch-silent  XAI_API_KEY=dummy: switch lands, no xai warning
//   ma-startup-warn   stored xai default, no keys: boot warns once
//                     naming XAI_API_KEY, REPL still runs (exit 0)
//
// Red-check record (bi#57), executed <date>:
//   hunk: cli.ts applyModelRef — drop the warnIfProviderUnauthed call.
//   expected: ma-switch-warn FAIL (no xai warning); ma-switch-silent
//     stays green (silence proves nothing alone).
//   observed: <observed>
//   restore: hunk restored → green.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

// Every canonical Provider.auth_env (provider.baml) — scrubbed so the
// ambient shell never authenticates a fixture arm by accident.
const AUTH_VARS = [
	"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY",
	"TOGETHER_API_KEY", "CEREBRAS_API_KEY", "MOONSHOT_API_KEY", "NVIDIA_API_KEY", "ZAI_API_KEY",
	"META_API_KEY", "HF_TOKEN", "BASETEN_API_KEY", "MISTRAL_API_KEY", "FIREWORKS_API_KEY",
	"XAI_API_KEY", "MINIMAX_API_KEY", "KIMI_API_KEY", "OPENROUTER_API_KEY", "QWEN_TOKEN_PLAN_API_KEY",
	"AZURE_OPENAI_API_KEY", "CLOUDFLARE_API_KEY", "AI_GATEWAY_API_KEY",
	"COPILOT_GITHUB_TOKEN", "OPENCODE_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "ANT_LING_API_KEY",
	"MINIMAX_CN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "ZAI_CODING_CN_API_KEY",
];

function seedHome(storedDefault = null) {
	const home = mkdtempSync(join(tmpdir(), "bi-ma-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	const settings = { setup_done: true };
	if (storedDefault) {
		settings.default_provider = storedDefault.provider;
		settings.default_model = storedDefault.model;
	}
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify(settings) + "\n");
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [process.cwd()]: "allow" }) + "\n");
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	return home;
}

function scrubbedEnv(home, extra = {}) {
	const env = { ...process.env, HOME: home, TERM: "xterm-kitty", BI_SCREEN: "0", BI_AUTH_FILE: join(home, ".bi", "auth.json"), ...extra };
	for (const v of AUTH_VARS) delete env[v];
	delete env.BI_AUTH_FILE_ORIG;
	return env;
}

function runBoot(home, beats, env) {
	const rawPath = join(tmpdir(), `bi-ma-raw-${process.pid}-${Math.floor(Math.random() * 1e6)}.log`);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), "40", "160", home, CLI], {
		env: { ...env, PC_TIMEOUT: "50", PC_BEATS: beats, PROBE_RAW: rawPath },
		encoding: "utf8",
		timeout: 120000,
	});
	let raw = "";
	try {
		raw = readFileSync(rawPath, "utf8");
	} catch {}
	return { run, raw };
}

if (hasPty) {
	// Arm 1: unauthed switch warns naming provider + env var; lands.
	{
		const home = seedHome();
		const { run, raw } = runBoot(home, "6:/model xai/grok-4.6\\r,20:/quit\\r,30:/quit\\r", scrubbedEnv(home));
		check("ma-switch-warn switch lands", raw.includes("backend now xai/grok-4.6 (saved)"), "no backend-now line");
		check(
			"ma-switch-warn warning names provider + fix",
			raw.includes("no auth configured for xai") && raw.includes("XAI_API_KEY"),
			"no loud xai warning",
		);
		let persisted = {};
		try {
			persisted = JSON.parse(readFileSync(join(home, ".bi", "settings.json"), "utf8"));
		} catch {}
		check("ma-switch-warn switch persists", persisted.default_model === "grok-4.6" && persisted.default_provider === "xai", JSON.stringify(persisted));
		check("ma-switch-warn clean exit", (run.stdout ?? "").includes("code=0"), `status=${run.status}`);
	}
	// Arm 2: env key present — silent.
	{
		const home = seedHome();
		const { raw } = runBoot(
			home,
			"6:/model xai/grok-4.6\\r,20:/quit\\r,30:/quit\\r",
			{ ...scrubbedEnv(home), XAI_API_KEY: "dummy" },
		);
		check("ma-switch-silent switch lands", raw.includes("backend now xai/grok-4.6 (saved)"), "no backend-now line");
		check("ma-switch-silent no xai warning", !raw.includes("no auth configured for xai"), "spurious xai warning");
	}
	// Arm 3: stored unauthed default warns once at startup, REPL runs.
	{
		const home = seedHome({ provider: "xai", model: "grok-4.6" });
		const { run, raw } = runBoot(home, "8:/quit\\r,20:/quit\\r", scrubbedEnv(home));
		check(
			"ma-startup-warn one-line named warning",
			raw.includes("no auth configured for xai") && raw.includes("XAI_API_KEY"),
			"no startup warning",
		);
		check("ma-startup-warn REPL still runs", (run.stdout ?? "").includes("code=0"), `status=${run.status}`);
	}
} else {
	console.log("SKIP  pty half (no python3+pty on this host)");
}

if (failures > 0) {
	console.error(`model-auth drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("model-auth drill: green");
