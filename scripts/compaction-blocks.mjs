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

// (5) bi#205: compaction never orphans tool pairs (OpenAI 400 predicate).
// compactHistory cut by token count with no pair awareness, so a raw cut
// could start the tail mid-pair — an orphan role:tool whose request was
// folded. OpenAI fails the next turn closed with 400; Anthropic tolerates
// it. The snap in compaction.ts absorbs leading results into the head
// (cut++) and pulls back over trailing requests (cut--).
//
// Red-check (bi#57): remove the snapCutToPairBoundary call in
// compactHistory (use the raw BAML cut) and this suite must fail naming the
// orphan — "straddle tail: orphan tool_call_id 'call_straddle1'". Restored green 2026-09-09.
const { snapCutToPairBoundary } = compaction;
const { find_cut_index_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

const toolReq = (id) => ({ role: "assistant", content: [{ type: "toolUse", id, name: "read", args: { path: "a" } }], clientId: "test" });
const toolRes = (id, n = 400) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: "y".repeat(n), isError: false });

// The exact 400 predicate at the OpenAI payload shape: every role:tool
// tool_call_id has a matching assistant tool_calls id, and every assistant
// tool_calls id has its tool result in the tail.
const openAIPairs = (tail) => {
	const assistantIds = [];
	const toolIds = [];
	for (const t of tail) {
		if (t.role === "assistant") {
			for (const tc of t.toolCalls ?? []) assistantIds.push(tc.id);
			for (const b of t.content ?? []) if (b?.type === "toolUse") assistantIds.push(b.id);
		}
		if (t.role === "toolResult") toolIds.push(t.toolCallId);
		if (t.role === "toolCompleted" || t.role === "toolFailed") toolIds.push(t.id);
		if (t.role === "toolRequested") assistantIds.push(t.id);
	}
	return { assistantIds, toolIds };
};
const assertPairSafe = (tail, label) => {
	const { assistantIds, toolIds } = openAIPairs(tail);
	for (const id of toolIds) check(assistantIds.includes(id), `${label}: orphan tool_call_id '${id}' has no matching assistant tool_calls — OpenAI would 400`);
	for (const id of assistantIds) check(toolIds.includes(id), `${label}: assistant tool_calls '${id}' has its tool result in the tail`);
};

// (5a) absorb: token cut lands between request and result (the live shape).
// sizes [2000,4,100,20], keep 50 → raw cut 2 (tail starts at the orphan).
const straddle = [fat(4000, "a"), toolReq("call_straddle1"), toolRes("call_straddle1"), { role: "user", text: "z ".repeat(40) }];
const straddleRaw = await find_cut_index_async(straddle.map((t) => { const c = compaction.estimateTurnTokens(t); return c; }), 50);
check(straddleRaw === 2, `raw BAML cut straddles the pair (cut ${straddleRaw} === 2)`);
const straddleOut = await compactHistory([...straddle], summarize, { keepRecentTokens: 50 });
check(straddleOut.cut === 3, `snap absorbs the orphan result (cut ${straddleOut?.cut} === 3)`);
check(straddleOut.messages.slice(1).length === 1 && straddleOut.messages.slice(1)[0].role === "user", "snapped tail keeps only the post-pair turn");
assertPairSafe(straddleOut.messages.slice(1), "straddle tail");
check(parse_compaction_marker(straddleOut.messages[0].text)?.folded_turns === 3, "marker folds the absorbed pair");

// (5b) absorb, legacy shapes: toolRequested/toolCompleted straddling the cut.
const legacyPair = [
	fat(4000, "a"),
	{ role: "toolRequested", id: "call_legacy1", name: "read", args: { path: "a" } },
	{ role: "toolCompleted", id: "call_legacy1", output: "y".repeat(400) },
	{ role: "user", text: "z ".repeat(40) },
];
const legacyOut = await compactHistory([...legacyPair], summarize, { keepRecentTokens: 50 });
check(legacyOut.cut === 3, `snap absorbs the legacy orphan result (cut ${legacyOut?.cut} === 3)`);
assertPairSafe(legacyOut.messages.slice(1), "legacy tail");

// (5c) pull-back: request separated from its result, cut between them.
// keep 130 → raw cut 2 (tail [uX, compA] would orphan call_pull1); snap
// pulls back over the request so the pair stays together in the tail.
const pull = [
	fat(4000, "a"),
	toolReq("call_pull1"),
	{ role: "user", text: "q ".repeat(40) },
	{ role: "toolCompleted", id: "call_pull1", output: "y".repeat(400) },
	{ role: "user", text: "z ".repeat(40) },
];
const pullOut = await compactHistory([...pull], summarize, { keepRecentTokens: 130 });
check(pullOut.cut === 1, `snap pulls back over the trailing request (cut ${pullOut?.cut} === 1)`);
check(pullOut.messages.slice(1)[0]?.role === "assistant", "pulled-back tail starts with the request turn");
assertPairSafe(pullOut.messages.slice(1), "pull-back tail");

// (5d) dangling request (no result anywhere) does NOT pull back — it folds
// with the head, which is equally orphan-free. keep 15 → raw cut 3 stays 3.
const dangle = [fat(4000, "a"), { role: "user", text: "q ".repeat(40) }, toolReq("call_dangle1"), { role: "user", text: "z ".repeat(40) }];
const dangleOut = await compactHistory([...dangle], summarize, { keepRecentTokens: 15 });
check(dangleOut.cut === 3, `dangling request folds with the head (cut ${dangleOut?.cut} === 3)`);
assertPairSafe(dangleOut.messages.slice(1), "dangle tail");

// (5e) boundary no-op: cut already lands on a pair boundary, snap is idle.
// [fat, req, res] keep 104 → raw cut 1 (tail [req, res] intact).
const aligned = [fat(4000, "a"), toolReq("call_aligned1"), toolRes("call_aligned1")];
const alignedOut = await compactHistory([...aligned], summarize, { keepRecentTokens: 104 });
check(alignedOut.cut === 1, `aligned cut is untouched (cut ${alignedOut?.cut} === 1)`);
assertPairSafe(alignedOut.messages.slice(1), "aligned tail");

// (5f) absorb-to-end: the whole keep window is orphan results — folding it
// all is the only orphan-free move. keep 150 → raw cut 2, snap to 4.
const runTail = [fat(4000, "a"), toolReq("call_run1"), toolRes("call_run1"), toolRes("call_run1")];
const runOut = await compactHistory([...runTail], summarize, { keepRecentTokens: 150 });
check(runOut.cut === 4, `orphan result run folds whole (cut ${runOut?.cut} === 4)`);
check(runOut.messages.length === 1, "fold-all leaves only the marker");
assertPairSafe(runOut.messages.slice(1), "fold-all tail");

// snapCutToPairBoundary is pure — direct pins independent of BAML numbers.
check(snapCutToPairBoundary(straddle, 2) === 3, "snap unit: straddle 2 → 3");
check(snapCutToPairBoundary(pull, 2) === 1, "snap unit: separated 2 → 1");
check(snapCutToPairBoundary(aligned, 1) === 1, "snap unit: aligned 1 → 1");

if (failures) process.exit(1);
console.log("compaction-blocks: all green");
