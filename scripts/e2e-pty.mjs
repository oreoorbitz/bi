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
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

// Fresh sandbox HOME per scenario: seeded sessions for the picker,
// nothing real touched (sessions/history/settings all land here).
function makeSandbox() {
	const home = mkdtempSync(join(tmpdir(), "bi-e2e-"));
	const sess = join(home, ".bi", "sessions");
	mkdirSync(sess, { recursive: true });
	// Pre-trust the launching cwd: otherwise the first boot stops at the
	// project-trust modal and scripted keys land in the wrong widget.
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [process.cwd()]: "allow" }) + "\n");
	for (const id of ["aa11bb22", "cc33dd44"]) {
		writeFileSync(
			join(sess, `${id}.jsonl`),
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp", parent_session: null }) + "\n",
		);
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
function runSession({ sends, replyDelayMs = 0, timeoutMs = 30000, extraEnv = {} }) {
	return new Promise((resolve) => {
		const home = makeSandbox();
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
			resolve({ out, code, timedOut: code === 3, stderr, transcript: p });
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
		sends: [
			[1, 1200, "/resume\r"],
			[2, 1200, K_ESC],
			[3, 1200, "/quit\r"],
		],
	});
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} picker opened over seeded sessions`, out.includes("aa11bb22"));
	check(`${tag} Esc keeps the list, next prompt clean`, queryBursts(out) >= 2 && out.includes("session kept"), `bursts=${queryBursts(out)}`);
	assertNoLeak(tag, out);
}

async function sCtrldEof() {
	const tag = "ctrld-eof";
	const { out, code, timedOut } = await runSession({ sends: [[1, 1200, K_CTRLD]] });
	check(`${tag} exits (no timeout)`, !timedOut);
	check(`${tag} EOF keeps session, exit 0`, out.includes("EOF — session kept") && code === 0, `code=${code}`);
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
	"ctrld-eof": sCtrldEof,
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

