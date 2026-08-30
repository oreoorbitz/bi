// Thin TS host wrapper around the generated baml_sdk, mirroring the shape of
// pi/packages/ai's src/api/anthropic-messages.ts. BAML owns the actual wire
// protocol (anthropic.AnthropicClient); this module just adapts pi-shaped
// call sites onto the generated functions.
//
// SendTurn/StreamTurn take a plain string `provider` tag and plain-data
// `ToolSpec[]` rather than a pre-built client/tool object or a BAML enum,
// and return `ai.ModelTurn | TurnFailure` rather than throwing on a
// provider-classified failure — see turn.baml's header comment for the four
// toolchain limitations (interface round-trip on args, enum argument
// encoding, thrown-interface decode, tool-handle round-trip) that shaped
// this. Use `result instanceof TurnFailure` to discriminate.
//
// Temperature and thinking are now plumbed through to
// anthropic.AnthropicClient (see turn.baml build_client). Other gaps
// (cache control, top_p/top_k, stop_sequences) remain for later slices.
// StreamTurn still drains internally; incremental is via StartTurnStream /
// StartIncrementalStream (BamlStream) in incremental.ts / google.ts.

import { SendTurn_async, StreamTurn_async, type TurnFailure, ai } from "../baml_sdk/index.js";
import { vendor } from "../baml_sdk/index.js";
import { toHistory, toToolSpecs, type ConversationTurn, type ToolSpec } from "./conversation.js";

const PROVIDER = "anthropic";

export type AnthropicThinking =
	| { type: "enabled"; budgetTokens?: number }
	| { type: "disabled" };

export interface AnthropicCallOptions {
	model: string;
	apiKey: string | null;
	baseUrl?: string | null;
	history?: readonly ConversationTurn[];
	tools?: readonly ToolSpec[];
	temperature?: number | null;
	thinking?: AnthropicThinking | null;
}

async function toThinkingConfig(thinking: AnthropicThinking | null | undefined): Promise<any | null> {
	if (!thinking) return null;
	if (thinking.type === "disabled") {
		return vendor.anthropic.ThinkingConfig.disabled();
	}
	// enabled — budget defaults to 1024 like pi's AnthropicOptions
	const budget = (thinking as any).budgetTokens ?? 1024;
	return vendor.anthropic.ThinkingConfig.enabled(budget);
}

export async function sendAnthropicMessage(
	text: string,
	options: AnthropicCallOptions,
): Promise<ai.ModelTurn | TurnFailure> {
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	const thinking = await toThinkingConfig(options.thinking ?? null);
	return SendTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
		thinking,
	});
}

export async function streamAnthropicMessage(
	text: string,
	options: AnthropicCallOptions,
): Promise<ai.ModelTurn | TurnFailure> {
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	const thinking = await toThinkingConfig(options.thinking ?? null);
	return StreamTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
		thinking,
	});
}
