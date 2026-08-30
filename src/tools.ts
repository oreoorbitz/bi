// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec host wrapper.
// BAML owns the plain-data spec (ListTools/GetTool), TS host owns executors
// (actual read/write/bash). This mirrors bi's ToolSpec handling (limitation 4).

import { GetTool_async, ListTools_async, type ToolSpec } from "../baml_sdk/index.js";

export type { ToolSpec } from "../baml_sdk/index.js";

export async function listTools(): Promise<ToolSpec[]> {
	return ListTools_async();
}

export async function getTool(name: string): Promise<ToolSpec | null> {
	return GetTool_async(name);
}
