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
