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
//
// bi#13 snapshot (2026-09): flagship wire ids per provider with approximate
// list pricing ($/M tokens) and context windows from public price pages.
// Numbers rot — verify before relying; tests pin ids/providers, not costs.
// pi's per-provider data/*.json were not in the checkout, so flagships were
// chosen from public knowledge, not transcribed.

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

function _groq_models() -> Model[] {
    [
        Model {
            id: "llama-3.3-70b-versatile",
            name: "Llama 3.3 70B Versatile",
            api: "openai-completions",
            provider: "groq",
            base_url: "https://api.groq.com/openai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.59, output: 0.79, cache_read: null, cache_write: null },
        },
        Model {
            id: "deepseek-r1-distill-llama-70b",
            name: "DeepSeek R1 Distill Llama 70B",
            api: "openai-completions",
            provider: "groq",
            base_url: "https://api.groq.com/openai/v1",
            reasoning: true,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.59, output: 0.79, cache_read: null, cache_write: null },
        },
    ]
}

function _deepseek_models() -> Model[] {
    [
        Model {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            api: "openai-completions",
            provider: "deepseek",
            base_url: "https://api.deepseek.com",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: null },
        },
        Model {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            api: "openai-completions",
            provider: "deepseek",
            base_url: "https://api.deepseek.com",
            reasoning: true,
            input: ["text"],
            context_window: 64000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.55, output: 2.19, cache_read: 0.14, cache_write: null },
        },
    ]
}

function _together_models() -> Model[] {
    [
        Model {
            id: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
            name: "Llama 3.1 70B Instruct Turbo",
            api: "openai-completions",
            provider: "together",
            base_url: "https://api.together.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.88, output: 0.88, cache_read: null, cache_write: null },
        },
        Model {
            id: "moonshotai/Kimi-K2-Instruct",
            name: "Kimi K2 Instruct",
            api: "openai-completions",
            provider: "together",
            base_url: "https://api.together.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.0, output: 3.0, cache_read: null, cache_write: null },
        },
    ]
}

function _cerebras_models() -> Model[] {
    [
        Model {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            api: "openai-completions",
            provider: "cerebras",
            base_url: "https://api.cerebras.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.85, output: 1.2, cache_read: null, cache_write: null },
        },
        Model {
            id: "qwen-3-32b",
            name: "Qwen 3 32B",
            api: "openai-completions",
            provider: "cerebras",
            base_url: "https://api.cerebras.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.4, output: 0.8, cache_read: null, cache_write: null },
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
    for (let m in _groq_models()) {
        out.push(m)
    }
    for (let m in _deepseek_models()) {
        out.push(m)
    }
    for (let m in _together_models()) {
        out.push(m)
    }
    for (let m in _cerebras_models()) {
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
        "groq" => _groq_models(),
        "deepseek" => _deepseek_models(),
        "together" => _together_models(),
        "cerebras" => _cerebras_models(),
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
