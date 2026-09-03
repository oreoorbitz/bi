// Provider registry — pi's Provider<TApi> (id, name, baseUrl, api, auth)
// trimmed of the refresh/fetch lifecycle. `auth_env` is pi's
// envApiKeyAuth env-var list collapsed to the single canonical var bi
// resolves: an explicit --api-key wins, else a late-bound baml.env.Ref to
// this var is read per request (see resolve_credential in turn.baml), else
// the client falls back to its own canonical env var. api uses pi's own
// vocabulary ("openai-completions" | "anthropic-messages" |
// "openai-responses" | "google") so turn.baml routes catalog-driven.

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
