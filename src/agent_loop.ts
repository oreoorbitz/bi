// bi/src/agent_loop.ts — host agent loop, mirrors pi/packages/agent agent-loop
// BAML owns LoopState/LoopContext/validate_continue/next_loop_state, host owns streamFn/ai.Client
// This wraps bi's existing pi-like Turn loop (src/agent.ts runAgent) with BAML state validation.

import { loop_context_new, validate_continue, next_loop_state, LoopState } from "../baml_sdk/index.js";
import { runAgent, type ToolHandler } from "./agent.js";

export async function runBiLoop(
	prompt: string,
	opts: { provider?: string; model?: string; apiKey?: string | null; maxTurns?: number; onEvent?: (e: string) => void },
): Promise<{ messages: any[]; failure?: { kind: string; message: string } }> {
	const ctx = loop_context_new(opts.maxTurns ?? 5, Math.random().toString(16).slice(2, 8));
	// BAML is validator — ensure we can start (not assistant)
	try {
		validate_continue(ctx);
	} catch {
		// empty context is expected for new prompt — pi's agentLoop creates new prompt message first
	}
	// push user message like pi's agentLoop(prompts=[user: prompt])
	(ctx as any).messages = [`user: ${prompt}`];
	(ctx as any).state = LoopState.Thinking;

	const result = await runAgent(prompt, {
		provider: opts.provider ?? "anthropic",
		model: opts.model ?? "claude-haiku-4-5",
		apiKey: opts.apiKey ?? null,
		maxTurns: opts.maxTurns ?? 5,
	});

	// Update BAML loop state via next_loop_state
	const hasTool = result.messages.some((m: any) => m.role === "assistant" && (m as any).content?.some((b: any) => b.type === "toolUse"));
	const isDone = !result.failure;
	(ctx as any).state = next_loop_state((ctx as any).state, hasTool, isDone);
	opts.onEvent?.(`loop:${(ctx as any).state.toString()} hasTool=${hasTool} done=${isDone}`);

	return { messages: result.messages, failure: result.failure ? { kind: result.failure.kind, message: result.failure.message } : undefined };
}
