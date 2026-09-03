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
	should_compact_async,
	summarize_prompt_async,
} from "../baml_sdk/index.js";
import type { ConversationTurn } from "./conversation.js";

export interface CompactionOptions {
	enabled?: boolean;
	contextWindow?: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
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
	const head = messages.slice(0, cut).map(serializeTurn).join("\n");
	const summary = await summarize(await summarize_prompt_async(head));
	return {
		messages: [{ role: "user", text: `Session summary (compacted, ${cut} earlier turns folded in):\n${summary}` }, ...messages.slice(cut)],
		summary,
		cut,
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
	return { messages: out.messages, compacted: true };
}
