// bi/scripts/paint-chain.mjs — editor-box paint drill (bi#182 → bi#181)
//
// bi#182 docked the separate prompt label row onto the dash-rule editor
// box; bi#181 replaced that pair with kimi's CustomEditor composition:
// ONE rounded box (╭╮╰╯ corners + │ side bars, BAML-shaped label spliced
// into the top border) with the `>` prompt glyph inside at column 2
// (paddingX 4, kimi injectPromptSymbol guard — only literal spaces are
// overwritten, never the cursor cell). This drill asserts the composed
// geometry on a replying pty: label row == box top border row, glyph
// visible at column 2 of the first interior row, footer frame + model
// line on the last two rows, clean exit 0.
//
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   pc-dock        trust→picker→editor: the BAML-shaped label (bi[0]>)
//                  lives IN the box's top border (label row == box top)
//   pc-glyph       `>` prompt glyph at column 2 of the first interior
//                  row, side bars intact (row1='│ > …')
//   pc-footer      footer frame + model line on the last two rows
//   pc-exit        clean exit 0
// The driver (paint-chain-pty.py) answers kitty query bursts itself —
// mute ptys are insufficient evidence for paint geometry (bi#179 lesson).
//
// bi#194 red-check record (bi#57), 2026-09-08 (kimi-tui194) — the footer
// re-pin hook (ensureReplTui's term.write wrapper → HostFooter.repin,
// bi/src/tui.ts) is what keeps rows N-1/N footer-owned now that no
// DECSTBM region absorbs pi-tui's full-height frame dumps:
//   hunk:     DECSTBM removed from HostFooter.install WITHOUT the
//             re-pin hook (the intermediate build during the bi#194
//             work — equivalent to reverting `liveFooter?.repin()`).
//   expected: pc-footer FAILs — pi-tui's relative dumps stream blank
//             padding over rows N-1/N and nothing reasserts them.
//   observed: `FAIL  pc-footer frame rows pinned —` with GEOM
//             foot1='' foot2='' (pc-dock/pc-glyph/pc-exit still green —
//             the failure is specific to the footer rows).
//   restore:  re-pin hook added → paint-chain drill: green.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
	const home = mkdtempSync(join(tmpdir(), "bi-pc-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Header-only session: zero turns, so the prompt label reads bi[0]>.
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"),
        process.env.PC_ROWS ?? "40", process.env.PC_COLS ?? "160", home, CLI], {
		env: { ...process.env, HOME: home, TERM: "xterm-kitty", PC_TIMEOUT: "70" },
		encoding: "utf8",
		timeout: 120000,
	});
	const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("GEOM ")) ?? "";
	const m = line.match(/prompt=\[([^\]]*)\] boxtop=(\d+|None) gap=(-?\d+) foot1='(.*)' foot2='(.*)' code=(-?\d+) input='((?:[^'\\]|\\.)*)' row1='((?:[^'\\]|\\.)*)'/);
	const promptRow = m ? m[1] : "";
	const boxtop = m ? m[2] : "None";
	const gap = m ? Number(m[3]) : NaN;
	const foot = m ? `${m[4]} ${m[5]}` : "";
	const code = m ? Number(m[6]) : NaN;
	const row1 = m ? m[8] : "";
	check("pc-dock prompt label inside the box top border", m !== null && gap === -1 && promptRow === boxtop, line.slice(0, 120) || `status=${run.status}`);
	check("pc-glyph `>` at column 2 of the first interior row", /^│ >/.test(row1), `row1='${row1.slice(0, 40)}'`);
	check("pc-footer frame rows pinned", foot.includes("thinking default"), foot.slice(0, 80));
	check("pc-exit clean", code === 0, `code=${Number.isNaN(code) ? `driver-status=${run.status}` : code}`);
}

if (failures > 0) {
	console.error(`paint-chain drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("paint-chain drill: green");
