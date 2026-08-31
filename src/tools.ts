// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec host wrapper.
// BAML owns the plain-data spec (ListTools/GetTool), TS host owns executors
// (actual read/write/bash + bais_*). This mirrors bi's ToolSpec handling (limitation 4).

import { GetTool_async, ListTools_async, type ToolSpec } from "../baml_sdk/index.js";
import { checkBaisIssues, createBaisIssue, graphBaisIssues, listBaisIssues, moveBaisIssue, readyBaisIssues } from "./bais.js";

export type { ToolSpec } from "../baml_sdk/index.js";

export async function listTools(): Promise<ToolSpec[]> {
	return ListTools_async();
}

export async function getTool(name: string): Promise<ToolSpec | null> {
	return GetTool_async(name);
}

// BAML is spec, host is executor — dispatch table for the agent loop.
// pi's built-in tools (read/write/edit/bash/ls/grep/find) get host impls
// elsewhere; bais_* tools are first-class here so the LLM can manage .bais.
export async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "bais_list": {
			const status = (args.status as string | undefined) ?? null;
			const files = await listBaisIssues();
			const filtered = status ? files.filter((f) => f.issue.status === status) : files;
			return JSON.stringify(filtered, null, 2);
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
