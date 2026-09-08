// bi/scripts/status-width.mjs — bi#166 status paint width clamp (plain node).
//
// bi's KindStatus.paint wrote `\r\x1b[2K${line}` with no width cap: when the
// BAML-shaped status plus the event string (tool names, file paths, retry
// detail) exceeded the terminal width, the line wrapped to a second row and
// the next tick's clear left permanent stale residue. The fix clamps the
// painted line to the live stderr width via pi-tui truncateToWidth
// (ANSI-aware); BAML formatStatus/formatSummary shaping is untouched and
// pipes still print one plain line per event.
//
// Red-check (bi#57): reverting the clamp (paint writes the raw line,
// rebuild) makes `every tick fits 20 cols` fail with a 60+ col paint;
// restoring it goes green. Verified 2026-09-06: reverted →
// `FAIL every tick fits 20 cols — widest paint N>20`, restored → green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { KindStatus, clampStatusLine } = await import(join(ROOT, "..", "dist", "src", "status.js"));
const { format_status, format_turn_summary } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const fns = { formatStatus: format_status, formatSummary: format_turn_summary };

// Pure clamp: long lines fit, degenerate widths pass through untouched.
{
	const long = "⠋ thinking — tool Write /very/long/path/to/some/file.ts 你好世界 retry detail ".repeat(3);
	const cut = clampStatusLine(long, 20);
	check(visibleWidth(cut) <= 20, `explicit width clamps to 20 cols (got ${visibleWidth(cut)})`);
	check(clampStatusLine(long, 0) === long, "width 0 skips the clamp");
	check(clampStatusLine(long, -4) === long, "negative width skips the clamp");
	check(clampStatusLine("short", 20) === "short", "short lines pass through");
}

// Live ticks at a stubbed narrow width: drive several ticks with a long
// event, assert every painted line fits 20 cols and repaints are
// single-row (no embedded newline → next tick's clear leaves no residue).
{
	const writes = [];
	const origWrite = process.stderr.write.bind(process.stderr);
	const origIsTTY = process.stderr.isTTY;
	const origColumns = process.stderr.columns;
	Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stderr, "columns", { value: 20, configurable: true });
	process.stderr.write = (chunk, ...args) => {
		writes.push(String(chunk));
		return true;
	};
	const s = new KindStatus("thinking", fns);
	try {
		s.start();
		s.onEvent("tool Write /very/long/path/to/some/file.ts 你好世界 retrying attempt detail");
		await new Promise((r) => setTimeout(r, 350));
	} finally {
		Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
		Object.defineProperty(process.stderr, "columns", { value: origColumns, configurable: true });
		process.stderr.write = origWrite;
		s.stop({ failed: false, detail: "", turns: 1, messages: 1 });
	}
	const paints = writes.filter((w) => !w.endsWith("\n"));
	check(paints.length >= 2, `several ticks painted (got ${paints.length})`);
	const singleRow = paints.every((w) => /^\r\x1b\[2K[^\n]*$/.test(w));
	check(singleRow, "every repaint is a single cleared row (no residue)");
	const widest = Math.max(...paints.map((w) => visibleWidth(w.replace(/^\r\x1b\[2K/, ""))));
	check(widest <= 20, `every tick fits 20 cols (widest ${widest})`);
}

// Pipes unchanged: non-TTY still prints one plain line per event.
{
	const lines = [];
	const origError = console.error;
	console.error = (msg) => lines.push(String(msg));
	const s = new KindStatus("thinking", fns);
	if (process.stderr.isTTY) {
		console.error = origError;
		console.log("skip: pipe check needs non-TTY stderr");
	} else {
		try {
			s.onEvent("hello pipe event");
		} finally {
			console.error = origError;
		}
		check(lines.length === 1 && lines[0] === "[loop] hello pipe event", `pipe prints one plain line (got ${JSON.stringify(lines)})`);
	}
}

if (failures) process.exit(1);
console.log("status-width: all green");
