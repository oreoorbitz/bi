// bi/scripts/compaction-blocks.mjs — compaction transcript-block conformance (bi#97).
// Drives the REAL host splice (dist/src/compaction.js) with a stub summarizer
// and asserts: (1) the splice leaves a BAML-parseable marker carrying folded
// turns + token range, (2) onCompacted fires once with consistent counts and
// never fires when nothing compacts, (3) /resume replay prints one collapsed
// block per new marker and nothing for legacy markers or plain turns,
// (4) a failed summary aborts the splice (never silently truncates).
//
// Red-check (bi#57): break the marker prefix in compaction.baml
// ("Session summary (compacted, " -> "Session summary (COMPACTED, ") and this
// suite must fail at "splice marker parses via BAML" — the replay path finds
// no markers. Restored green 2026-09-06.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const compaction = await import(join(ROOT, "..", "dist", "src", "compaction.js"));
const { parse_compaction_marker } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { compactHistory, maybeCompactHistory, replayCompactionBlocks, estimateHistoryTokens } = compaction;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

process.env.BI_SCREEN = "0"; // replay's collapsed arm takes the deterministic pipe path.
const capture = async (fn) => {
	const lines = [];
	const orig = console.log;
	console.log = (s) => lines.push(String(s));
	try {
		const out = await fn();
		return { lines, out };
	} finally {
		console.log = orig;
	}
};

const fat = (n, ch) => ({ role: "user", text: `${ch} `.repeat(n) });
const history = [fat(4000, "a"), fat(4000, "b"), fat(4000, "c"), { role: "assistant", text: "d ".repeat(4000) }];
const summarize = async () => "kept the plan";

// (1) splice leaves a parseable marker with folded turns + token range.
const out = await compactHistory([...history], summarize, { keepRecentTokens: 1500 });
check(out !== null, "fat history compacts");
check(out.cut > 0 && out.cut < history.length, `cut ${out?.cut} folds a head and keeps a tail`);
const marker = out.messages[0].text;
const parsed = parse_compaction_marker(marker);
check(parsed !== null, "splice marker parses via BAML");
check(parsed?.folded_turns === out.cut, `marker folds ${parsed?.folded_turns} === cut ${out.cut}`);
check(parsed?.tokens_before === out.tokensBefore && parsed?.tokens_after === out.tokensAfter, "marker token range matches measured totals");
check(out.tokensBefore > out.tokensAfter, `tokens drop ${out.tokensBefore} → ${out.tokensAfter}`);
check(out.tokensReclaimed === out.tokensBefore - out.tokensAfter, `reclaimed ${out.tokensReclaimed} is before minus after`);
check(parsed?.summary === "kept the plan", "marker keeps the summary body");
check(out.messages.length === history.length - out.cut + 1, "splice keeps every post-cut turn");

// (2) emission channel fires once on compaction, never on no-op.
let fired = [];
const big = await maybeCompactHistory([...history], summarize, { enabled: true, contextWindow: 2000, reserveTokens: 100, keepRecentTokens: 1500, onCompacted: (i) => fired.push(i) });
check(big.compacted === true, "threshold path compacts under pressure");
check(fired.length === 1, "onCompacted fires exactly once");
check(fired[0]?.foldedTurns > 0 && big.messages.length === history.length - fired[0]?.foldedTurns + 1, `emission names folded turns (${fired[0]?.foldedTurns})`);
check(fired[0]?.tokensReclaimed === fired[0]?.tokensBefore - fired[0]?.tokensAfter, "emission reclaimed is consistent");
let quiet = 0;
const small = await maybeCompactHistory([{ role: "user", text: "hi" }], summarize, { enabled: true, contextWindow: 200000, reserveTokens: 100, onCompacted: () => quiet++ });
check(small.compacted === false && quiet === 0, "no compaction compacts nothing and emits nothing");

// (3) replay prints one collapsed block per new marker, skips the rest.
const legacy = "Session summary (compacted, 7 earlier turns folded in):\ndid stuff";
const mixed = [
	{ role: "user", text: marker },
	{ role: "user", text: legacy },
	{ role: "user", text: "plain question" },
	{ role: "assistant", text: marker },
];
const rep = await capture(() => replayCompactionBlocks(mixed, null));
check(rep.lines.length === 1, `replay prints exactly one block (${rep.lines.length})`);
check(rep.lines[0]?.startsWith("[compaction]") === true, `replay block is the collapsed compaction line (${rep.lines[0]})`);
check(rep.lines[0]?.includes(`${out.cut} turns folded`) === true, "replay block names the folded-turn count");
check(rep.lines[0]?.includes(`${out.tokensReclaimed} reclaimed`) === true, "replay block names reclaimed tokens");
check(rep.lines[0]?.includes("enter to expand") === true, "replay block carries the expand hint");

// (4) summarizer failure aborts — history never truncates without a summary.
let threw = false;
try {
	await compactHistory([...history], async () => { throw new Error("llm down"); }, { keepRecentTokens: 1500 });
} catch {
	threw = true;
}
check(threw, "failed summary throws instead of splicing");

// estimateHistoryTokens stays the blocks' measuring stick.
check(estimateHistoryTokens(history) === out.tokensBefore, "tokensBefore equals the pre-cut estimate");

if (failures) process.exit(1);
console.log("compaction-blocks: all green");
