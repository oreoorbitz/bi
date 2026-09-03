// Thin TS host wrapper for Google Gemini — mirrors anthropic.ts / openai-responses.ts.
// See those files' headers for the toolchain limitation context.

import { SendTurn_async, StreamTurn_async, StartIncrementalStream_async, TurnFailure, ai } from "../baml_sdk/index.js";
import { toHistory, toToolSpecs, type ConversationTurn, type ToolSpec } from "./conversation.js";
import { callWithRetry } from "./retry.js";
import { missingKeyFailure } from "./auth.js";

const PROVIDER = "google";

export interface GoogleCallOptions {
	model: string;
	apiKey: string | null;
	baseUrl?: string | null;
	history?: readonly ConversationTurn[];
	tools?: readonly ToolSpec[];
	temperature?: number | null;
}

export async function sendGoogleMessage(text: string, options: GoogleCallOptions): Promise<ai.ModelTurn | TurnFailure> {
	const authErr = await missingKeyFailure(PROVIDER, options.apiKey);
	if (authErr) return authErr;
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	return callWithRetry("google", () => SendTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
	}));
}

export async function streamGoogleMessage(text: string, options: GoogleCallOptions): Promise<ai.ModelTurn | TurnFailure> {
	const authErr = await missingKeyFailure(PROVIDER, options.apiKey);
	if (authErr) return authErr;
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	return callWithRetry("google", () => StreamTurn_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
	}));
}

export async function startGoogleIncremental(text: string, options: GoogleCallOptions): Promise<ai.stream.Stream<string, string> | TurnFailure> {
	const authErr = await missingKeyFailure(PROVIDER, options.apiKey);
	if (authErr) return authErr;
	const history = await toHistory(options.history ?? []);
	const tools = toToolSpecs(options.tools ?? []);
	const res = await StartIncrementalStream_async(PROVIDER, options.model, options.apiKey, text, history, tools, {
		base_url: options.baseUrl ?? null,
		temperature: options.temperature ?? null,
	});
	if ((res as any) instanceof TurnFailure) return res as TurnFailure;
	return res as any;
}
