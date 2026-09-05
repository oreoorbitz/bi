// bi/scripts/e2e-pty.mjs — committed pty e2e harness (bi#116/bi#117/bi#118).
//
// Boots the real bi (dist/) under a pty with a sandboxed HOME, answers
// kitty/DA queries like a kitty terminal (configurable delay), types
// scripted keys (legacy + kitty press/release events), and asserts
// byte-level transcript properties. No LLM key needed except the live
// smoke, which skips cleanly without one.
//
// Requirements: `python3` (transport: node has no pty API and script(1)
// chokes on libuv socket stdio), `npm run build` first, TERM outside is
// irrelevant (sandbox forces xterm-kitty).
//
// Scenarios and the symptom each pins:
//   editor-kitty-submit  bi#116.2  /nope typed via kitty press+release per
//                                  char resolves byte-exact (chronic-junk
//                                  era: replies were typed instead).
//   late-replies         bi#116.3  200ms-late kitty/DA replies never surface
//                                  (settle envelope; stalls past 450ms are
//                                  known residual, see bi#119).
//   prompt-cancel        bi#117    Esc at the prompt re-prompts with the
//                                  hint; the next prompt proves stdin clean.
//   picker-select        bi#117.1  /model arrows+Enter resolves a backend.
//   picker-cancel        bi#117.2  /resume Esc keeps the list; next prompt
//                                  proves stdin clean.
//   ctrld-eof            bi#117    Ctrl-D on empty exits 0 with EOF kept msg.
//   live-smoke           bi#118.3  gated on BI_E2E_LIVE_KEY, else SKIP.
//
// Every scenario also asserts the global no-leak invariant: the output
// never contains reply bytes (?7u / 64;1;2… / :3u) — the readline-echo
// regression test for the load-time junk reports.
//
// Adding a scenario: write an sName function and register it in ALL.
// sends are [burstGate, offsetMs, bytes] — fired offsetMs after the
// burstGate-th query burst is seen (never race boot/focus); ~1200ms
// offsets cover the settle cap plus SSH-gated drain with margin.
// Run: npm run test:e2e. Live: BI_E2E_LIVE_KEY=<key> npm run test:e2e.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

// --- kitty key encoders (CSI unicode ; mods+1 : event u) ---
const press = (cp) => `\x1b[${cp};1:1u`;
const release = (cp) => `\x1b[${cp};1:3u`;
const typeKitty = (s) => [...s].map((ch) => press(ch.codePointAt(0)) + release(ch.codePointAt(0))).join("");
const K_ENTER = "\x1b[13u";
const K_ESC = "\x1b[27u";
const K_DOWN = "\x1b[B";
const K_CTRLD = "\x04";

// Reply bytes must never appear in bi's OUTPUT (queries are fine:
// `>7u`/`[?u`/`[c` are bi's own writes). Absence of these three is the
// chronic-junk regression invariant (readline echo + widget typing).
const LEAK_RES = [/\?7u/, /64;1;2/, /:3u/];

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// Fresh sandbox HOME per scenario: nothing real touched
// (sessions/history/settings/trust all land here). Sessions seed only
// on request — otherwise the startup picker (bi#100) would hijack
// burst 1 of every scenario.
function makeSandbox(seedSessions = false) {
	const home = mkdtempSync(join(tmpdir(), "bi-e2e-"));
	const sess = join(home, ".bi", "sessions");
	mkdirSync(sess, { recursive: true });
	// Pre-trust the launching cwd: otherwise the first boot stops at the
	// project-trust modal and scripted keys land in the wrong widget.
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [process.cwd()]: "allow" }) + "\n");
	if (seedSessions) {
		for (const id of ["aa11bb22", "cc33dd44"]) {
			writeFileSync(
				join(sess, `${id}.jsonl`),
				JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp", parent_session: null }) + "\n",
			);
		}
	}
	return home;
}

// One bi session under the pty transport (e2e-pty-spawn.py creates the
// pty itself — node has no pty API and script(1) chokes on libuv socket
// stdio). The transport answers every kitty query burst after
// replyDelayMs. Sends are [burstGate, offsetMs, bytes]: fired offsetMs
// after the burstGate-th query burst is SEEN in live output (a modal
// opened), so keys never race boot or an unfocused widget — absolute
// send times flaked under load. A watchdog fires overdue gates (10s
// without the burst) so a missing modal fails loudly, not silently.
// Resolves with the full output and exit code; helper exit 3 counts as
// timeout failure (transcript kept under $TMPDIR for diagnosis).
// home: reuse a previous scenario's sandbox (bi#121 two-boot proof).
// The sandbox is returned on every result; reused homes skip seeding
// (trust + sessions already in place).
function runSession({ sends, replyDelayMs = 0, timeoutMs = 30000, extraEnv = {}, seedSessions = false, home = null }) {
	return new Promise((resolve) => {
		home = home ?? makeSandbox(seedSessions);
		const env = { ...process.env, HOME: home, TERM: "xterm-kitty", ...extraEnv };
		delete env.BI_TUI_DEBUG;
		const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), String(replyDelayMs), String(Math.ceil(timeoutMs / 1000)), "node", CLI], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		const t0 = Date.now();
		const pending = sends.map(([gate, ms, bytes]) => ({ gate, ms, at: 0, bytes, fired: false }));
		const burstsSeen = () => out.split("[?u").length - 1;
		const fire = (s) => {
			s.fired = true;
			try {
				child.stdin.write(s.bytes);
			} catch {}
		};
		const pump = () => {
			const b = burstsSeen();
			for (const s of pending) {
				if (!s.fired && (b >= s.gate || Date.now() - t0 > 12000)) {
					if (!s.at) s.at = Date.now() + s.ms;
					if (Date.now() >= s.at) fire(s);
				}
			}
		};
		child.stdout.on("data", (d) => {
			out += d.toString("utf8");
			pump();
		});
		const watchdog = setInterval(pump, 250);
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (code) => {
			clearInterval(watchdog);
			const p = join(tmpdir(), `bi-e2e-${Date.now()}.log`);
			try {
				writeFileSync(p, out);
			} catch {}
			if (code === 3) console.log(`   (transcript kept at ${p})`);
			resolve({ out, code, timedOut: code === 3, stderr, transcript: p, home });
		});
		child.on("error", (e) => {
			clearInterval(watchdog);
			resolve({ out, code: null, timedOut: true, stderr: String(e) });
		});
	});
}

function assertNoLeak(tag, out) {
	for (const re of LEAK_RES) check(`${tag} no reply bytes leak (${re})`, !re.test(out));
}

const queryBursts = (out) => out.split("[?u").length - 1;

async function sEditorKittySubmit() {
	const tag = "editor-kitty-submit";
	const { out, code, timedOut } = await runSession({
		sends: [
			[1, 1200, typeKitty("/nope123") + K_ENTER],
			[2, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} kitty press+release resolves exact text`, out.includes("unknown slash /nope123"));
	check(`${tag} clean quit`, out.includes("session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sLateReplies() {
	const tag = "late-replies";
	const { out, code, timedOut } = await runSession({
		replyDelayMs: 200,
		sends: [
			[1, 1200, "/help\r"],
			[2, 1500, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} submit resolved under late replies`, out.includes("slash commands:"));
	check(`${tag} clean quit`, out.includes("session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sPromptCancel() {
	const tag = "prompt-cancel";
	const { out, timedOut } = await runSession({
		sends: [
			[1, 1200, K_ESC],
			[2, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} Esc re-prompts with hint`, out.includes("(Ctrl-D or /quit to exit)"));
	check(`${tag} next prompt proves stdin clean`, queryBursts(out) >= 2 && out.includes("session kept"), `bursts=${queryBursts(out)}`);
	assertNoLeak(tag, out);
}

async function sPickerSelect() {
	const tag = "picker-select";
	const { out, timedOut } = await runSession({
		sends: [
			[1, 1200, "/model\r"],
			[2, 1500, K_DOWN + "\r"],
			[3, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} arrows+Enter resolves a backend`, /\[bi\] backend now \S+\/\S+/.test(out));
	check(`${tag} clean quit`, out.includes("session kept"));
	assertNoLeak(tag, out);
}

async function sPickerCancel() {
	const tag = "picker-cancel";
	const { out, timedOut } = await runSession({
		seedSessions: true,
		sends: [
			[1, 1200, K_ESC], // dismiss the startup picker first (fresh mint)
			[2, 1200, "/resume\r"],
			[3, 1200, K_ESC],
			[4, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} picker opened over seeded sessions`, out.includes("aa11bb22"));
	check(`${tag} Esc keeps the list, next prompt clean`, queryBursts(out) >= 3 && out.includes("session kept"), `bursts=${queryBursts(out)}`);
	assertNoLeak(tag, out);
}

async function sStartupPickerSelect() {
	const tag = "startup-picker-select";
	const { out, code, timedOut } = await runSession({
		seedSessions: true,
		sends: [
			[1, 1500, K_DOWN + "\r"], // New-first list: down once adopts the newest seeded session
			[2, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} startup adopts the picked session`, /\[bi\] resumed (aa11bb22|cc33dd44)/.test(out));
	check(`${tag} adopting mints nothing`, !out.includes("new session"));
	check(`${tag} clean quit`, out.includes("session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sStartupPickerNew() {
	const tag = "startup-picker-new";
	const { out, code, timedOut } = await runSession({
		seedSessions: true,
		sends: [
			[1, 1500, K_ESC], // Esc starts new, exactly like before the picker existed
			[2, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} Esc mints fresh`, out.includes("new session"));
	check(`${tag} clean quit`, out.includes("session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sCtrldEof() {
	const tag = "ctrld-eof";
	const { out, code, timedOut } = await runSession({ sends: [[1, 1200, K_CTRLD]] });
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} EOF keeps session, exit 0`, out.includes("EOF — session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sAutocompletePaced() {
	const tag = "autocomplete-paced";
	// bi#115: type /quit at human cadence (40ms) with kitty press+release
	// per key — a slow suggestion round must not splice a stale prefix
	// into the submit (`unknown slash /qu/quit` era). Clean quit proves
	// the submitted line survived byte-exact. Regression net only: with
	// warm BAML rounds this passes with or without the guard (verified
	// by neutering); the unit stale-splice tests in scripts/prompt.mjs
	// are the repro proof (they fail guard-less).
	const chars = [..."/quit"];
	const sends = chars.map((ch, i) => [1, 1200 + i * 40, typeKitty(ch)]);
	sends.push([1, 1200 + chars.length * 40 + 150, K_ENTER]);
	sends.push([2, 1200, "/quit\r"]); // only reached if the paced submit mangled
	const { out, code, timedOut } = await runSession({ sends });
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} paced submit quits clean`, out.includes("session kept") && code === 0, `code=${code}`);
	check(`${tag} no stale-prefix mangle`, !/unknown slash \/q/.test(out));
	assertNoLeak(tag, out);
}

async function sSettingsBackend() {
	const tag = "settings-backend";
	const { out, timedOut } = await runSession({
		sends: [
			[1, 1200, "/settings\r"],
			[2, 1200, "\r"], // Backend section (index 0)
			[3, 1200, "\r"], // keep provider
			[4, 1200, "\r"], // keep model
			[5, 1200, "\r"], // keep thinking
			[6, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} stepped flow commits live + saved`, /\[bi\] backend now \S+ \+ thinking \S+ \(saved\)/.test(out));
	check(`${tag} clean quit`, out.includes("session kept"));
	assertNoLeak(tag, out);
}

async function sSettingsTheme() {
	const tag = "settings-theme";
	const { out, home, timedOut } = await runSession({
		sends: [
			[1, 1200, "/settings\r"],
			[2, 1200, K_DOWN + "\r"], // Theme section (index 1)
			[3, 1200, K_DOWN + "\r"], // next theme
			[4, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	const m = out.match(/\[bi\] theme now (default|light|none)/);
	check(`${tag} theme picked and set`, !!m, m?.[1] ?? "no match");
	if (m) {
		const disk = JSON.parse(readFileSync(join(home, ".bi", "theme.json"), "utf8"));
		check(`${tag} theme persisted to disk`, disk.name === m[1], disk.name);
	}
	check(`${tag} clean quit`, out.includes("session kept"));
	assertNoLeak(tag, out);
}

async function sSettingsEsc() {
	const tag = "settings-esc";
	const { out, home, timedOut } = await runSession({
		sends: [
			[1, 1200, "/settings\r"],
			[2, 1200, K_ESC], // abort: lists, writes nothing
			[3, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} Esc falls back to the list`, out.includes("default_provider") || out.includes("default-model") || /default_\w+/.test(out));
	check(`${tag} abort writes nothing`, !existsSync(join(home, ".bi", "settings.json")));
	check(`${tag} clean quit`, out.includes("session kept"));
	assertNoLeak(tag, out);
}

async function sPersistModel() {
	const tag = "persist-model";
	const first = await runSession({
		sends: [
			[1, 1200, "/model gemini-2.0-flash\r"],
			[2, 1200, "/thinking low\r"],
			[3, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !first.timedOut);
	check(`${tag} switch reports saved`, first.out.includes("(saved)"));
	const saved = JSON.parse(readFileSync(join(first.home, ".bi", "settings.json"), "utf8"));
	check(`${tag} model cached on disk`, saved.default_model === "gemini-2.0-flash", saved.default_model);
	check(`${tag} thinking cached on disk`, saved.default_thinking === "low", saved.default_thinking);
	// Second boot, same HOME: the cached backend resolves with no flags.
	// (Boot 1 minted a session, so burst 1 is the startup picker.)
	const second = await runSession({
		home: first.home,
		sends: [
			[1, 1200, K_ESC],
			[2, 1200, "/session\r"],
			[3, 1200, "/quit\r"],
		],
	});
	check(`${tag} relaunch exits`, !second.timedOut);
	check(`${tag} relaunched backend is the cached model`, second.out.includes("gemini-2.0-flash"));
	check(`${tag} clean quit`, second.out.includes("session kept"));
	assertNoLeak(tag, first.out + second.out);
}

async function sPersistCorrupt() {
	const tag = "persist-corrupt";
	const home = makeSandbox(false);
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ default_provider: "anthropic", default_model: "nope-xyz" }) + "\n");
	const { out, code, timedOut } = await runSession({
		home,
		sends: [[1, 1200, "/quit\r"]],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} corrupt cache falls back with warning`, out.includes("stored settings invalid"));
	check(`${tag} REPL still starts and quits`, out.includes("session kept") && code === 0, `code=${code}`);
	assertNoLeak(tag, out);
}

async function sLiveSmoke() {
	const tag = "live-smoke";
	const key = process.env.BI_E2E_LIVE_KEY;
	if (!key) {
		console.log(`SKIP  ${tag} — set BI_E2E_LIVE_KEY to run the live-LLM smoke`);
		return;
	}
	const home = makeSandbox();
	const args = [CLI, "run", "Reply with exactly: PINEAPPLE", "-p", "--no-session", "--api-key", key];
	const res = await new Promise((resolve) => {
		execFile("node", args, { env: { ...process.env, HOME: home, TERM: "dumb" }, timeout: 120000 }, (err, stdout, stderr) =>
			resolve({ err, stdout: String(stdout), stderr: String(stderr) }),
		);
	});
	check(`${tag} live turn completes`, !res.err, res.err ? String(res.err).slice(0, 120) : "");
	check(`${tag} model echoes the keyword`, res.stdout.includes("PINEAPPLE"), res.stdout.slice(0, 120));
}

const only = process.argv[2];
const ALL = {
	"editor-kitty-submit": sEditorKittySubmit,
	"late-replies": sLateReplies,
	"prompt-cancel": sPromptCancel,
	"picker-select": sPickerSelect,
	"picker-cancel": sPickerCancel,
	"startup-picker-select": sStartupPickerSelect,
	"startup-picker-new": sStartupPickerNew,
	"settings-backend": sSettingsBackend,
	"settings-theme": sSettingsTheme,
	"settings-esc": sSettingsEsc,
	"persist-model": sPersistModel,
	"persist-corrupt": sPersistCorrupt,
	"ctrld-eof": sCtrldEof,
	"autocomplete-paced": sAutocompletePaced,
	"live-smoke": sLiveSmoke,
};
const names = only ? [only] : Object.keys(ALL);
if (only && !ALL[only]) {
	console.error(`unknown scenario ${only} — pick from ${Object.keys(ALL).join(", ")}`);
	process.exit(2);
}
for (const n of names) {
	console.log(`--- ${n} ---`);
	await ALL[n]();
}
console.log(failures === 0 ? "e2e-pty: all green" : `e2e-pty: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

