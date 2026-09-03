// bi/src/auth.ts — host side of provider auth (bi#13).
//
// Split: BAML owns WHICH env var (Provider.auth_env via ProviderAuthEnv);
// this file owns READING it. Pre-wire check so a missing key fails fast
// naming the provider's own var, instead of reaching the client (whose
// canonical fallback — e.g. OPENAI_API_KEY for every ChatClient — would
// mislead a groq user). Mirrors pi's envApiKeyAuth precedence minus the
// stored-credential layer: explicit --api-key wins, else env, else a
// classified failure.

import { MissingKeyMessage_async, ProviderAuthEnv_async, TurnFailure } from "../baml_sdk/index.js";

export async function missingKeyFailure(provider: string, apiKey?: string | null): Promise<TurnFailure | null> {
	if (apiKey) return null;
	const v = await ProviderAuthEnv_async(provider);
	if (!v) {
		// bi#25: unknown provider fails fast too, naming no misleading var.
		return new TurnFailure({
			kind: "invalid_argument",
			message: await MissingKeyMessage_async(provider),
			retry_safe: false,
		});
	}
	if (process.env[v]) return null;
	return new TurnFailure({
		kind: "invalid_argument",
		message: await MissingKeyMessage_async(provider),
		retry_safe: false,
	});
}
