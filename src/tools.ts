// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec host wrapper.
// BAML owns the plain-data spec (ListTools/GetTool), TS host owns executors
// (actual read/write/bash + bais_*). This mirrors bi's ToolSpec handling (limitation 4).

import { GetTool_async, ListTools_async, render_tool_diff_async, type ToolSpec } from "../baml_sdk/index.js";
import { checkBaisIssues, createBaisIssue, graphBaisIssues, loadBaisIssues, moveBaisIssue, readyBaisIssues } from "./bais.js";

export type { ToolSpec } from "../baml_sdk/index.js";

export async function listTools(): Promise<ToolSpec[]> {
	return ListTools_async();
}

export async function getTool(name: string): Promise<ToolSpec | null> {
	return GetTool_async(name);
}

// bi#71: transcript shaping for edit/write tool results. The host passes
// bytes through: it parses the {path, before, after} envelope the tool
// output carries (or nulls when absent) and BAML decides diffable + shapes
// the lines. Non-diffable payloads yield no lines — the transcript keeps
// today's start/done lines byte-identical (raw fallback = unchanged).
export interface ShapedToolResult {
	diffable: boolean;
	lines: string[];
}

// Envelope parse is byte work, host-side by contract: the object must
// carry all three fields as strings. Binary sides (NUL) are rejected here
// so BAML never sees binary; BAML owns every shaping decision past this.
function parseDiffEnvelope(output: string): { path: string; before: string; after: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const r = parsed as Record<string, unknown>;
	if (typeof r.path !== "string" || typeof r.before !== "string" || typeof r.after !== "string") return null;
	if (r.before.includes(String.fromCharCode(0)) || r.after.includes(String.fromCharCode(0))) return null;
	return { path: r.path, before: r.before, after: r.after };
}

export async function shapeToolResult(name: string, output: string): Promise<ShapedToolResult> {
	const env = parseDiffEnvelope(output);
	const view = await render_tool_diff_async(name, env?.path ?? null, env?.before ?? null, env?.after ?? null);
	return { diffable: view.diffable, lines: [...view.lines] };
}

// The transcript call after a tool success: print the shaped diff lines,
// and nothing at all unless BAML deems the payload diffable (failures and
// plain output keep today's lines byte-identical).
export async function emitToolDiff(name: string, output: string): Promise<void> {
	const shaped = await shapeToolResult(name, output);
	if (shaped.diffable) for (const l of shaped.lines) console.log(l);
}

// BAML is spec, host is executor — dispatch table for the agent loop.
// pi's built-in tools (read/write/edit/bash/ls/grep/find) get host impls
// elsewhere; bais_* tools are first-class here so the LLM can manage .bais.
export async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
	// self-adjust telemetry → BAIS: sub-agent patterns become issues
	if (name === "report_subagent_timeout") {
		const directive = String(args.directive ?? "unknown directive");
		const duration_ms = Number(args.duration_ms ?? 0);
		const timeout_ms = Number(args.timeout_ms ?? 0);
		const area = (args.area as string | undefined) ?? "agent/subagent";
		const file = await createBaisIssue({
			title: `Sub-agent timeout: ${directive} (${duration_ms}ms >= ${timeout_ms}ms)`,
			kind: "Flake",
			area,
			body: `Self-adjust report from Bi.\n\nDirective: ${directive}\nDuration: ${duration_ms}ms\nTimeout: ${timeout_ms}ms\n\nPattern: sub-agent timed out before completing. Consider increasing timeout or splitting directive. Repro: run Bi sub-agent with directive above, observe timeout. Acceptance: timeout raised or directive chunked, no timeout on retry.\n\nCreated via \`report_subagent_timeout\` tool.`,
		});
		return JSON.stringify(file, null, 2);
	}
	if (name === "report_reconcile_conflict") {
		const conflict_count = Number(args.conflict_count ?? 0);
		const files = (args.files as string[] | undefined) ?? [];
		const area = (args.area as string | undefined) ?? "agent/reconcile";
		const file = await createBaisIssue({
			title: `Reconcile conflicts: ${conflict_count} files`,
			kind: "Flake",
			area,
			body: `Self-adjust report from Bi.\n\nConflicts: ${conflict_count}\nFiles: ${files.join(", ") || "(unknown)"}\n\nPattern: parallel sub-agents produced conflicting edits. Consider tightening file ownership or reconcile strategy. Acceptance: re-run with isolated worktrees / clearer directive, no conflicts.\n\nCreated via \`report_reconcile_conflict\` tool.`,
		});
		return JSON.stringify(file, null, 2);
	}
	switch (name) {
		case "bais_list": {
			const status = (args.status as string | undefined) ?? null;
			const { issues, failures } = await loadBaisIssues();
			const filtered = status ? issues.filter((f) => f.issue.status === status) : issues;
			// `unparseable` is always present, even when empty: a tool that silently
			// omits files teaches the model the list is complete when it is not.
			return JSON.stringify({ issues: filtered, unparseable: failures }, null, 2);
		}
		case "bais_ready": {
			const files = await readyBaisIssues();
			return JSON.stringify(files, null, 2);
		}
		case "bais_new": {
			const title = String(args.title ?? "");
			if (!title) throw new Error("bais_new requires title");
			const file = await createBaisIssue({
				title,
				kind: (args.kind as string | undefined) ?? "Feat",
				area: (args.area as string | undefined) ?? undefined,
				body: (args.body as string | undefined) ?? undefined,
				status: (args.status as string | undefined) ?? "Open",
			});
			return JSON.stringify(file, null, 2);
		}
		case "bais_move": {
			const id = String(args.id ?? "");
			const status = String(args.status ?? "");
			if (!id || !status) throw new Error("bais_move requires id and status");
			const file = await moveBaisIssue(id, status);
			return JSON.stringify(file, null, 2);
		}
		case "bais_check": {
			const res = await checkBaisIssues();
			return JSON.stringify(res, null, 2);
		}
		case "bais_graph": {
			const from = String(args.from ?? "");
			if (!from) throw new Error("bais_graph requires from");
			const files = await graphBaisIssues(from);
			return JSON.stringify(files, null, 2);
		}
		default:
			throw new Error(`unknown tool ${name} — bais_* tools handled here, others need host impl`);
	}
}
