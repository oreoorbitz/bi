// bi/src/diff-render.ts — TTY color for unified-diff transcript lines (bi#27).
// BAML owns the diff SHAPE (unified_diff in render.baml — the pinned spec);
// this module only tints already-shaped lines for the terminal. Roles mirror
// pi's renderDiff: removed red, added green, hunk headers + file headers dim,
// context + notes plain. Theme null/none (pipes) is byte-identical through
// style_segment passthrough — color never corrupts logs.
//
// Wiring note: emitToolDiff (src/tools.ts) prints plain lines today; threading
// these tints through is one call — `for (const l of await colorizeDiffLines(
// shaped.lines, theme)) console.log(l)` — left to the tools.ts owner.

import { style_segment_async } from "../baml_sdk/index.js";

function diffLineRole(line: string): string | null {
	if (line.startsWith("@@")) return "dim";
	if (line.startsWith("--- ") || line.startsWith("+++ ")) return "dim";
	if (line.startsWith("+") && !line.startsWith("+++")) return "good";
	if (line.startsWith("-") && !line.startsWith("---")) return "bad";
	return null;
}

export async function colorizeDiffLine(line: string, theme: string | null): Promise<string> {
	const role = diffLineRole(line);
	if (role === null) return line;
	return style_segment_async(line, role, theme);
}

export async function colorizeDiffLines(lines: string[], theme: string | null): Promise<string[]> {
	const out: string[] = [];
	for (const l of lines) out.push(await colorizeDiffLine(l, theme));
	return out;
}
