// bi/src/compaction.ts — host side of session compaction (bi#11).
//
// Split per bi's rule: BAML (compaction.baml) owns the DECISION —
// should_compact trigger, find_cut_index, summary schema + prompt spec.
// This file owns MEASUREMENT (per-turn token estimates over
// ConversationTurn, mirroring pi's chars/4 heuristic) and EXECUTION
// (history splice; the summarization LLM call is injected so tests stay
// offline). Wired into runAgent's turn loop — a long session compacts and
// continues without losing the active goal.

import {
	default_compaction_settings_async,
	find_cut_index_async,
	format_compaction_marker_async,
	parse_compaction_marker,
	should_compact_async,
	summarize_prompt_async,
	type CompactionMarker,
} from "../baml_sdk/index.js";
import type { ConversationTurn } from "./conversation.js";
import { activeStatus } from "./status.js";
import { printCompactionSummary } from "./summary-blocks.js";

// bi#97: emission channel for the transcript block. Fired after a successful
// splice only — a failed summary aborts the splice, so no block is owed.
export interface CompactionEmit {
	summary: string;
	foldedTurns: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensReclaimed: number;
}

export interface CompactionOptions {
	enabled?: boolean;
	contextWindow?: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
	onCompacted?: (info: CompactionEmit) => void | Promise<void>;
}

const IMAGE_CHARS = 4800;

function charsOfToolResultContent(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return (content as any[]).reduce((n, p) => n + (p.type === "text" ? p.text.length : p.type === "image" ? IMAGE_CHARS : 0), 0);
}

// Mirror of pi's estimateTokens: conservative chars/4 per role. Images count
// as 4800 chars (pi's ESTIMATED_IMAGE_CHARS).
export function estimateTurnTokens(turn: ConversationTurn): number {
	let chars = 0;
	const t = turn as any;
	switch (t.role) {
		case "user":
			chars = t.text.length;
			break;
		case "assistant":
			if (typeof t.text === "string") chars += t.text.length;
			if (typeof t.reasoning === "string") chars += t.reasoning.length;
			for (const tc of t.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
			for (const b of t.content ?? []) {
				if (b.type === "text") chars += b.text.length;
				else if (b.type === "reasoning") chars += b.summary.length;
				else if (b.type === "toolUse") chars += b.name.length + JSON.stringify(b.args).length;
				else if (b.type === "image" || b.type === "imageUrl") chars += IMAGE_CHARS;
			}
			break;
		case "toolResult":
			chars = charsOfToolResultContent(t.content);
			break;
		case "toolRequested":
			chars = t.name.length + JSON.stringify(t.args).length;
			break;
		case "toolCompleted":
			chars = t.output.length;
			break;
		case "toolFailed":
			chars = t.message.length;
			break;
		default:
			chars = JSON.stringify(turn).length;
			break;
	}
	return Math.ceil(chars / 4);
}

export function estimateHistoryTokens(turns: readonly ConversationTurn[]): number {
	return turns.reduce((n, t) => n + estimateTurnTokens(t), 0);
}

function serializeTurn(turn: ConversationTurn): string {
	const t = turn as any;
	switch (t.role) {
		case "user":
			return `user: ${t.text}`;
		case "assistant":
			return `assistant: ${t.text ?? (t.content ?? []).map((b: any) => (b.type === "text" ? b.text : `[${b.type}${b.name ? ` ${b.name}` : ""}]`)).join(" ")}`;
		case "toolResult":
			return `toolResult ${t.toolName}: ${typeof t.content === "string" ? t.content.slice(0, 500) : "[structured]"}`;
		case "toolRequested":
			return `toolRequested ${t.name} ${JSON.stringify(t.args).slice(0, 500)}`;
		case "toolCompleted":
			return `toolCompleted ${t.output.slice(0, 500)}`;
		case "toolFailed":
			return `toolFailed ${t.message.slice(0, 500)}`;
		default:
			return JSON.stringify(turn).slice(0, 500);
	}
}

export interface Compacted {
	messages: ConversationTurn[];
	summary: string;
	cut: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensReclaimed: number;
}

// bi#205: pair-safe cut. find_cut_index counts tokens with no pair awareness,
// so a raw cut can start the tail mid-pair — an orphan toolResult /
// toolCompleted / toolFailed whose request was folded into the head. The
// OpenAI API fails the next turn closed with 400 (role: tool message with no
// matching assistant tool_calls); Anthropic tolerates it. Snap host-side
// before splicing: absorb leading result turns into the folded head (cut++),
// then pull back over trailing request turns whose pair sits at/after the cut
// (cut--) so pairs cross together or not at all. Both loops are bounded by
// the array ends. A dangling request (no result anywhere after it) does NOT
// pull back — it folds with the head, which is equally orphan-free.

// Request side: assistant toolCalls / content toolUse blocks (pi-shaped and
// content-array shapes), plus the legacy toolRequested turn.
function requestIdsOf(turn: ConversationTurn): string[] {
	const t = turn as any;
	if (turn.role === "assistant") {
		const ids: string[] = [];
		for (const tc of t.toolCalls ?? []) if (tc?.id != null) ids.push(tc.id);
		for (const b of t.content ?? []) if (b?.type === "toolUse" && b.id != null) ids.push(b.id);
		return ids;
	}
	if (turn.role === "toolRequested") return t.id != null ? [t.id] : [];
	return [];
}

// Result side: toolResult / toolCompleted / toolFailed turns.
function resultIdsOf(turn: ConversationTurn): string[] {
	const t = turn as any;
	if (turn.role === "toolResult") return t.toolCallId != null ? [t.toolCallId] : [];
	if (turn.role === "toolCompleted" || turn.role === "toolFailed") return t.id != null ? [t.id] : [];
	return [];
}

// True when the request turn at reqIdx has a matching result at/after c.
// Matches before c only (or no match anywhere — dangling) mean the pair is
// already together in the head, so no pull-back is owed.
function pairAtOrAfterCut(messages: readonly ConversationTurn[], reqIdx: number, c: number): boolean {
	const ids = requestIdsOf(messages[reqIdx]);
	for (let i = reqIdx + 1; i < messages.length; i++) {
		if (i >= c && resultIdsOf(messages[i]).some((r) => ids.includes(r))) return true;
	}
	return false;
}

export function snapCutToPairBoundary(messages: readonly ConversationTurn[], cut: number): number {
	let c = cut;
	while (c < messages.length && resultIdsOf(messages[c]).length > 0) c++;
	while (c > 0 && c <= messages.length && requestIdsOf(messages[c - 1]).length > 0 && pairAtOrAfterCut(messages, c - 1, c)) c--;
	return c;
}

// Splice history: summarize messages[0..cut], keep the rest. The summary goes
// back in as a user turn — bi has no system-entry channel, and pi likewise
// replays its summary as context content, not as a turn to answer. Returns
// null when nothing should be cut. Summarizer failures propagate: dropping
// history without a summary would lose the active goal, so a failed summary
// must abort the splice, never silently truncate.
export async function compactHistory(
	messages: ConversationTurn[],
	summarize: (prompt: string) => Promise<string>,
	opts?: CompactionOptions,
): Promise<Compacted | null> {
	const keep = opts?.keepRecentTokens ?? (await default_compaction_settings_async()).keep_recent_tokens;
	const sizes = messages.map(estimateTurnTokens);
	const cut = await find_cut_index_async(sizes, keep);
	if (cut <= 0 || cut >= messages.length) return null;
	// bi#205: snap to a pair-safe boundary before splicing. A snapped cut of
	// 0 folds nothing (same null as a raw 0); a snap to messages.length folds
	// the whole history — the tail was all orphan results, so folding it is
	// the only orphan-free move and the summary still carries the content.
	const safeCut = snapCutToPairBoundary(messages, cut);
	if (safeCut <= 0) return null;
	// bi#97: measure before the cut so the transcript block can name folded
	// turns and reclaimed tokens. The marker text is BAML-shaped
	// (format_compaction_marker) so the session file carries a parseable
	// record and /resume can replay the block.
	const tokensBefore = estimateHistoryTokens(messages);
	const head = messages.slice(0, safeCut).map(serializeTurn).join("\n");
	// bi#96: the summarization wait surfaces on the turn status (compaction
	// kind) where a display is active. This is the automatic threshold path
	// (maybeCompactHistory fired on token pressure). Working state restores
	// in finally so a summarize throw never leaks the compaction styling.
	activeStatus()?.showCompaction("threshold");
	let summary: string;
	try {
		summary = await summarize(await summarize_prompt_async(head));
	} finally {
		activeStatus()?.showWorking();
	}
	const spliced: ConversationTurn[] = [
		{ role: "user", text: "" },
		...messages.slice(safeCut),
	];
	(spliced[0] as { role: string; text: string }).text = await format_compaction_marker_async(safeCut, tokensBefore, 0, summary);
	const tokensAfter = estimateHistoryTokens(spliced);
	// Second pass stamps the true post-cut total — the marker names the
	// range the resumed session actually continues with.
	(spliced[0] as { role: string; text: string }).text = await format_compaction_marker_async(safeCut, tokensBefore, tokensAfter, summary);
	return {
		messages: spliced,
		summary,
		cut: safeCut,
		tokensBefore,
		tokensAfter,
		tokensReclaimed: Math.max(0, tokensBefore - tokensAfter),
	};
}

// One decision point for the loop: estimate, ask BAML, splice on trigger.
export async function maybeCompactHistory(
	messages: ConversationTurn[],
	summarize: (prompt: string) => Promise<string>,
	opts?: CompactionOptions,
): Promise<{ messages: ConversationTurn[]; compacted: boolean }> {
	if (opts?.enabled === false) return { messages, compacted: false };
	const defaults = await default_compaction_settings_async();
	const window = opts?.contextWindow ?? 200000;
	const reserve = opts?.reserveTokens ?? defaults.reserve_tokens;
	const total = estimateHistoryTokens(messages);
	const fire = await should_compact_async(total, window, opts?.enabled ?? defaults.enabled, reserve);
	if (!fire) return { messages, compacted: false };
	const out = await compactHistory(messages, summarize, {
		keepRecentTokens: opts?.keepRecentTokens ?? defaults.keep_recent_tokens,
	});
	if (!out) return { messages, compacted: false };
	// bi#97: every successful auto-compaction emits its transcript block with
	// folded-turn count and reclaimed tokens. Emission failures never break
	// the turn — the marker user-turn already persists the record.
	try {
		await opts?.onCompacted?.({
			summary: out.summary,
			foldedTurns: out.cut,
			tokensBefore: out.tokensBefore,
			tokensAfter: out.tokensAfter,
			tokensReclaimed: out.tokensReclaimed,
		});
	} catch (e) {
		console.error(`[bi] compaction block failed to print (${e instanceof Error ? e.message : e}) — summary kept in context`);
	}
	return { messages: out.messages, compacted: true };
}

// bi#97: /resume replay. The session file carries the marker user-turn, so a
// resumed transcript re-shows each compaction as its collapsed block (folded
// count + token range, shaped by BAML). Legacy markers (no token counts) and
// non-markers print nothing here — replay never invents numbers, and the
// entries themselves stay in history for /export either way.
export async function replayCompactionBlocks(
	history: readonly { role: string; text: string }[],
	theme?: string | null,
): Promise<void> {
	for (const m of history) {
		if (m.role !== "user" || typeof m.text !== "string") continue;
		let parsed: CompactionMarker | null;
		try {
			parsed = parse_compaction_marker(m.text);
		} catch {
			continue;
		}
		if (!parsed || parsed.tokens_before == null || parsed.tokens_after == null) continue;
		await printCompactionSummary({
			summary: parsed.summary,
			tokensBefore: parsed.tokens_before,
			tokensAfter: parsed.tokens_after,
			foldedTurns: parsed.folded_turns,
			theme: theme ?? null,
		});
	}
}
