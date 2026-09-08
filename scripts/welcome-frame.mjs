// bi/scripts/welcome-frame.mjs — welcome entry frame drill (bi#180)
//
// kimi mounts a rounded primary-bordered welcome box as the first
// transcript child (welcome.ts:49-107); bi greeted with a void — and
// the pre-modal ready frame was ERASED by modal full-repaints of the
// empty base Container (cli.ts mount render streamed blanks over the
// bypass print; proven in the BI_TUI_DEBUG tap). Fix: the BAML-shaped
// render_welcome_frame + render_ready_frame mount INTO the modal
// host's base layer from repl() after the last startup modal hides, so
// every subsequent modal repaint carries them by construction.
//
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0) — the
// driver answers kitty bursts itself and dumps the quiet post-modal
// grid (PC_DUMP_GRID=1); survival is asserted on the GRID, not the
// byte stream (modal repaints erase rows from the stream, not the
// screen — that distinction IS the bug):
//   wf-welcome   welcome box title + logo row visible post-modals
//   wf-labels    Directory/Session/Model/Version label column visible
//   wf-ready     ready-BAIS frame visible beneath the welcome box
//   wf-editor    editor box still docked (label in top border, gap -1)
//   wf-exit      clean exit 0
//   wf-pipes     piped stdout stays byte-stable (no welcome bytes)
//
// Red-check record (bi#57), executed 2026-09-08:
//   Hunk: printWelcomeFrame base-layer mount (bi/src/cli.ts) — replaced
//         the base-layer mount with bypass console.log lines.
//   Expected failure: wf-welcome/wf-labels/wf-ready — the editor
//         modal's mount render erases bypass prints from the grid.
//   Observed (bypassed): FAIL wf-welcome (no title row), FAIL
//         wf-labels (no label rows), FAIL wf-ready (no ready row);
//         wf-editor/wf-exit/wf-pipes stayed ok — the erasure is the
//         mount render, not the frame construction. Restored: all six
//         checks ok, drill green.
//   Refinement (same day): the mount moved from a direct
//         ensureReplTui+addChild in cli.ts to stageBaseFrame consumed by
//         the first askEdit (prompt.ts) — creating the host outside the
//         modal envelope fired the kitty query while readline still
//         owned stdin, and readline echoed the DA reply as
//         caret-notation keypresses (e2e-pty help-skills-note
//         `/64;1;2/` leak FAIL; green after the move). The drill's
//         viewport is 60 rows: welcome(11)+ready(N) overflows 40 and
//         the box top scrolls off — correct transcript behavior, but
//         the drill asserts survival and needs the headroom.
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
	const home = mkdtempSync(join(tmpdir(), "bi-wf-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Header-only session: zero turns, so the prompt label reads bi[0]>.
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"),
		// 60 rows: the 11-row welcome box + a long ready list overflow a
		// 40-row viewport and the box top scrolls off (correct transcript
		// behavior — the drill asserts survival, so it needs headroom).
		process.env.PC_ROWS ?? "60", process.env.PC_COLS ?? "160", home, CLI], {
		env: { ...process.env, HOME: home, TERM: "xterm-kitty", PC_TIMEOUT: "70", PC_DUMP_GRID: "1" },
		encoding: "utf8",
		timeout: 120000,
	});
	const stdout = run.stdout ?? "";
	const grid = stdout.split("\n").filter((l) => l.startsWith("GRID|")).map((l) => l.slice(5));
	const geom = stdout.split("\n").find((l) => l.startsWith("GEOM ")) ?? "";
	const gapM = geom.match(/gap=(-?\d+)/);
	const codeM = geom.match(/code=(-?\d+)/);
	const titleRow = grid.findIndex((l) => l.includes("Welcome to bi!"));
	const readyRow = grid.findIndex((l) => l.includes("bi — ready BAIS"));
	// titleRow may be 0: a long ready list scrolls the ╭ row off the
	// viewport — survival is about the box CONTENT, not its position.
	check("wf-welcome box title + logo row visible post-modals", titleRow >= 0 && grid[titleRow].startsWith("│") && grid[titleRow].includes("▐█▛█▛█▌"), grid[titleRow]?.slice(0, 50) ?? "no title row");
	check(
		"wf-labels Directory/Session/Model/Version column visible",
		["Directory:", "Session:", "Model:", "Version:"].every((k) => grid.some((l) => l.includes(k))),
		grid.filter((l) => /Directory:|Session:|Model:|Version:/.test(l)).map((l) => l.trim().slice(0, 30)).join(" | ") || "no label rows",
	);
	check("wf-ready ready-BAIS frame visible beneath the welcome box", readyRow > titleRow && grid.slice(readyRow + 1).some((l) => /^bi#\d+ {2}/.test(l.trim())), grid[readyRow]?.slice(0, 40) ?? "no ready row");
	check("wf-editor editor box still docked (label in top border)", gapM !== null && Number(gapM[1]) === -1, geom.slice(0, 100));
	check("wf-exit clean", codeM !== null && Number(codeM[1]) === 0, `code=${codeM?.[1] ?? `driver-status=${run.status}`}`);
}

// Pipes never see the frame (bi#180 acceptance: byte-stable pipe output).
{
	const home = mkdtempSync(join(tmpdir(), "bi-wfp-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	const run = spawnSync("node", [CLI], {
		env: { ...process.env, HOME: home, TERM: "dumb" },
		input: "/quit\n",
		encoding: "utf8",
		timeout: 60000,
	});
	check("wf-pipes no welcome bytes on pipes", !(run.stdout ?? "").includes("Welcome to bi!"), `status=${run.status}`);
}

if (failures > 0) {
	console.error(`welcome-frame drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("welcome-frame drill: green");
