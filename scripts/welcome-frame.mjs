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
//
// bi#193 color arms: the main pty run strips NO_COLOR/BI_THEME from the
// child env (production default = colored) and records raw bytes via
// PROBE_RAW; wf-color-* arms byte-pin the chrome SGR at the named
// segments (title/hint/border → primary #4FA8FF, label values →
// text_dim #888888), and a second NO_COLOR pty run proves the frame is
// truecolor-escape-free. Red-check (bi#57), executed 2026-09-08:
// reverted colorWelcomeRow's label-value branch to return the line
// unwrapped => FAIL wf-color-label-value (no dim SGR before the cwd),
// restored => green.
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
	const home = mkdtempSync(join(tmpdir(), "bi-wf-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Header-only session: zero turns, so the prompt label reads bi[0]>.
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	// bi#193: the color arms need the production default (colored) — the
	// ambient env (this shell exports NO_COLOR) must not leak in. Raw
	// bytes land in PROBE_RAW for the SGR pins.
	const rawPath = join(tmpdir(), `bi-wf-raw-${process.pid}.log`);
	const colorEnv = { ...process.env, HOME: home, TERM: "xterm-kitty", PC_TIMEOUT: "70", PC_DUMP_GRID: "1", PROBE_RAW: rawPath };
	delete colorEnv.NO_COLOR;
	delete colorEnv.BI_THEME;
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"),
		// 60 rows: the 11-row welcome box + a long ready list overflow a
		// 40-row viewport and the box top scrolls off (correct transcript
		// behavior — the drill asserts survival, so it needs headroom).
		process.env.PC_ROWS ?? "60", process.env.PC_COLS ?? "160", home, CLI], {
		env: colorEnv,
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

	// bi#193 wf-color-* arms: byte-pin the chrome SGR in the raw stream.
	// Codes derive from chromeAnsi with a forced-unsuppressed env, never
	// hardcoded — the literal pins live in theme-chrome.mjs/tool-exec.mjs.
	const tf = await import(join(HERE, "..", "dist", "src", "theme-files.js"));
	const PRIMARY = tf.chromeAnsi("primary", {});
	const DIM = tf.chromeAnsi("text_dim", {});
	const raw = readFileSync(rawPath, "utf8");
	// Regex-escape, then render ESC as \x1b — a bare [ in the SGR code
	// would otherwise open a regex char class (it did; the arm went
	// falsely red on a correctly colored stream).
	const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\x1b/g, "\\x1b");
	check(
		"wf-color-title title row leads primary",
		new RegExp(`${esc(PRIMARY)}[^\\x1b]*Welcome to bi!`).test(raw),
		"no primary SGR before the title",
	);
	check(
		"wf-color-hint hint row leads primary",
		new RegExp(`${esc(PRIMARY)}[^\\x1b]*Type / for commands`).test(raw),
		"no primary SGR before the hint",
	);
	check(
		"wf-color-label-value label values recede text_dim",
		new RegExp(`Directory: +${esc(DIM)}[^\\x1b]+`).test(raw),
		"no dim SGR before the Directory value",
	);
	check("wf-color-reset segments close fg-default", raw.includes("\x1b[39m"), "no fg-default reset in stream");

	// Escape-free arm: the same boot under NO_COLOR carries no truecolor
	// SGR at all (chrome AND the six-role theme suppress; pi-tui's own
	// inverse/bold are not 38;2).
	const home2 = mkdtempSync(join(tmpdir(), "bi-wfn-"));
	mkdirSync(join(home2, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home2, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	writeFileSync(
		join(home2, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home2, parent_session: null, label: null }) + "\n",
	);
	const rawPath2 = join(tmpdir(), `bi-wfn-raw-${process.pid}.log`);
	const run2 = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), process.env.PC_ROWS ?? "60", process.env.PC_COLS ?? "160", home2, CLI], {
		env: { ...process.env, HOME: home2, TERM: "xterm-kitty", PC_TIMEOUT: "70", NO_COLOR: "1", PROBE_RAW: rawPath2 },
		encoding: "utf8",
		timeout: 120000,
	});
	const raw2 = readFileSync(rawPath2, "utf8");
	check("wf-nocolor no truecolor SGR in the whole stream", !raw2.includes("\x1b[38;2;") && !raw2.includes("\x1b[39m"), "color SGR leaked under NO_COLOR");
	check("wf-nocolor welcome text still present", raw2.includes("Welcome to bi!"), "frame lost under NO_COLOR");
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
