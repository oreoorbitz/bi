// Incremental streaming host wrapper — Seam B green path via BamlStream.
// Wraps StartIncrementalStream / CreateTypedStream which return
// ai.stream.Stream<string,string> (BamlStream) that survives FFI.
//
// Unlike TurnStream (raw handle, broken second next), Stream is the
// BamlStream-tagged handle designed for host incremental pulls.

import {
  CreateTypedStream_async,
  StartIncrementalStream_async,
  TurnFailure,
} from "../baml_sdk/index.js";
import { toHistory, toToolSpecs, type ConversationTurn, type ToolSpec } from "./conversation.js";

export type IncrementalStream = {
  next(): string | import("../baml_sdk/index.js").ai.stream.Done;
  nextAsync(): Promise<string | import("../baml_sdk/index.js").ai.stream.Done>;
  final(): string;
  finalAsync(): Promise<string>;
};

export interface IncrementalCallOptions {
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  history?: readonly ConversationTurn[];
  tools?: readonly ToolSpec[];
  temperature?: number | null;
  thinking?: import("./anthropic.js").AnthropicThinking | null;
}

const ANTHROPIC = "anthropic";
const OPENAI_RESPONSES = "openai_responses";

async function toThinkingConfig(thinking: import("./anthropic.js").AnthropicThinking | null | undefined): Promise<any | null> {
  if (!thinking) return null;
  const { vendor } = await import("../baml_sdk/index.js");
  if (thinking.type === "disabled") return vendor.anthropic.ThinkingConfig.disabled();
  return vendor.anthropic.ThinkingConfig.enabled((thinking as any).budgetTokens ?? 1024);
}

export async function startAnthropicIncremental(
  text: string,
  options: IncrementalCallOptions,
): Promise<IncrementalStream | TurnFailure> {
  const history = await toHistory(options.history ?? []);
  const tools = toToolSpecs(options.tools ?? []);
  const thinking = await toThinkingConfig(options.thinking ?? null);
  const res = await StartIncrementalStream_async(ANTHROPIC, options.model, options.apiKey, text, history, tools, {
    base_url: options.baseUrl ?? null,
    temperature: options.temperature ?? null,
    thinking,
  });
  // StartIncrementalStream returns Stream | TurnFailure union — TurnFailure is concrete class
  if (res instanceof TurnFailure) return res;
  return res as IncrementalStream;
}

export async function startOpenAIResponsesIncremental(
  text: string,
  options: IncrementalCallOptions,
): Promise<IncrementalStream | TurnFailure> {
  const history = await toHistory(options.history ?? []);
  const tools = toToolSpecs(options.tools ?? []);
  const res = await StartIncrementalStream_async(OPENAI_RESPONSES, options.model, options.apiKey, text, history, tools, {
    base_url: options.baseUrl ?? null,
    temperature: options.temperature ?? null,
  });
  if (res instanceof TurnFailure) return res;
  return res as IncrementalStream;
}

// Scripted helper for offline/host tests — no network, verifies BamlStream incremental.
export async function createScriptedIncremental(chunks: readonly string[]): Promise<IncrementalStream> {
  return CreateTypedStream_async([...chunks]) as Promise<IncrementalStream>;
}

// Convenience: collect all partials from a stream (for tests / simple callers).
// Returns accumulated final string. Throws if stream's next throws (mid-stream NetworkFailure -> Io).
export async function collectIncremental(stream: IncrementalStream): Promise<string> {
  let last = "";
  while (true) {
    const nxt: any = await (stream as any).nextAsync();
    // Done is instance of ai.stream.Done
    if (nxt && typeof nxt === "object" && nxt.constructor?.name === "Done") break;
    if (nxt === null || nxt === undefined) break;
    // For string-typed Stream, nxt is the accumulated string so far
    if (typeof nxt === "string") last = nxt;
  }
  // finalAsync returns the joined final string (same as last, but ensures parse final)
  try {
    const fin = await (stream as any).finalAsync();
    return typeof fin === "string" ? fin : last;
  } catch {
    return last;
  }
}
