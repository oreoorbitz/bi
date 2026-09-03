// bi/src/events.ts — host side of run-mode events (bi#14).
//
// Split: BAML (events.baml) owns the RunEvent SCHEMA — layout via make_*
// constructors, rules via validate_event. This file owns BYTES: building
// the per-run sequence from an AgentResult and JSON.stringify-ing it.
// Every event passes BAML validate_event before serializing, so the
// schema stays single-sourced even though JSON itself is host-emitted.

import {
	make_assistant_text_async,
	make_run_end_async,
	make_run_failed_async,
	make_run_start_async,
	make_tool_call_async,
	make_tool_result_async,
	validate_event_async,
	type RunEvent,
} from "../baml_sdk/index.js";
import type { AgentResult } from "./agent.js";

// Final assistant text for --print: last assistant message wins, both
// message shapes (plain text and content blocks) covered.
export function finalText(result: AgentResult): string {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const m = result.messages[i] as any;
		if (m?.role !== "assistant") continue;
		if (typeof m.text === "string" && m.text) return m.text;
		if (Array.isArray(m.content)) {
			const t = m.content
				.filter((b: any) => b?.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n");
			if (t) return t;
		}
	}
	return "";
}

// One JSON object per agent event, in run order: run_start, then per turn
// assistant_text + tool_call/tool_result pairs, then run_end/run_failed.
// Throws if any event fails BAML validation — a schema violation is a bug,
// never silently emitted.
export async function runResultToJsonLines(result: AgentResult, provider: string, model: string): Promise<string[]> {
	const out: string[] = [];
	const push = async (e: RunEvent): Promise<void> => {
		if (!(await validate_event_async(e as any))) throw new Error(`invalid RunEvent: ${JSON.stringify(e)}`);
		out.push(JSON.stringify(e));
	};
	await push(await make_run_start_async(provider, model));
	let idx = 0;
	for (const t of result.turns) {
		const text = t.turn.terminal_text() ?? "";
		if (text) await push(await make_assistant_text_async(text, idx));
		for (const tu of t.turn.tool_uses()) {
			await push(await make_tool_call_async(tu.id, tu.name, JSON.stringify(tu.args), idx));
		}
		for (const r of t.toolResults) {
			await push(await make_tool_result_async(r.id, r.name, r.output, idx));
		}
		idx++;
	}
	if (result.failure) {
		await push(await make_run_failed_async(result.failure.kind, result.failure.message));
	} else {
		await push(await make_run_end_async(finalText(result)));
	}
	return out;
}
