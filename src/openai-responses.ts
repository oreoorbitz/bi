// Thin TS host wrapper around the generated baml_sdk, mirroring the shape of
// pi/packages/ai's src/api/openai-responses.ts. Same structure as
// anthropic.ts — see that file's header for the current known gaps and the
// reason SendTurn/StreamTurn take a plain string `provider` tag and
// plain-data `ToolSpec[]`, and return `ai.ModelTurn | TurnFailure` instead
// of a client/tool object or a thrown error.

import { SendTurn_async, StreamTurn_async, type TurnFailure, ai } from "../baml_sdk/index.js";
import { toHistory, toToolSpecs, type ConversationTurn, type ToolSpec } from "./conversation.js";
import { callWithRetry } from "./retry.js";
import { missingKeyFailure } from "./auth.js";

const PROVIDER = "openai_responses";

export interface OpenAIResponsesCallOptions {
	model: string;
	apiKey: string | null;
	baseUrl?: string | null;
	history?: readonly ConversationTurn[];
	tools?: readonly ToolSpec[];
	temperature?: number | null;
}

export async function sendOpenAIResponsesMessage(
	text: string,
	options: OpenAIResponsesCallOptions,
): Promise<ai.ModelTurn | TurnFailure> {
	const authErr = await missingKeyFailure(PROVIDER, options.apiKey);
	if (authErr) return authErr;
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	return callWithRetry("openai-responses", () => SendTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
	}));
}

export async function streamOpenAIResponsesMessage(
	text: string,
	options: OpenAIResponsesCallOptions,
): Promise<ai.ModelTurn | TurnFailure> {
	const authErr = await missingKeyFailure(PROVIDER, options.apiKey);
	if (authErr) return authErr;
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	return callWithRetry("openai-responses", () => StreamTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
	}));
}
