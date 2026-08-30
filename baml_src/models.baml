// Minimal pi model catalog port — static data for 3 providers where bi has clients.
// Mirrors pi/packages/ai's Model<TApi> shape (id, name, api, provider, reasoning,
// contextWindow, maxTokens, cost) but trimmed to what's needed to drive SendTurn.

class ModelCost {
    input: float,
    output: float,
    cache_read: float?,
    cache_write: float?,
}

class Model {
    id: string,
    name: string,
    api: string,
    provider: string,
    base_url: string,
    reasoning: bool,
    input: string[],
    context_window: int,
    max_tokens: int,
    cost: ModelCost,
}

// Static catalog — a few representative models per provider that bi actually
// has a client for. Full pi catalog has 100+ models across 30 providers;
// this slice proves the shape and the ListModels/GetModel plumbing.

function _anthropic_models() -> Model[] {
    [
        Model {
            id: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            api: "anthropic-messages",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            reasoning: false,
            input: ["text", "image"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
        },
        Model {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            api: "anthropic-messages",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            reasoning: true,
            input: ["text", "image"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
        },
        Model {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            api: "anthropic-messages",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            reasoning: true,
            input: ["text", "image"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
        },
    ]
}

function _openai_models() -> Model[] {
    [
        Model {
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            api: "openai-responses",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            reasoning: false,
            input: ["text", "image"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 0.15, output: 0.6, cache_read: null, cache_write: null },
        },
        Model {
            id: "gpt-4o",
            name: "GPT-4o",
            api: "openai-responses",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            reasoning: false,
            input: ["text", "image"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 2.5, output: 10.0, cache_read: null, cache_write: null },
        },
    ]
}

function _google_models() -> Model[] {
    [
        Model {
            id: "gemini-2.0-flash",
            name: "Gemini 2.0 Flash",
            api: "google",
            provider: "google",
            base_url: "https://generativelanguage.googleapis.com",
            reasoning: false,
            input: ["text", "image"],
            context_window: 1000000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.1, output: 0.4, cache_read: null, cache_write: null },
        },
        Model {
            id: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            api: "google",
            provider: "google",
            base_url: "https://generativelanguage.googleapis.com",
            reasoning: true,
            input: ["text", "image"],
            context_window: 2000000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 10.0, cache_read: null, cache_write: null },
        },
    ]
}

function ListAllModels() -> Model[] {
    let out: Model[] = [];
    for (let m in _anthropic_models()) {
        out.push(m)
    }
    for (let m in _openai_models()) {
        out.push(m)
    }
    for (let m in _google_models()) {
        out.push(m)
    }
    out
}

function ListModels(provider: string) -> Model[] {
    match (provider) {
        "anthropic" => _anthropic_models(),
        "openai" => _openai_models(),
        "openai_responses" => _openai_models(),
        "google" => _google_models(),
        _ => [],
    }
}

function GetModel(id: string) -> Model? {
    for (let m in ListAllModels()) {
        if (m.id == id) {
            return m;
        }
    }
    null
}

function ModelSupportsReasoning(id: string) -> bool {
    match (GetModel(id)) {
        null => false,
        let m: Model => m.reasoning,
    }
}
