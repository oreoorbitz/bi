// Provider registry — pi's Provider<TApi> (id, name, baseUrl, api, auth)
// trimmed of the refresh/fetch lifecycle. `auth_env` is pi's
// envApiKeyAuth env-var list collapsed to the single canonical var bi
// resolves: an explicit --api-key wins, else a late-bound baml.env.Ref to
// this var is read per request (see resolve_credential in turn.baml), else
// the client falls back to its own canonical env var. api uses pi's own
// vocabulary ("openai-completions" | "anthropic-messages" |
// "openai-responses" | "google") plus bi's "azure-responses" so turn.baml
// routes catalog-driven.

class Provider {
    id: string,
    name: string,
    base_url: string,
    api: string,
    auth_env: string?,
}

function _providers() -> Provider[] {
    [
        Provider {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            api: "anthropic-messages",
            auth_env: "ANTHROPIC_API_KEY",
        },
        Provider {
            id: "openai",
            name: "OpenAI",
            base_url: "https://api.openai.com/v1",
            api: "openai-responses",
            auth_env: "OPENAI_API_KEY",
        },
        Provider {
            id: "google",
            name: "Google",
            base_url: "https://generativelanguage.googleapis.com",
            api: "google",
            auth_env: "GEMINI_API_KEY",
        },
        Provider {
            id: "groq",
            name: "Groq",
            base_url: "https://api.groq.com/openai/v1",
            api: "openai-completions",
            auth_env: "GROQ_API_KEY",
        },
        Provider {
            id: "deepseek",
            name: "DeepSeek",
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            auth_env: "DEEPSEEK_API_KEY",
        },
        Provider {
            id: "together",
            name: "Together",
            base_url: "https://api.together.ai/v1",
            api: "openai-completions",
            auth_env: "TOGETHER_API_KEY",
        },
        Provider {
            id: "cerebras",
            name: "Cerebras",
            base_url: "https://api.cerebras.ai/v1",
            api: "openai-completions",
            auth_env: "CEREBRAS_API_KEY",
        },
        Provider {
            id: "moonshotai",
            name: "Moonshot AI",
            base_url: "https://api.moonshot.ai/v1",
            api: "openai-completions",
            auth_env: "MOONSHOT_API_KEY",
        },
        Provider {
            id: "nvidia",
            name: "NVIDIA NIM",
            base_url: "https://integrate.api.nvidia.com/v1",
            api: "openai-completions",
            auth_env: "NVIDIA_API_KEY",
        },
        Provider {
            id: "zai",
            name: "Z.AI",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            api: "openai-completions",
            auth_env: "ZAI_API_KEY",
        },
        // Meta Model API speaks OpenAI-compatible chat completions
        // (https://dev.meta.ai/docs/protocols/chat-completions), so the
        // plain openai-completions arm covers it: Bearer key + base_url,
        // `developer`/`system` both accepted server-side. DIVERGENCE:
        // Meta's docs/SDK call the key MODEL_API_KEY; bi namespaces it
        // to META_API_KEY per the one-canonical-var-per-provider rule.
        Provider {
            id: "meta",
            name: "Meta",
            base_url: "https://api.meta.ai/v1",
            api: "openai-completions",
            auth_env: "META_API_KEY",
        },
        Provider {
            id: "huggingface",
            name: "Hugging Face",
            base_url: "https://router.huggingface.co/v1",
            api: "openai-completions",
            auth_env: "HF_TOKEN",
        },
        Provider {
            id: "baseten",
            name: "Baseten",
            base_url: "https://inference.baseten.co/v1",
            api: "openai-completions",
            auth_env: "BASETEN_API_KEY",
        },
        // DIVERGENCE from pi: pi's mistral provider uses a custom
        // mistralConversationsApi against https://api.mistral.ai. bi routes
        // Mistral through its OpenAI-compatible /v1 endpoint instead, so no
        // new wire format is needed — same ChatClient path as the rest.
        Provider {
            id: "mistral",
            name: "Mistral",
            base_url: "https://api.mistral.ai/v1",
            api: "openai-completions",
            auth_env: "MISTRAL_API_KEY",
        },
        // pi's fireworks provider is dual-api (anthropic-messages +
        // openai-completions per model). bi pins the anthropic-messages arm:
        // the catalog base_url is already the inference endpoint that
        // serves it, and the compat routing covers the constructor.
        Provider {
            id: "fireworks",
            name: "Fireworks",
            base_url: "https://api.fireworks.ai/inference",
            api: "anthropic-messages",
            auth_env: "FIREWORKS_API_KEY",
        },
        // pi's xai provider also advertises OAuth (lazyOAuth), but the
        // api-key path (XAI_API_KEY) works the same wire — bi takes it and
        // routes xAI through the ResponsesClient arm (pi uses
        // openAIResponsesApi for xai too).
        Provider {
            id: "xai",
            name: "xAI",
            base_url: "https://api.x.ai/v1",
            api: "openai-responses",
            auth_env: "XAI_API_KEY",
        },
        // pi's minimax endpoint already speaks the Anthropic messages
        // protocol (base_url ends /anthropic), so the anthropic-messages
        // arm covers it with no new wire format.
        Provider {
            id: "minimax",
            name: "MiniMax",
            base_url: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            auth_env: "MINIMAX_API_KEY",
        },
        // Same shape as minimax: pi's kimi-coding endpoint speaks
        // anthropic-messages; the KIMI_API_KEY path is taken (OAuth
        // deferred like the stored-credential layer).
        Provider {
            id: "kimi-coding",
            name: "Kimi Coding",
            base_url: "https://api.kimi.com/coding",
            api: "anthropic-messages",
            auth_env: "KIMI_API_KEY",
        },
        Provider {
            id: "openrouter",
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            auth_env: "OPENROUTER_API_KEY",
        },
        Provider {
            id: "qwen-token-plan",
            name: "Qwen Token Plan",
            base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            auth_env: "QWEN_TOKEN_PLAN_API_KEY",
        },
        // Azure has no fixed endpoint: every call is scoped to the user's
        // resource + deployment (explicit azure_* opts win, else
        // AZURE_OPENAI_RESOURCE / AZURE_OPENAI_DEPLOYMENT env — see the
        // azure-responses arm in turn.baml). base_url stays an empty
        // sentinel and never reaches the client; a host --base-url
        // override still routes through it for closed-port probes.
        Provider {
            id: "azure-openai-responses",
            name: "Azure OpenAI",
            base_url: "",
            api: "azure-responses",
            auth_env: "AZURE_OPENAI_API_KEY",
        },
        // Cloudflare materializes its endpoint per request from env
        // (pi's cloudflareStreams URL-template pattern): {VAR}
        // placeholders in base_url resolve via env reads in turn.baml
        // (resolve_endpoint_template), so no host flags.
        Provider {
            id: "cloudflare-workers-ai",
            name: "Cloudflare Workers AI",
            base_url: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
            api: "openai-completions",
            auth_env: "CLOUDFLARE_API_KEY",
        },
    ]
}

// Canonical env var holding this provider's key (pi's envApiKeyAuth).
// Null means the provider has no standard env-var auth in bi's catalog.
function ProviderAuthEnv(provider: string) -> string? {
    // "openai_responses" is the legacy SendTurn tag alias for "openai"
    // (ListModels already aliases it) — normalize before lookup.
    let id = if (provider == "openai_responses") {
        "openai"
    } else {
        provider
    };
    match (GetProvider(id)) {
        null => null,
        let p: Provider => p.auth_env,
    }
}

function ListProviders() -> Provider[] {
    _providers()
}

// bi#25: fail-fast precheck text (pi's env-api-keys.ts missing-key path).
// A known provider names its exact var; an unknown id says so instead of
// naming a misleading var. bi#15 gateway/CN ids reuse this once they land
// in _providers (ProviderAuthEnv returns null for them until then).
function MissingKeyMessage(provider: string) -> string {
    match (ProviderAuthEnv(provider)) {
        null => `unknown provider "${provider}": no auth mapping (see ListProviders)`,
        let v: string => {
            `${provider} needs an API key: pass --api-key, set ${v}, or run \`bi login ${provider}\``
        },
    }
}

function GetProvider(id: string) -> Provider? {
    for (let p in _providers()) {
        if (p.id == id) {
            return p;
        }
    }
    null
}

function ProviderExists(id: string) -> bool {
    GetProvider(id) is null == false
}

function ProviderForModel(model_id: string) -> Provider? {
    match (GetModel(model_id)) {
        null => null,
        let m: Model => GetProvider(m.provider),
    }
}

// pi's Models.refreshModels — for static bi providers this is a no-op that
// still validates the provider id and returns whether it was known. A real
// pi dynamic provider would fetch via network here; bi's static catalog
// needs no fetch, so this just returns true for known providers.
// Wiring the agent loop to this mirrors pi's `await models.refreshModels({allowNetwork:false})`
// that runs before the first turn.
function RefreshModels(provider: string) -> bool {
    ProviderExists(provider)
}

function RefreshAllModels() -> int {
    ListProviders().length()
}

class ModelsRefreshResult {
    provider: string,
    refreshed: bool,
    model_count: int,
    source: string @description("'static' | 'remote' | 'unknown'"),
}

function RefreshModelsWithResult(
    provider: string,
    allow_network: bool = false,
    remote_count: int? = null,
) -> ModelsRefreshResult {
    let exists = ProviderExists(provider);
    if (!exists) {
        ModelsRefreshResult {
            provider: provider,
            refreshed: false,
            model_count: 0,
            source: "unknown",
        }
    } else if (allow_network && remote_count is null == false) {
        // remote catalog path — compose base + remote overlay via provider_composer
        // For tracer, remote_count is the remote model count (host will fetch via bais/bagl style).
        // Real pi does `withRemoteCatalog` + `ModelRuntime` fetch; bi proves via `compose_provider`.
        let base = ComposedProvider {
            id: provider,
            name: provider,
            base_url: GetProvider(provider)?.base_url,
            api: GetProvider(provider)?.api,
            headers: null,
            models: ListModels(provider).map((m) -> {
                ComposedModel {
                    id: m.id,
                    name: m.name,
                    api: m.api,
                    provider: m.provider,
                    base_url: m.base_url,
                    reasoning: m.reasoning,
                    context_window: m.context_window,
                    max_tokens: m.max_tokens,
                    headers: null,
                }
            }),
        };
        let ext = ProviderExtension {
            name: null,
            base_url: null,
            api: null,
            headers: null,
            model_overrides: null,
            models: null,
        };
        let composed = compose_provider(provider, base, ext);
        ModelsRefreshResult {
            provider: provider,
            refreshed: true,
            model_count: composed.models.length(),
            source: "remote",
        }
    } else {
        ModelsRefreshResult {
            provider: provider,
            refreshed: true,
            model_count: ListModels(provider).length(),
            source: "static",
        }
    }
}
