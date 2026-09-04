// bi/scripts/tool-diff.mjs — bi#71 transcript-diff conformance.
// Drives the REAL host shaper (shapeToolResult, the exact function the
// transcript calls after every tool success) over fixtures and asserts:
// (1) a diffable edit envelope renders git-style unified diff lines,
// (2) a new-file write renders an all-add hunk, (3) the host lines are
// byte-identical to BAML unified_diff for the same sides (the pinned spec
// both sides implement), and (4) every non-diffable payload (other tools,
// failures, partial envelopes, binary sides) yields zero lines — the
// transcript keeps today's start/done lines unchanged (raw fallback).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { shapeToolResult, emitToolDiff } = await import(join(ROOT, "..", "dist", "src", "tools.js"));
const { unified_diff_async, render_tool_diff_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const env = (path, before, after) => JSON.stringify({ path, before, after });

// (1) edit turn shows a readable diff inline.
const edit = await shapeToolResult("edit", env("src/app.ts", "a\nb\nc\n", "a\nB\nc\n"));
check(edit.diffable === true, "edit envelope is diffable");
check(
	JSON.stringify(edit.lines) ===
		JSON.stringify(["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]),
	`edit renders unified hunk (got ${JSON.stringify(edit.lines)})`,
);

// (2) new-file write renders an all-add hunk.
const created = await shapeToolResult("write", env("new.txt", "", "x\ny\n"));
check(created.diffable === true, "write-new-file envelope is diffable");
check((await created.lines[2]) === "@@ -0,0 +1,2 @@", `new file header is pure-add (got ${created.lines[2]})`);
check(created.lines.slice(3).every((l) => l.startsWith("+")), "new file body is all-add lines");

// (3) host/BAML parity on the same sides.
const baml = await unified_diff_async("src/app.ts", "a\nb\nc\n", "a\nB\nc\n");
check(JSON.stringify(edit.lines) === JSON.stringify(baml), "host lines byte-equal BAML unified_diff");
const view = await render_tool_diff_async("edit", "src/app.ts", "a\nb\nc\n", "a\nB\nc\n");
check(view.diffable === true && JSON.stringify([...view.lines]) === JSON.stringify(edit.lines), "BAML view agrees with host shape");

// A no-op edit still reads as a no-op inline.
const noop = await shapeToolResult("edit", env("s.txt", "x\n", "x\n"));
check(noop.diffable === true && JSON.stringify(noop.lines) === JSON.stringify(["(no changes: s.txt)"]), "identical sides note no changes");

// (4) raw fallback: every non-diffable payload yields zero lines.
const fallbacks = [
	["bash", "a\nb\n", "plain tool output"],
	["edit", "unknown tool edit — bais_* tools handled here, others need host impl", "tool failure text"],
	["edit", JSON.stringify({ path: "f", before: "a\n" }), "partial envelope (no after)"],
	["edit", JSON.stringify({ path: "f", before: "a\n", after: null }), "null envelope side"],
	["edit", JSON.stringify({ path: "f", before: "a\0b\n", after: "a\n" }), "binary before side"],
	["edit", JSON.stringify(["not", "an", "object"]), "non-object envelope"],
	["read", env("f", "a\n", "b\n"), "non-edit tool with envelope"],
];
for (const [name, output, label] of fallbacks) {
	const s = await shapeToolResult(name, output);
	check(s.diffable === false && s.lines.length === 0, `fallback: ${label} adds no lines`);
}

// Oversized sides never touch the LCS table (note + after-image head).
let big = "";
for (let k = 0; k < 310; k++) big += `line${k}\n`;
const omitted = await shapeToolResult("edit", env("big.txt", "seed\n", big));
check(omitted.diffable === true, "oversized edit stays diffable");
check(omitted.lines[2] === "(diff omitted: 1 → 310 lines)", `oversize note names sizes (got ${omitted.lines[2]})`);
check(omitted.lines.length === 104 && omitted.lines[103] === "(… 210 more lines)", "oversize head caps at 100 + tail note");

// The transcript's exact call: stdout gains the diff lines and nothing else.
const captured = [];
const realLog = console.log;
console.log = (l) => captured.push(String(l));
try {
	await emitToolDiff("edit", env("src/app.ts", "a\nb\nc\n", "a\nB\nc\n"));
} finally {
	console.log = realLog;
}
check(
	JSON.stringify(captured) ===
		JSON.stringify(["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]),
	`emitToolDiff prints the diff to the transcript (got ${JSON.stringify(captured)})`,
);
const silent = [];
console.log = (l) => silent.push(String(l));
try {
	await emitToolDiff("bash", "a\nb\n");
	await emitToolDiff("edit", "unknown tool edit — needs host impl");
} finally {
	console.log = realLog;
}
check(silent.length === 0, "emitToolDiff prints nothing for non-diffable payloads");

if (failures) process.exit(1);
console.log("tool-diff: all green");
