// bi/scripts/summary-blocks.mjs — summary/skill block printer conformance (bi#27; bi#88/bi#97/bi#98).
// Drives the REAL host printers (dist/src/summary-blocks.js), captures stdout,
// and asserts: (1) collapsed arms print the exact BAML one-liner and nothing
// else, (2) expanded arms route through the markdown path with ids/counts/
// headers intact, (3) skill user messages ride along in both arms.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const printers = await import(join(ROOT, "..", "dist", "src", "summary-blocks.js"));
const { printBranchSummary, printCompactionSummary, printSkillBlock } = printers;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

process.env.BI_SCREEN = "0"; // printers' expanded arm takes the deterministic pipe path.
const capture = async (fn) => {
	const lines = [];
	const orig = console.log;
	console.log = (s) => lines.push(String(s));
	try {
		const shaped = await fn();
		return { lines, shaped };
	} finally {
		console.log = orig;
	}
};

// (1) collapsed arms print the BAML one-liner.
const b = await capture(() => printBranchSummary({ summary: "kept the plan", fromId: "s1", newId: "s2", keptMessages: 12, theme: null }));
check(b.shaped === "[branch] s2 from s1 · 12 messages (enter to expand)", `branch collapsed shapes (${b.shaped})`);
check(b.lines.length === 1 && b.lines[0] === b.shaped, "branch collapsed prints exactly one line");

const c = await capture(() => printCompactionSummary({ summary: "did stuff", tokensBefore: 48000, tokensAfter: 12000, foldedTurns: 7, theme: null }));
check(c.shaped === "[compaction] compacted 48000→12000 tokens · 7 turns folded · 36000 reclaimed (enter to expand)", `compaction collapsed shapes (${c.shaped})`);
check(c.lines.length === 1 && c.lines[0] === c.shaped, "compaction collapsed prints exactly one line");

const s = await capture(() => printSkillBlock({ name: "review", content: "look closely", theme: null }));
check(s.shaped === "[skill] review (enter to expand)", `skill collapsed shapes (${s.shaped})`);
check(s.lines.length === 1, "skill collapsed prints exactly one line");

// (2) expanded arms route through markdown with block contents intact.
const be = await capture(() => printBranchSummary({ summary: "kept the plan", fromId: "s1", newId: "s2", keptMessages: 12, expanded: true, theme: null }));
check(be.lines.join("\n").includes("Branch Summary") && be.lines.join("\n").includes("kept the plan"), "branch expanded keeps header + body");
check(be.lines.join("\n").includes("s2 from s1"), "branch expanded keeps both ids");

const ce = await capture(() => printCompactionSummary({ summary: "did stuff", tokensBefore: 48000, tokensAfter: 12000, foldedTurns: 7, expanded: true, theme: null }));
check(ce.lines.join("\n").includes("48000") && ce.lines.join("\n").includes("did stuff"), "compaction expanded keeps tokens + body");
check(ce.lines.join("\n").includes("36000 reclaimed"), "compaction expanded names reclaimed tokens");

const se = await capture(() => printSkillBlock({ name: "review", content: "look closely", expanded: true, theme: null }));
check(se.lines.join("\n").includes("review") && se.lines.join("\n").includes("look closely"), "skill expanded keeps name + content");

// (3) trailing user message rides along in both arms.
const su = await capture(() => printSkillBlock({ name: "review", content: "look", userMessage: "now do it", theme: null }));
check(su.shaped.endsWith("\nnow do it"), "skill collapsed keeps the user message");
const sue = await capture(() => printSkillBlock({ name: "review", content: "look", userMessage: "now do it", expanded: true, theme: null }));
check(sue.lines.join("\n").includes("now do it"), "skill expanded keeps the user message");

if (failures) process.exit(1);
console.log("summary-blocks: all green");
