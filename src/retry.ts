// bi/src/retry.ts — host retry executor (bi#16).
// BAML owns the policy (retry.baml: should_retry/backoff_ms, pinned by
// baml test); this file owns timers, jitter, and the re-call loop.
// Retries wrap whole SendTurn/StreamTurn calls — fetch lives inside the VM,
// so per-request retry is impossible; the calls are stateless, same args.
// Jitter (±25%) lives here: BAML has no RNG.

import { TurnFailure, ai, backoff_ms, max_retries, should_retry } from "../baml_sdk/index.js";

export async function callWithRetry(label: string, fn: () => Promise<ai.ModelTurn | TurnFailure>): Promise<ai.ModelTurn | TurnFailure> {
	const max = max_retries();
	let attempt = 0;
	for (;;) {
		const out = await fn();
		if (!(out instanceof TurnFailure)) return out;
		if (!should_retry(out.kind, out.retry_safe, attempt)) return out;
		const wait = Math.round(backoff_ms(attempt) * (0.75 + Math.random() / 2));
		console.error(`[bi] retry ${attempt + 1}/${max} ${label} ${out.kind} after ${wait}ms`);
		await new Promise((r) => setTimeout(r, wait));
		attempt += 1;
	}
}
