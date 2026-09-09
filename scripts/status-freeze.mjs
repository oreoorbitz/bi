// bi/scripts/status-freeze.mjs — freeze-thinking-while-blocked drill (bi#218).
//
// bi#218: the `thinking · Ns` status kept ticking while the agent waited
// on the user (approval prompt) — the timer billed user wait as model
// work, and the out-of-band stderr writes raced the modal's differential
// renderer. Fix: KindStatus.freeze/unfreeze (status.ts) + hook in
// prompt.ts askApproval (freeze on open, unfreeze on resolve — no
// cli.ts touch). Frozen: interval stopped, tick a no-op, elapsed pinned;
// unfreeze resumes from the frozen elapsed. The waiting row lives
// INSIDE the modal frame (STATUS_WAITING_LINE, plain text so pipes and
// themes never see a byte).
//
//   Headless (no TTY): freeze pins elapsed across a wait; stop bills
//   the frozen value; nested freeze/unfreeze pairs nest; stray
//   unfreeze and null-sink hooks are no-ops; the throw path unfreezes
//   (runModal refuses piped); normal (unfrozen) turns bill wall time.
//   Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   sf-wait     ticking status + 4-choice approval held open 5s wall:
//               waiting row visible, all 4 choice rows visible with
//               exactly one marker, Enter resolves 0, summary elapsed
//               excludes the wait (<4s) while WALL proves the wait
//               happened (>4.5s).
//   sf-pipe     freeze/unfreeze/stop piped: `[bi] ` summary, no escape
//               bytes (the pipe branch is untouched — shape pin).
//
// Red-check records (bi#57), 2026-09-09 (lane-n), all neutered in
// dist/ then restored via rebuild (src untouched throughout):
// (a) freeze pins zero (`frozenElapsed = 0`): `FAIL sf-math —
//     elapsed=0.121s` (lower bound trips: 120ms pre-freeze thinking
//     unbilled), `FAIL sf-stop-frozen — elapsed=0s`, `FAIL sf-nested
//     — elapsed=0.001s`, `FAIL sf-wait — elapsed=0.001s`. This exact
//     bug (pin-after-arm: elapsed() reads the frozen branch) shipped
//     for one iteration and the pty caught it — a 1s think billed
//     0.001s. Fixed by pinning before arming; bounds tightened so the
//     suite guards the pre-freeze bill, not just the wait exclusion.
// (b) askApproval freeze hook neutered: `FAIL sf-wait wait excluded
//     — elapsed=7.200s` (upper bound trips: the 5s soak bills;
//     headless pins stay green — the hook is the pty path's
//     load-bearing hunk). waitline still green (frame row is
//     independent of the clock).
// (c) unfreeze resume shift neutered: `FAIL sf-math — elapsed=0.645s`
//     (400ms wait billed), `FAIL sf-wait — elapsed=7.300s`.
// Companion find: an unmatched unfreeze reset startMs to now (red (b)
// first run billed 0.000s instead of ~7s) — unfreeze is now a strict
// no-op at depth 0, pinned by sf-noop's elapsed bounds.
// Tick-silence evidence (instrumented driver copy, post-fix): 10 tick
// candidates pre-open (0.002s…0.911s), ZERO during the 2s soak, then
// the stop summary — the interval is dead while the modal waits.
//

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { KindStatus, STATUS_WAITING_LINE, freezeActiveStatus, unfreezeActiveStatus, setActiveStatus } = await import(join(DIST, "src", "status.js"));
const sdk = await import(join(DIST, "baml_sdk", "index.js"));
const fns = { formatStatus: sdk.format_status, formatSummary: sdk.format_turn_summary };

// Capture one stop() summary (stderr is piped here, so stop takes the
// `[bi]` branch either way — the seconds parse is branch-agnostic).
async function stoppedSeconds(body) {
	const orig = process.stderr.write.bind(process.stderr);
	let err = "";
	process.stderr.write = (chunk, ...rest) => { err += String(chunk); return true; };
	try {
		await body();
	} finally {
		process.stderr.write = orig;
	}
	// Sub-second bills render `· Nms`, longer ones `· Ns`.
	const m = err.match(/· ([\d.]+)s/) ?? err.match(/· (\d+)ms/);
	if (!m) return NaN;
	return m[0].endsWith("ms") ? Number(m[1]) / 1000 : Number(m[1]);
}

// sf-math: the wait evaporates from the bill.
{
	const st = new KindStatus("thinking", fns);
	st.start();
	await sleep(120);
	st.freeze();
	await sleep(400);
	st.unfreeze();
	await sleep(120);
	const s = await stoppedSeconds(() => st.stop({ failed: false, detail: "", turns: 1, messages: 1 }));
	// ~120ms thinking + ~120ms after, the 400ms wait evaporated. The
	// lower bound is load-bearing: a freeze that pins zero instead of
	// the live elapsed bills ~120ms and fails here.
	check("sf-math wait excluded from elapsed", s > 0.15 && s < 0.45, `elapsed=${s}s`);
}

// sf-stop-frozen: closing while frozen bills the frozen value.
{
	const st = new KindStatus("thinking", fns);
	st.start();
	await sleep(100);
	st.freeze();
	await sleep(300);
	const s = await stoppedSeconds(() => st.stop({ failed: false, detail: "", turns: 1, messages: 1 }));
	check("sf-stop-frozen stop bills frozen elapsed", s > 0.05 && s < 0.3, `elapsed=${s}s`);
}

// sf-nested: inner pair releases without resuming the outer wait.
{
	const st = new KindStatus("thinking", fns);
	st.start();
	await sleep(80);
	st.freeze();
	await sleep(200);
	st.freeze();
	await sleep(200);
	st.unfreeze();
	if (!st.frozen) check("sf-nested inner unfreeze keeps clock frozen", false, "resumed early");
	await sleep(200);
	st.unfreeze();
	const s = await stoppedSeconds(() => st.stop({ failed: false, detail: "", turns: 1, messages: 1 }));
	check("sf-nested nested waits excluded", s > 0.03 && s < 0.3, `elapsed=${s}s`);
}

// sf-noop: stray unfreeze and null-sink hooks never throw, never arm.
{
	const st = new KindStatus("thinking", fns);
	st.start();
	await sleep(100);
	st.unfreeze(); // stray: must neither arm nor shift the clock
	const stillUnfrozen = st.frozen === false;
	const sNoop = await stoppedSeconds(() => st.stop({ failed: false, detail: "", turns: 1, messages: 1 }));
	check("sf-noop stray unfreeze is safe", stillUnfrozen && sNoop > 0.05 && sNoop < 0.4, `elapsed=${sNoop}s`);
	setActiveStatus(null);
	let threw = false;
	try { freezeActiveStatus(); unfreezeActiveStatus(); } catch { threw = true; }
	check("sf-noop null-sink hooks are safe", !threw);
}

// sf-hook-throw: the modal refuses piped, but the freeze still releases.
{
	const { askApproval } = await import(join(DIST, "src", "prompt.js"));
	const st = new KindStatus("thinking", fns);
	st.start();
	let threw = false;
	try {
		await askApproval("h", "d", ["a"]);
	} catch {
		threw = true;
	}
	check("sf-hook-throw refused modal still unfreezes", threw && st.frozen === false, `threw=${threw} frozen=${st.frozen}`);
	st.stop({ failed: false, detail: "", turns: 0, messages: 0 });
}

// sf-normal: unfrozen turns bill wall time, tick/resume identical.
{
	const st = new KindStatus("thinking", fns);
	st.start();
	await sleep(250);
	const s = await stoppedSeconds(() => st.stop({ failed: false, detail: "", turns: 1, messages: 1 }));
	check("sf-normal normal turn bills wall time", s > 0.15 && s < 0.6, `elapsed=${s}s`);
}

check("sf-waitline waiting row copy pinned", STATUS_WAITING_LINE === "· waiting on you — thinking timer paused", STATUS_WAITING_LINE);

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const home = mkdtempSync(join(tmpdir(), "bi-sf-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	const probe = join(home, "probe.mjs");
	writeFileSync(probe, `import { askApproval } from ${JSON.stringify(join(DIST, "src", "prompt.js"))};\nimport { KindStatus } from ${JSON.stringify(join(DIST, "src", "status.js"))};\nimport { format_status, format_turn_summary } from ${JSON.stringify(join(DIST, "baml_sdk", "index.js"))};\nconst status = new KindStatus("thinking", { formatStatus: format_status, formatSummary: format_turn_summary });\nstatus.start();\nawait new Promise((r) => setTimeout(r, 1000));\nconst t0 = Date.now();\nconst r = await askApproval("Approve tool?", "detail line", ["choice-1", "choice-2", "choice-3", "choice-4"]);\nstatus.stop({ failed: false, detail: "", turns: 1, messages: 1 });\nconsole.log("RESULT:" + r + " WALL:" + ((Date.now() - t0) / 1000).toFixed(1));\n`);

	const run = spawnSync("python3", [join(HERE, "status-freeze-pty.py"), "5"], {
		env: { ...process.env, HOME: home, TERM: "xterm-kitty", PROBE_JS: probe, DIAG_HOME: home },
		encoding: "utf8",
		timeout: 90000,
	});
	const lines = (run.stdout ?? "").split("\n");
	const soak = lines.find((l) => l.startsWith("SOAK ")) ?? "";
	const sm = soak.match(/^SOAK waitline=(yes|no) rows=(\d+)\/(\d+) markers=(\d+)$/);
	const tail = lines.find((l) => l.startsWith("RESULT:")) ?? "";
	const tm = tail.match(/^RESULT:(\S+) ELAPSED:(\S+) WALL:(\S+) CODE:(\S+)$/);
	const elapsed = tm ? Number(tm[2]) : NaN;
	const wall = tm ? Number(tm[3]) : NaN;
	check("sf-wait waiting row visible while open", sm?.[1] === "yes", soak);
	check("sf-wait choice rows intact under tick", sm?.[2] === "4" && sm?.[3] === "4" && sm?.[4] === "1", soak);
	// ~1s pre-open thinking survives, the 5s open wait evaporates.
	// Both bounds load-bear: no freeze bills ~6.3s (upper fails), a
	// freeze pinning zero bills ~0.0s (lower fails — observed live).
	check("sf-wait wait excluded from elapsed", Number.isFinite(elapsed) && elapsed > 0.5 && elapsed < 4.0, `elapsed=${tm?.[2]}s`);
	check("sf-wait the wait really happened", Number.isFinite(wall) && wall > 4.5, `wall=${tm?.[3]}s`);
	check("sf-wait enter resolves after freeze", tm?.[1] === "0", tail);

	// Pipes: freeze/unfreeze/stop piped — `[bi]` summary, no escape bytes.
	const pipeProbe = join(home, "pipe-probe.mjs");
	writeFileSync(pipeProbe, `import { KindStatus } from ${JSON.stringify(join(DIST, "src", "status.js"))};\nimport { format_status, format_turn_summary } from ${JSON.stringify(join(DIST, "baml_sdk", "index.js"))};\nconst s = new KindStatus("thinking", { formatStatus: format_status, formatSummary: format_turn_summary });\ns.start();\ns.freeze();\nawait new Promise((r) => setTimeout(r, 100));\ns.unfreeze();\ns.stop({ failed: false, detail: "", turns: 1, messages: 1 });\n`);
	const prun = spawnSync("node", [pipeProbe], { encoding: "utf8", timeout: 30000 });
	const pout = (prun.stdout ?? "") + (prun.stderr ?? "");
	check("sf-pipe frozen turn on pipe stays one plain line", prun.status === 0 && pout.startsWith("[bi] "), `status=${prun.status} out=${pout.slice(0, 80)}`);
	check("sf-pipe no escape bytes on pipe", !pout.includes("\x1b"), `out=${JSON.stringify(pout.slice(0, 80))}`);
}

if (failures) { console.log(`status-freeze: ${failures} FAIL`); process.exit(1); }
console.log("status-freeze: all green");
