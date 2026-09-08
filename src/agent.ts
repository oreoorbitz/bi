// Minimal pi/packages/agent loop port — TS host drives BAML LLM calls and
// tool dispatch (limitation 4). This is the tracer bullet for the CLI's
// agent: it loops SendTurn -> ToolUse -> ToolCompleted until Complete.

import { CreateMixedTurn_async, CreateTextTurn_async, CreateToolUseTurn_async, TurnFailure, ai } from "../baml_sdk/index.js";
import { resolveAuth } from "./auth.js";
import { GetModel_async, RefreshModels_async, thinking_config_for_level_async, ModelSupportsReasoning_async } from "../baml_sdk/index.js";
import { toHistory, splitMediaTurns, type ConversationTurn } from "./conversation.js";
import { maybeCompactHistory, type CompactionOptions } from "./compaction.js";
import { SendTurn_async, SendTurnWithImage_async, SendTurnWithMedia_async, ModelSupportsImage_async, MediaSpec } from "../baml_sdk/index.js";
import { toToolSpecs, type ToolSpec } from "./conversation.js";
import { callWithRetry } from "./retry.js";
import type { NotificationDrain } from "./notify.js";
import type { LeaseDrain } from "./keeper.js";

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;
export type { ToolSpec } from "./conversation.js";

export interface AgentTurn {
	turn: ai.ModelTurn;
	toolResults: { id: string; name: string; output: string }[];
}

export interface AgentResult {
	messages: ConversationTurn[];
	turns: AgentTurn[];
	failure?: TurnFailure;
}

export interface AgentOptions {
	model: string;
	provider?: string; // "anthropic" | "openai_responses" | "google" — default anthropic
	apiKey?: string | null;
	baseUrl?: string | null;
	temperature?: number | null;
	// bi#28: thinking level name ("off"|"minimal"|...|"max") or null for
	// unset. Resolves to an anthropic ThinkingConfig per turn; other APIs
	// ignore it (turn.baml only wires thinking on anthropic-messages).
	thinkingLevel?: string | null;
	maxTurns?: number;
	// bi#44: host-owned hub notifications. The subscriber (notify.ts) fills
	// the queue in the background; the loop drains it between turns as
	// prompt context. Host-issued HTTP only — the LLM never polls.
	notify?: NotificationDrain;
	// bi#43: host-owned lease-keeper. The keeper (keeper.ts) renews in
	// the background; the loop only observes. A lost lease stops the
	// run with a named `lease_lost` failure — the LLM never renews.
	keeper?: LeaseDrain;
	azureResource?: string | null;
	azureDeployment?: string | null;
	azureApiVersion?: string | null;
}

// For testing without network — inject a fake LLM that returns canned turns.
// In production, streamFn is SendTurn via the provider.
export type LlmFn = (
	text: string,
	history: ConversationTurn[],
	tools: ToolSpec[],
) => Promise<ai.ModelTurn | TurnFailure>;

function defaultLlmFn(options: AgentOptions): LlmFn {
	return async (text, history, tools) => {
		const provider = options.provider ?? "anthropic";
		const resolved = await resolveAuth(provider, options.apiKey);
		if ("failure" in resolved) return resolved.failure;
		const auth = resolved.auth;
		// bi#06: image blocks cannot sit in host history — a host-held
		// Media re-enters the VM as the ai.MediaPart union alias and fails
		// inbound validation (proposal 10). Split them into plain specs;
		// media-free history converts as before.
		const split = splitMediaTurns(history);
		const h = await toHistory(split.history);
		const t = toToolSpecs(tools);
		// bi#28: thinking only reaches models that reason — a budget on a
		// non-reasoning model would 400, so the BAML guard decides.
		let thinking: any = null;
		if (options.thinkingLevel && options.thinkingLevel !== "off") {
			if (await ModelSupportsReasoning_async(options.model)) {
				thinking = await thinking_config_for_level_async(options.thinkingLevel);
			}
		} else if (options.thinkingLevel === "off") {
			thinking = await thinking_config_for_level_async("off");
		}
		// Retry at the dispatch choke point (bi#16) — the per-provider
		// send/stream fns wrap their own calls too, but every agent turn
		// flows through here.
		if (split.media.length === 0) {
			return callWithRetry(provider, () =>
				SendTurn_async(provider, options.model, auth.key, text, h, t, {
					base_url: options.baseUrl ?? null,
					temperature: options.temperature ?? null,
					thinking,
					azure_resource: options.azureResource ?? null,
					azure_deployment: options.azureDeployment ?? null,
					azure_api_version: options.azureApiVersion ?? null,
				}),
			);
		}
		const specs = split.media.map(
			(m) => new MediaSpec({ source: m.source, data: m.data, mime_type: m.mimeType ?? null }),
		);
		return callWithRetry(provider, () =>
			SendTurnWithMedia_async(provider, options.model, auth.key, text, h, specs, t, {
				media_client_id: split.mediaClientId,
				base_url: options.baseUrl ?? null,
				temperature: options.temperature ?? null,
				thinking,
				azure_resource: options.azureResource ?? null,
				azure_deployment: options.azureDeployment ?? null,
				azure_api_version: options.azureApiVersion ?? null,
			}),
		);
	};
}

export interface ImageTurnOptions {
	provider?: string;
	model?: string;
	apiKey?: string | null;
	baseUrl?: string | null;
	temperature?: number | null;
	thinkingLevel?: string | null;
	imageBase64: string;
	imageMime: string;
}

// bi#32: single-shot image turn for pasted clipboard images. Mirrors
// defaultLlmFn's auth + thinking guards; the SendTurnWithImage wire
// carries no tools and no prior history by construction, so image turns
// get answers, not agency. Consumed one image per turn by the caller.
export async function runSingleImageTurn(
	prompt: string,
	options: ImageTurnOptions,
): Promise<{ text: string } | { failure: TurnFailure }> {
	const provider = options.provider ?? "anthropic";
	const model = options.model ?? "claude-haiku-4-5";
	const resolved = await resolveAuth(provider, options.apiKey);
	if ("failure" in resolved) return { failure: resolved.failure };
	if (!(await ModelSupportsImage_async(model))) {
		return {
			failure: new TurnFailure({ kind: "invalid_argument", message: `model "${model}" doesn't take image parts — switch to one that does (bare /model lists inputs)`, retry_safe: false }),
		};
	}
	let thinking: any = null;
	if (options.thinkingLevel && options.thinkingLevel !== "off") {
		if (await ModelSupportsReasoning_async(model)) {
			thinking = await thinking_config_for_level_async(options.thinkingLevel);
		}
	} else if (options.thinkingLevel === "off") {
		thinking = await thinking_config_for_level_async("off");
	}
	const res = await callWithRetry(provider, () =>
		SendTurnWithImage_async(provider, model, resolved.auth.key, prompt, options.imageBase64, options.imageMime, {
			base_url: options.baseUrl ?? null,
			temperature: options.temperature ?? null,
			thinking,
		}),
	);
	if (res instanceof TurnFailure) return { failure: res };
	return { text: res.terminal_text() ?? "" };
}

export async function runAgent(
	prompt: string,
	options: AgentOptions & { tools?: ToolSpec[]; toolHandler?: ToolHandler; history?: ConversationTurn[]; llmFn?: LlmFn; compaction?: CompactionOptions; onAssistantText?: (text: string, turnIndex: number) => void | Promise<void> },
): Promise<AgentResult> {
	// Wire to Provider/Models refresh — mirrors pi's `await models.refreshModels({allowNetwork:false})`
	// that validates the provider/model before the first turn. For bi's static catalog this
	// is a no-op (returns bool), but it still proves the wiring and surfaces unknown provider/model.
	if (options.provider) {
		const known = await RefreshModels_async(options.provider);
		if (!known) {
			return {
				messages: options.history ?? [],
				turns: [],
				failure: new TurnFailure({ kind: "invalid_argument", message: `unknown provider: ${options.provider}`, retry_safe: false }),
			};
		}
	}
	if (options.model) {
		const model = await GetModel_async(options.model);
		if (!model) {
			return {
				messages: options.history ?? [],
				turns: [],
				failure: new TurnFailure({ kind: "invalid_argument", message: `unknown model: ${options.model}`, retry_safe: false }),
			};
		}
	}
	const tools = options.tools ?? [];
	const handler = options.toolHandler ?? (async (name) => `tool ${name} output`);
	const llmFn = options.llmFn ?? defaultLlmFn(options);
	let history: ConversationTurn[] = [...(options.history ?? [])];
	const turns: AgentTurn[] = [];
	let currentText = prompt;
	let maxTurns = options.maxTurns ?? 5;
	// bi#11: mid-run compaction. The summarizer reuses this run's llmFn (same
	// creds); a failed summary skips the splice — history is never truncated
	// without a summary to preserve the active goal.
	const summarize = async (summaryPrompt: string): Promise<string> => {
		const res = await llmFn(summaryPrompt, [], []);
		if (res instanceof TurnFailure) throw new Error(`compaction summary failed: ${res.kind} ${res.message}`);
		return res.terminal_text() ?? "";
	};
	const maybeCompact = async (): Promise<void> => {
		try {
			const out = await maybeCompactHistory(history, summarize, options.compaction);
			history = out.messages;
		} catch {
			// Summarizer failed — continue uncompacted rather than lose history.
		}
	};

	for (let turn = 0; turn < maxTurns; turn += 1) {
		// bi#43: a revoked/expired lease stops the run with a named
		// error — checked before any LLM call, every turn.
		const leaseLost = options.keeper?.leaseError() ?? null;
		if (leaseLost) {
			return {
				messages: history,
				turns,
				failure: new TurnFailure({ kind: "lease_lost", message: leaseLost.message, retry_safe: false }),
			};
		}
		// bi#44: drain pending hub notifications between turns — queued
		// lines become prompt context for this turn's LLM call.
		const notices = options.notify?.drainContext() ?? null;
		if (notices) currentText = currentText ? `${currentText}\n\n${notices}` : notices;
		// eslint-disable-next-line no-await-in-loop
		const result = await llmFn(currentText, history, tools);
		if (result instanceof TurnFailure) {
			return { messages: history, turns, failure: result };
		}
		const toolUses = result.tool_uses();
		if (toolUses.length === 0) {
			// Complete — add final assistant message with text
			const text = result.terminal_text() ?? "";
			history = [...history, { role: "assistant", text, clientId: `${options.provider ?? "anthropic"}/${options.model}` }];
			// bi#168: surface per-turn text while the loop still runs so
			// the REPL can stream it; awaited to keep tool start/done
			// line ordering deterministic.
			if (text) await options.onAssistantText?.(text, turns.length);
			turns.push({ turn: result, toolResults: [] });
			await maybeCompact();
			return { messages: history, turns };
		}
		// ToolUse — add assistant turn with tool calls (preserve text if any)
		const text = result.terminal_text() ?? "";
		const assistantContent: any[] = [];
		if (text) assistantContent.push({ type: "text", text });
		for (const tu of toolUses) {
			assistantContent.push({ type: "toolUse", id: tu.id, name: tu.name, args: tu.args });
		}
		// For host history, we use the content array shape
		const assistantTurn: ConversationTurn =
			assistantContent.length === 1 && assistantContent[0].type === "text"
				? { role: "assistant", text, clientId: `${options.provider ?? "anthropic"}/${options.model}` }
				: { role: "assistant", content: assistantContent, clientId: `${options.provider ?? "anthropic"}/${options.model}` };
		history = [...history, assistantTurn];
		// bi#168: tool-use turns carry visible text too — stream it in
		// loop order, before the tool start/done lines below.
		if (text) await options.onAssistantText?.(text, turns.length);

		// Execute tools
		const toolResults: { id: string; name: string; output: string }[] = [];
		for (const tu of toolUses) {
			// eslint-disable-next-line no-await-in-loop
			const output = await handler(tu.name, tu.args as Record<string, unknown>);
			toolResults.push({ id: tu.id, name: tu.name, output });
			history = [...history, { role: "toolResult", toolCallId: tu.id, toolName: tu.name, content: output, isError: false }];
		}
		turns.push({ turn: result, toolResults });
		// Next prompt is empty — continuation from tool results
		currentText = "";
		await maybeCompact();
		if (turn === maxTurns - 1) {
			return { messages: history, turns };
		}
	}
	return { messages: history, turns };
}

// Test helpers — create canned turns without network
export async function createTextTurn(text: string): Promise<ai.ModelTurn> {
	return CreateTextTurn_async(text);
}

export async function createToolUseTurn(toolName: string, toolId: string, args: Record<string, unknown>): Promise<ai.ModelTurn> {
	return CreateToolUseTurn_async(toolName, toolId, args);
}
