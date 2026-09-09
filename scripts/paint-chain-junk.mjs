// bi/scripts/paint-chain-junk.mjs — junk-glyph drill (bi#183)
//
// The screenshot class: a literal junk glyph (e.g. `%`, `7u`, `64;…;52c`)
// sitting in the editor buffer at the first prompt on a kitty-replying
// terminal. No renderer emits it — it is input-side: a negotiation reply
// (kitty flags `\x1b[?7u` / DA `\x1b[?64;…;52c`) SPLIT across the pi-tui
// 150ms negotiation-fragment flush. The flushed `\x1b[?…` prefix is
// forwarded as input and the tail arrives as PLAIN TEXT, which the
// freshly focused Editor inserts into its buffer (proposals/14 class).
//
// Drill: the pty driver holds its negotiation replies until the editor
// prompt has painted (PC_REPLY_ON='bi>'), waits out the mount render
// (PC_REPLY_DELAY=0.8 from arming — the settle window keeps stdin
// paused, so earlier writes coalesce into harmless whole replies in the
// kernel buffer), then delivers them split with a 300ms intra-reply gap
// (PC_SPLIT_GAP=0.3 > 150ms flush), so the tails land in separate reads
// while the editor owns focus. Assertion: the Editor buffer is EMPTY at
// the first prompt (GEOM input='') AND the tails really arrived
// post-focus (BI_TUI_DEBUG tap raw lines + replies>=2) — a mute or
// unanswered pty going green is NOT evidence (bi#179 lesson).
//
// Red-check record (bi#57), executed 2026-09-07:
//   Hunk: PromptEditor.suppressNegotiationStragglers guard body
//         (bi/src/prompt.ts) — bypassed with an early `return data;`.
//   Expected failure: pc-junk-buffer — the split-reply tails are typed
//         into the focused editor buffer (input='4;1;…;52cu4;1;…').
//   Observed (bypassed): FAIL pc-junk-buffer Editor buffer empty at
//         first prompt — input='4;1;2;4;6;17;18;21;22;52cu4;1;2;4;6;17;1'
//         and FAIL pc-junk-exit clean — code=-9 (the junk turned the
//         first "/quit" beat into a non-slash turn, wedging the chain);
//         pc-junk-replies/pc-junk-tap stayed ok, proving the failure is
//         the insertion path, not the adversary.
//   Observed (restored): all four checks ok, drill green.
//   Note: a whole-file `git stash` red-check is NOT valid here — HEAD's
//   prompt.ts predates the tree's SlashPool.skillNames (build breaks
//   for an unrelated reason), so the hunk-level bypass above is the
//   recorded revert.
//
// Red-check record 2 (bi#57), executed 2026-09-08 — settleNegotiation
//   soft/hard cap (bi/src/prompt.ts, same issue, picker-filter arm):
//   Hunk: the flat `if (waited >= cap) break;` restored in place of the
//         quiet-gated soft cap.
//   Expected failure: bytewise delivery spans past the flat 450ms cap,
//         focus lands mid-reply and the tail types into the focused
//         picker filter, wedging the chain.
//   Observed (bypassed, via scripts/editor-clean.mjs PC_BYTEWISE=1):
//         3/3 runs FAIL ec-empty + ec-exit — grid showed the trust
//         filter reading `> ;21;22;52c1/quit/quit` with "No matching
//         commands", code=-9. Restored: 3/3 green. (Baseline luck
//         explains the intermittent pre-fix green: the race was always
//         there, the flat cap just usually won it.)
//
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   pc-junk-replies  both negotiation replies delivered split, post-focus
//   pc-junk-buffer   Editor buffer empty at first prompt (GEOM input='')
//   pc-junk-tap      tap log proves tails arrived as raw stdin post-focus
//   pc-junk-exit     clean exit 0
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const home = mkdtempSync(join(tmpdir(), "bi-pcj-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Header-only session: zero turns, so the prompt reads bi> (bi#201).
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	const tap = join(home, "tap.log");
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"),
		process.env.PC_ROWS ?? "40", process.env.PC_COLS ?? "160", home, CLI], {
		env: {
			...process.env,
			HOME: home,
			TERM: "xterm-kitty",
			PC_TIMEOUT: "70",
			// Adversary: replies wait for the editor prompt to paint, then
			// arrive split with the tail past pi-tui's 150ms flush window.
			// Delay is from ARMING (driver-side), so the prefix is read
			// promptly post-focus and the tail lands in a separate read.
			PC_REPLY_ON: "bi>",
			PC_REPLY_DELAY: "0.8",
			PC_SPLIT: "1",
			PC_SPLIT_GAP: "0.3",
			BI_TUI_DEBUG: tap,
		},
		encoding: "utf8",
		timeout: 120000,
	});
	const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("GEOM ")) ?? "";
	const mReplies = line.match(/replies=(\d+)/);
	const mInput = line.match(/input='((?:[^'\\]|\\.)*)'/);
	const mCode = line.match(/code=(-?\d+)/);
	const replies = mReplies ? Number(mReplies[1]) : 0;
	const input = mInput ? mInput[1] : "<no GEOM>";
	const code = mCode ? Number(mCode[1]) : NaN;
	let tapLog = "";
	try { tapLog = readFileSync(tap, "utf8"); } catch {}
	// Non-vacuity: the negotiation replies (two query bursts — the trust
	// host and the picker/editor host each query once) were delivered
	// after the editor prompt painted, and the tap proves the tails
	// reached stdin as raw bytes while the editor owned focus.
	const focusAt = tapLog.split("\n").find((l) => l.includes("focus kitty=")) ?? "";
	const tailRaw = tapLog.split("\n").filter((l) => l.includes("raw ") && /52c|7u|"u"|4;1;2/.test(l));
	check("pc-junk-replies split replies delivered post-focus", replies >= 2 && focusAt !== "", `replies=${replies} ${line.slice(0, 100) || `status=${run.status}`}`);
	check("pc-junk-tap tails reached stdin", tailRaw.length > 0, tailRaw[0]?.slice(0, 100) ?? "no tail raw line");
	check("pc-junk-buffer Editor buffer empty at first prompt", input === "", `input='${input}'`);
	check("pc-junk-exit clean", code === 0, `code=${Number.isNaN(code) ? `driver-status=${run.status}` : code}`);
}

if (failures > 0) {
	console.error(`paint-chain-junk drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("paint-chain-junk drill: green");
