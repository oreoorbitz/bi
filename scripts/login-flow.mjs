// bi/scripts/login-flow.mjs — interactive /login drill (bi#195)
//
// Bare `bi login` (CLI) and bare `/login` (REPL) open the interactive
// path: provider picker (pickList modal, BAML-shaped annotations from
// login_picker_annotation) → branch on the pick — api-key providers get
// the masked SecretInput modal (askSecret, prompt.ts), oauth providers
// the bi#94 device-flow dialog. Esc at any step cancels with nothing
// stored; success prints the arg path's exact confirmation line.
//
// Pty half (needs python3+pty; SKIP otherwise, exit 0) — transport is
// e2e-pty-spawn.py (answers kitty query bursts itself, like modal-chain):
//   lf-cli-picker     picker opens with BAML-shaped api-key/oauth rows
//   lf-cli-key        pick groq → type key → "Stored api_key for groq"
//   lf-key-hidden     the typed key NEVER appears in the pty byte stream
//                     (paint-chain-junk family pin: raw output scan)
//   lf-store          the key round-trips into the REAL credential store
//                     (~/.bi/auth.json on the scratch HOME/BI_AGENT_DIR)
//   lf-esc-picker     Esc at the picker cancels: cancelled line, exit 0
//   lf-esc-secret     Esc at the key input cancels, nothing stored
//   lf-esc-store      both Esc runs left no auth.json behind
//   lf-repl           REPL chain trust→pick→/login→picker→key→stored
//                     →/quit — the modal chain survives two more modals
//   lf-repl-hidden    the key never appears in the REPL byte stream
//   lf-repl-store     REPL login round-trips the real store too
// Pipe half (no pty):
//   lf-pipe-bare      bare `bi login` on a pipe refuses LOUD, exit 1
//   lf-pipe-arg       arg path byte-identical: unknown-provider error
//                     and readSecret's non-TTY refusal unchanged
//
// Red-check records (bi#57), executed 2026-09-08 (kimi-b195):
//   1. key-never-echoed pin.
//      Hunk: SecretInput.render mask in bi/src/prompt.ts bypassed
//            (bullet swap replaced with a no-op — render paints the
//            real buffer).
//      Expected: lf-key-hidden + lf-repl-hidden FAIL — the typed key
//            is painted into the pty byte stream.
//      Observed (bypassed): `FAIL  lf-key-hidden typed key never in
//            byte stream — key found at 6220` and `FAIL  lf-repl-hidden
//            REPL: typed key never in byte stream — key found at
//            29629`; lf-cli-key/lf-store/lf-repl/lf-repl-store stayed
//            ok (login still works — the failure is the echo, not the
//            flow). Restored → green.
//   2. Esc-cancel-stores-nothing.
//      Hunk: the `key === null` half of the cancel guard in
//            runInteractiveLogin (bi/src/auth_cli.ts) removed, so Esc's
//            null falls into storeApiKey.
//      Expected: lf-esc-secret FAIL — no "Login cancelled" line, exit
//            non-zero (ValidateCredential refuses the null key).
//      Observed (bypassed): `FAIL  lf-esc-secret Esc at key input
//            cancels — code=1 cancelled=false`; lf-esc-picker and
//            lf-esc-store stayed ok (ValidateCredential still refused
//            the null key, so the store survived — the broken contract
//            is the cancel path). Restored → green.
//   3. non-TTY refusal.
//      Hunk: the promptAvailable() guard in runInteractiveLogin
//            disabled.
//      Expected: lf-pipe-bare FAIL — the named refusal is gone (the
//            bare pickList falls through to runModal's generic
//            "prompt modal: no TTY" instead).
//      Observed (bypassed): `FAIL  lf-pipe-bare bare login on pipe
//            refuses loud — code=1 err=prompt modal: no TTY` (exit
//            code still 1, contract message gone). Restored → green.
//   4. REPL readline echo across the login modals (the bug this
//      drill caught on its first run — lf-repl-hidden failed at
//      29607 BEFORE the fix existed).
//      Hunk: `if (raw) raw.suspend();` removed from the /login
//            handler in bi/src/cli.ts.
//      Expected: lf-repl-hidden FAIL — askWithEditor's finally has
//            already rebuilt the readline interface when handleSlash
//            runs, and the live readline echoes every typed byte
//            (filter text AND the key) to stdout.
//      Observed (bypassed): `FAIL  lf-repl-hidden REPL: typed key
//            never in byte stream — key found at 29607`;
//            lf-repl/lf-repl-store stayed ok and lf-key-hidden (CLI,
//            no readline) stayed ok — the leak is the REPL readline,
//            not the mask. Restored → green.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const KEY = "gsk-bi195-drill-secret-7f3a9c";

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// Scratch HOME (+ BI_AGENT_DIR): setup_done skips first-run setup; the
// credential store lands at $HOME/.bi/auth.json — the real store, never
// the developer's.
function makeSandbox({ session = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), "bi-lf-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	if (session) {
		// No trust.json → trust modal fires; one header-only session →
		// resume picker fires (modal-chain sandbox shape).
		writeFileSync(
			join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
			JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
		);
	}
	return home;
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

// Timed-beat pty run over the e2e transport; resolves { out, code, home }.
function runPty(argv, stdinBeats, { timeoutS = 30, session = false } = {}) {
	return new Promise((resolve) => {
		const home = makeSandbox({ session });
		const env = { ...process.env, HOME: home, BI_AGENT_DIR: join(home, ".bi"), TERM: "xterm-kitty" };
		delete env.BI_TUI_DEBUG;
		const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "0", String(timeoutS), "node", CLI, ...argv], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => { out += d.toString("utf8"); });
		for (const [atMs, bytes] of stdinBeats) {
			setTimeout(() => {
				try { child.stdin.write(bytes); } catch {}
			}, atMs);
		}
		child.on("close", (code) => resolve({ out, code, home }));
	});
}

function storedKey(home) {
	const f = join(home, ".bi", "auth.json");
	if (!existsSync(f)) return null;
	try {
		const data = JSON.parse(readFileSync(f, "utf8"));
		return data?.groq?.key ?? null;
	} catch {
		return null;
	}
}

if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	// --- Scenario 1: CLI happy path — pick groq, type key, confirm. ---
	const happy = await runPty(["login"], [
		[4000, "groq"],
		[5500, "\r"],
		[8000, KEY],
		[9500, "\r"],
	]);
	const ansi = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][AB0]|\x1b[=>]|\x1b\][^\x07]*\x07/g;
	const clean = happy.out.replace(ansi, "");
	check("lf-cli-picker picker opens with BAML-shaped rows", clean.includes("Log in — pick a provider") && clean.includes("api-key ·") && clean.includes("oauth ·"), `code=${happy.code}`);
	check("lf-cli-key pick → key → confirm line (arg path's exact text)", clean.includes("Stored api_key for groq in ~/.bi/auth.json.") && happy.code === 0, `code=${happy.code}`);
	check("lf-key-hidden typed key never in byte stream", !happy.out.includes(KEY), happy.out.includes(KEY) ? `key found at ${happy.out.indexOf(KEY)}` : `scanned ${happy.out.length} bytes`);
	check("lf-store key round-trips the real credential store", storedKey(happy.home) === KEY, `stored=${JSON.stringify(storedKey(happy.home))}`);

	// --- Scenario 2: Esc at the picker — nothing stored. ---
	const escPicker = await runPty(["login"], [[4000, "\x1b"]], { timeoutS: 20 });
	const escPickerClean = escPicker.out.replace(ansi, "");
	check("lf-esc-picker Esc at picker cancels", escPickerClean.includes("Login cancelled — nothing stored.") && escPicker.code === 0, `code=${escPicker.code}`);

	// --- Scenario 3: Esc at the key input — nothing stored. ---
	const escSecret = await runPty(["login"], [
		[4000, "groq"],
		[5500, "\r"],
		[8000, "\x1b"],
	], { timeoutS: 20 });
	const escSecretClean = escSecret.out.replace(ansi, "");
	check("lf-esc-secret Esc at key input cancels", escSecretClean.includes("Login cancelled — nothing stored.") && escSecret.code === 0, `code=${escSecret.code} cancelled=${escSecretClean.includes("Login cancelled — nothing stored.")}`);
	check("lf-esc-store Esc runs stored nothing", storedKey(escPicker.home) === null && storedKey(escSecret.home) === null, `picker=${JSON.stringify(storedKey(escPicker.home))} secret=${JSON.stringify(storedKey(escSecret.home))}`);

	// --- Scenario 4: REPL /login through the modal chain. ---
	const repl = await runPty([], [
		[4000, "\r"], // trust accept
		[10000, "1\r"], // session pick
		[16000, "/login\r"], // bare /login opens the picker
		[21000, "groq"],
		[22500, "\r"],
		[25000, KEY],
		[26500, "\r"],
		[32000, "/quit\r"],
		[37000, "/quit\r"],
	], { timeoutS: 45, session: true });
	const replClean = repl.out.replace(ansi, "");
	check("lf-repl REPL /login pick → key → stored, chain survives", replClean.includes("Stored api_key for groq in ~/.bi/auth.json.") && replClean.includes("session kept") && repl.code === 0, `code=${repl.code}`);
	check("lf-repl-hidden REPL: typed key never in byte stream", !repl.out.includes(KEY), repl.out.includes(KEY) ? `key found at ${repl.out.indexOf(KEY)}` : `scanned ${repl.out.length} bytes`);
	check("lf-repl-store REPL login round-trips the real store", storedKey(repl.home) === KEY, `stored=${JSON.stringify(storedKey(repl.home))}`);
}

// --- Pipe half: non-TTY refusal + arg path byte-identical (no pty). ---
{
	const home = makeSandbox();
	const env = { ...process.env, HOME: home, BI_AGENT_DIR: join(home, ".bi") };
	const bare = spawnSync("node", [CLI, "login"], { env, encoding: "utf8", input: "" });
	check(
		"lf-pipe-bare bare login on pipe refuses loud",
		bare.status === 1 && (bare.stderr ?? "").includes("bi login needs a terminal") && (bare.stderr ?? "").includes("refusing non-TTY stdin"),
		`code=${bare.status} err=${(bare.stderr ?? "").trim().slice(0, 80)}`,
	);
	const unknown = spawnSync("node", [CLI, "login", "nosuchprovider"], { env, encoding: "utf8", input: "" });
	check(
		"lf-pipe-arg arg path byte-identical (unknown provider + readSecret refusal)",
		unknown.status === 1 && (unknown.stderr ?? "").includes("Unknown provider: nosuchprovider — bi list-providers lists known ids"),
		`code=${unknown.status} err=${(unknown.stderr ?? "").trim().slice(0, 80)}`,
	);
	const argKey = spawnSync("node", [CLI, "login", "groq"], { env, encoding: "utf8", input: "" });
	check(
		"lf-pipe-arg-key arg path readSecret refusal unchanged",
		argKey.status === 1 && (argKey.stderr ?? "").includes("bi login needs a terminal to read the key — refusing non-TTY stdin"),
		`code=${argKey.status} err=${(argKey.stderr ?? "").trim().slice(0, 80)}`,
	);
}

if (failures > 0) {
	console.error(`login-flow drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("login-flow drill: green");
