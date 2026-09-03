# Deferred pi providers (bi#13)

19 of pi's ~35 providers are wired in bi. Every deferred provider below was
surveyed in `pi/packages/ai/src/providers/*.ts` (pi 0.84.3); each row names
the blocker and what unblocks it. Nothing here needs a new wire format
except where noted — most are auth or endpoint-shape work.

| pi provider id | pi api | blocker | unblocks when |
|---|---|---|---|
| `azure-openai-responses` | `azureOpenAIResponsesApi` | Deployment URLs are per-user (`{resource}.openai.azure.com/openai/deployments/{id}`); no fixed catalog `base_url` fits the `Provider` shape | Host `--base-url` override design + `openai.AzureClient` arm (builtin exists) |
| `amazon-bedrock` | `bedrockConverseStreamApi` | AWS credential chain / IAM signing (profiles, bearer tokens, ambient chain) | Host-side SigV4 signer; new wire format (ConverseStream) |
| `google-vertex` | `googleVertexApi` | ADC / service-account / API-key trinity, project-scoped endpoints | Host-side GCP auth; new wire format |
| `github-copilot` | `anthropic-messages` + completions | Device-flow OAuth is primary; token path needs Copilot-specific headers | OAuth layer (see below) + header support |
| `openai-codex` | codex API | ChatGPT OAuth tokens, custom wire | OAuth layer + new wire format |
| `opencode`, `opencode-go` | mixed | Per-account dynamic endpoints, no fixed `base_url` | Endpoint discovery design |
| `vercel-ai-gateway`, `cloudflare-ai-gateway` | mixed | User gateway URLs/keys, not provider endpoints | Gateway-URL host override design |
| `cloudflare-workers-ai` | `cloudflareStreams(openAICompletionsApi)` | Account-id-scoped URL + custom stream wrapper | Endpoint template + stream wrapper port |
| `ant-ling` | `openai-completions` | Mechanically trivial (env key + fixed URL) but model ids unknown — pi's `data/*.json` catalogs are not in the checkout and there is no public knowledge to transcribe | Re-check against pi checkout with data files present |
| `minimax-cn`, `moonshotai-cn`, `zai-coding-cn`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `xiaomi-*`, `kimi-*` (other plans) | same as base | Regional variants of an already-wired shape | Add on demand: one registry row + models each |
| `faux` | test fake | pi-internal test double | Never (bi uses `llmFn` injection instead) |

## OAuth (deferred as a layer, not per provider)

pi's `auth/oauth/`, `bun-oauth.ts`, `oauth.ts`, `credential-store.ts`, and
`lazyOAuth` cover xai, kimi-coding, copilot, codex, and others. bi takes the
api-key path wherever one exists and defers the rest, per bi#13's acceptance
("Add the OAuth flow when the second OAuth-requiring provider lands"):
copilot and codex are the first providers with NO usable env-key path, so
landing either one triggers building the OAuth layer (device flow +
`~/.bi` credential store + refresh), at which point kimi-coding and xai gain
their OAuth paths for free.
