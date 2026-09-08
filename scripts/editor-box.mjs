// bi/scripts/editor-box.mjs — rounded editor box drill (bi#181)
//
// kimi CustomEditor composition (custom-editor.ts:821-857) reborn in
// PromptEditor.render (bi/src/prompt.ts): ONE rounded box — BAML-shaped
// label spliced into the top border (render_editor_top_border), `>`
// prompt glyph at column 2 of the first content row (paddingX 4, kimi
// injectPromptSymbol guard: only literal spaces are overwritten), and
// border color signaling context (dim idle, accent on `/`-prefixed
// input — EDITOR_BORDER_ROLE_* constants; bi#185 palette tokens swap
// there when they land). Headless: PromptEditor renders against a stub
// tui ({terminal:{rows}} is all pi-tui's Editor touches), no pty
// needed; the pty half (label-in-border geometry, footer docking)
// rides paint-chain.mjs.
//
// Checks:
//   eb-shape       theme null: ╭ bi[0]> …╮ top border, │ > interior,
//                  ╰…╯ bottom, zero SGR bytes
//   eb-idle-dim    idle border takes the theme's dim role (\x1b[2m),
//                  never accent
//   eb-slash-accent typing `/` flips the border to accent (\x1b[36m)
//   eb-cursor      the SGR inverse cursor cell survives the wrap —
//                  side bars/glyph overwrite literal spaces only
//
// Red-check record (bi#57), executed 2026-09-07:
//   Hunk: PromptEditor.render post-processing (bi/src/prompt.ts) —
//         bypassed with `return base;` before the wrap.
//   Expected failure: eb-shape/eb-idle-dim/eb-slash-accent FAIL (bare
//         dash-rule editor, no glyph, no border paint).
//   Observed (bypassed): all four FAIL — eb-shape (top='────…',
//         row1='    ␣…' no glyph/side bars), eb-idle-dim,
//         eb-slash-accent, and eb-cursor (its assertion names the
//         wrapped row shape '│ > ab', so it fails on the missing
//         chrome; the bare cursor SGR itself survived). Restored: all
//         four ok, drill green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { PromptEditor } = await import(join(ROOT, "..", "dist", "src", "prompt.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const plainTheme = { borderColor: (s) => s, selectList: {} };
const stubTui = { terminal: { rows: 40, columns: 80 } };
const SGR = /\[[0-9;]*m/;
const stripSgr = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeEditor(theme) {
	const ed = new PromptEditor(stubTui, plainTheme, { paddingX: 4 });
	ed.promptLabel = "bi[0]>";
	ed.borderTheme = theme;
	return ed;
}

// 1 — shape with no theme: exact border text, glyph at column 2, no SGR
// on the chrome rows (the content row always carries the inverse
// cursor's SGR — that is the guarded cell, not chrome).
{
	const ed = makeEditor(null);
	const lines = ed.render(60);
	const top = lines[0] ?? "";
	const bottom = lines[lines.length - 1] ?? "";
	check(
		top.startsWith("╭ bi[0]> ") && top.endsWith("╮") && bottom.startsWith("╰")
			&& (lines[1] ?? "").startsWith("│ > ") && !SGR.test(top + bottom),
		`eb-shape rounded box + glyph, chrome plain without theme (top=${JSON.stringify((top ?? "").slice(0, 30))} row1=${JSON.stringify((lines[1] ?? "").slice(0, 12))})`,
	);
}

// 2 — idle border takes the default theme's dim role, never accent.
{
	const ed = makeEditor("default");
	const border = (ed.render(60)[0] ?? "") + (ed.render(60).at(-1) ?? "");
	check(border.includes("\x1b[2m") && !border.includes("\x1b[36m"), "eb-idle-dim idle border is dim, not accent");
}

// 3 — typing `/` flips the border to accent.
{
	const ed = makeEditor("default");
	ed.handleInput("/");
	const border = (ed.render(60)[0] ?? "") + (ed.render(60).at(-1) ?? "");
	check(border.includes("\x1b[36m"), "eb-slash-accent `/` buffer flips border to accent");
}

// 4 — cursor cell survives: type text, the inverse cursor is still in
// the render (side bars/glyph overwrote only literal spaces).
{
	const ed = makeEditor(null);
	for (const ch of "ab") ed.handleInput(ch);
	const lines = ed.render(60);
	const joined = lines.join("\n");
	const cursorRow = lines.find((l) => l.includes("\x1b[7m")) ?? "";
	check(
		joined.includes("\x1b[7m") && cursorRow.startsWith("│ > ab") && lines.length >= 3,
		`eb-cursor inverse cursor survives the wrap (row=${JSON.stringify(stripSgr(cursorRow).slice(0, 16))})`,
	);
}

if (failures > 0) {
	console.error(`editor-box drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("editor-box drill: green");
