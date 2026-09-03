// Minimal pi Provider port — static provider registry for the 3 bi clients.
// Mirrors pi's Provider<TApi> (id, name, baseUrl, api) but without auth
// refresh/fetch lifecycle. Enough to drive ListModels and SendTurn via
// provider id.

class Provider {
    id: string,
    name: string,
    base_url: string,
    api: string,
}

function _providers() -> Provider[] {
    [
        Provider {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            api: "anthropic-messages",
        },
        Provider {
            id: "openai",
            name: "OpenAI",
            base_url: "https://api.openai.com/v1",
            api: "openai-responses",
        },
        Provider {
            id: "google",
            name: "Google",
            base_url: "https://generativelanguage.googleapis.com",
            api: "google",
        },
    ]
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
