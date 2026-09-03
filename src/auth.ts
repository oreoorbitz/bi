// bi/src/auth.ts — host side of provider auth (bi#13).
//
// Split: BAML owns WHICH env var (Provider.auth_env via ProviderAuthEnv);
// this file owns READING it. Pre-wire check so a missing key fails fast
// naming the provider's own var, instead of reaching the client (whose
// canonical fallback — e.g. OPENAI_API_KEY for every ChatClient — would
// mislead a groq user). Mirrors pi's envApiKeyAuth precedence minus the
// stored-credential layer: explicit --api-key wins, else env, else a
// classified failure.

import { ProviderAuthEnv_async, TurnFailure } from "../baml_sdk/index.js";

export async function missingKeyFailure(provider: string, apiKey?: string | null): Promise<TurnFailure | null> {
	if (apiKey) return null;
	const v = await ProviderAuthEnv_async(provider);
	if (!v) return null;
	if (process.env[v]) return null;
	return new TurnFailure({
		kind: "invalid_argument",
		message: `${provider} needs an API key: pass --api-key, or set ${v}`,
		retry_safe: false,
	});
}
