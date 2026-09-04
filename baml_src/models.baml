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
    for (let m in _moonshotai_models()) {
        out.push(m)
    }
    for (let m in _nvidia_models()) {
        out.push(m)
    }
    for (let m in _zai_models()) {
        out.push(m)
    }
    for (let m in _huggingface_models()) {
        out.push(m)
    }
    for (let m in _baseten_models()) {
        out.push(m)
    }
    for (let m in _mistral_models()) {
        out.push(m)
    }
    for (let m in _fireworks_models()) {
        out.push(m)
    }
    for (let m in _xai_models()) {
        out.push(m)
    }
    for (let m in _minimax_models()) {
        out.push(m)
    }
    for (let m in _kimi_coding_models()) {
        out.push(m)
    }
    for (let m in _openrouter_models()) {
        out.push(m)
    }
    for (let m in _qwen_token_plan_models()) {
        out.push(m)
    }
    for (let m in _azure_models()) {
        out.push(m)
    }
    for (let m in _cloudflare_models()) {
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
        "moonshotai" => _moonshotai_models(),
        "nvidia" => _nvidia_models(),
        "zai" => _zai_models(),
        "huggingface" => _huggingface_models(),
        "baseten" => _baseten_models(),
        "mistral" => _mistral_models(),
        "fireworks" => _fireworks_models(),
        "xai" => _xai_models(),
        "minimax" => _minimax_models(),
        "kimi-coding" => _kimi_coding_models(),
        "openrouter" => _openrouter_models(),
        "qwen-token-plan" => _qwen_token_plan_models(),
        "azure-openai-responses" => _azure_models(),
        "cloudflare-workers-ai" => _cloudflare_models(),
        _ => [],
    }
}

function _xai_models() -> Model[] {
    [
        Model {
            id: "grok-4",
            name: "Grok 4",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "grok-code-fast-1",
            name: "Grok Code Fast 1",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.2, output: 1.5, cache_read: null, cache_write: null },
        },
    ]
}

function _minimax_models() -> Model[] {
    [
        Model {
            id: "MiniMax-M2",
            name: "MiniMax M2",
            api: "anthropic-messages",
            provider: "minimax",
            base_url: "https://api.minimax.io/anthropic",
            reasoning: true,
            input: ["text"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.3, output: 1.2, cache_read: null, cache_write: null },
        },
        Model {
            id: "MiniMax-M1",
            name: "MiniMax M1",
            api: "anthropic-messages",
            provider: "minimax",
            base_url: "https://api.minimax.io/anthropic",
            reasoning: true,
            input: ["text"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.4, output: 0.8, cache_read: null, cache_write: null },
        },
    ]
}

function _kimi_coding_models() -> Model[] {
    [
        Model {
            id: "kimi-k2-0711-preview",
            name: "Kimi K2 (coding endpoint)",
            api: "anthropic-messages",
            provider: "kimi-coding",
            base_url: "https://api.kimi.com/coding",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.6, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            api: "anthropic-messages",
            provider: "kimi-coding",
            base_url: "https://api.kimi.com/coding",
            reasoning: true,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.7, output: 6.6, cache_read: null, cache_write: null },
        },
    ]
}

function _openrouter_models() -> Model[] {
    [
        Model {
            id: "anthropic/claude-sonnet-4-5",
            name: "Claude Sonnet 4.5 (OpenRouter)",
            api: "openai-completions",
            provider: "openrouter",
            base_url: "https://openrouter.ai/api/v1",
            reasoning: true,
            input: ["text"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro (OpenRouter)",
            api: "openai-completions",
            provider: "openrouter",
            base_url: "https://openrouter.ai/api/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 10.0, cache_read: null, cache_write: null },
        },
    ]
}

function _qwen_token_plan_models() -> Model[] {
    [
        Model {
            id: "qwen-max",
            name: "Qwen Max",
            api: "openai-completions",
            provider: "qwen-token-plan",
            base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.2, output: 4.8, cache_read: null, cache_write: null },
        },
        Model {
            id: "qwen-plus",
            name: "Qwen Plus",
            api: "openai-completions",
            provider: "qwen-token-plan",
            base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.1, output: 0.3, cache_read: null, cache_write: null },
        },
    ]
}

function _moonshotai_models() -> Model[] {
    [
        Model {
            id: "kimi-k2-0711-preview",
            name: "Kimi K2",
            api: "openai-completions",
            provider: "moonshotai",
            base_url: "https://api.moonshot.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.6, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "moonshot-v1-8k",
            name: "Moonshot v1 8K",
            api: "openai-completions",
            provider: "moonshotai",
            base_url: "https://api.moonshot.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 8000,
            max_tokens: 4096,
            cost: ModelCost { input: 1.6, output: 1.6, cache_read: null, cache_write: null },
        },
    ]
}

function _nvidia_models() -> Model[] {
    [
        Model {
            id: "moonshotai/kimi-k2-instruct",
            name: "Kimi K2 Instruct (NIM)",
            api: "openai-completions",
            provider: "nvidia",
            base_url: "https://integrate.api.nvidia.com/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.0, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "meta/llama-3.3-70b-instruct",
            name: "Llama 3.3 70B Instruct (NIM)",
            api: "openai-completions",
            provider: "nvidia",
            base_url: "https://integrate.api.nvidia.com/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.6, output: 0.8, cache_read: null, cache_write: null },
        },
    ]
}

function _zai_models() -> Model[] {
    [
        Model {
            id: "glm-4.5",
            name: "GLM 4.5",
            api: "openai-completions",
            provider: "zai",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: null },
        },
        Model {
            id: "glm-4.5-air",
            name: "GLM 4.5 Air",
            api: "openai-completions",
            provider: "zai",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.2, output: 1.1, cache_read: 0.03, cache_write: null },
        },
        Model {
            id: "glm-5.3",
            name: "GLM 5.3",
            api: "openai-completions",
            provider: "zai",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 128000,
            cost: ModelCost { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: null },
        },
        Model {
            id: "glm-5.3-flash",
            name: "GLM 5.3 Flash",
            api: "openai-completions",
            provider: "zai",
            base_url: "https://api.z.ai/api/coding/paas/v4",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1000000,
            max_tokens: 128000,
            cost: ModelCost { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: null },
        },
    ]
}

function _huggingface_models() -> Model[] {
    [
        Model {
            id: "moonshotai/Kimi-K2-Instruct",
            name: "Kimi K2 Instruct (HF router)",
            api: "openai-completions",
            provider: "huggingface",
            base_url: "https://router.huggingface.co/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.0, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "meta-llama/Llama-3.3-70B-Instruct",
            name: "Llama 3.3 70B Instruct (HF router)",
            api: "openai-completions",
            provider: "huggingface",
            base_url: "https://router.huggingface.co/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.6, output: 0.8, cache_read: null, cache_write: null },
        },
    ]
}

function _baseten_models() -> Model[] {
    [
        Model {
            id: "moonshotai/Kimi-K2-Instruct",
            name: "Kimi K2 Instruct (Baseten)",
            api: "openai-completions",
            provider: "baseten",
            base_url: "https://inference.baseten.co/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.0, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "Qwen/Qwen3-32B",
            name: "Qwen 3 32B (Baseten)",
            api: "openai-completions",
            provider: "baseten",
            base_url: "https://inference.baseten.co/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.4, output: 0.8, cache_read: null, cache_write: null },
        },
    ]
}

function _mistral_models() -> Model[] {
    [
        Model {
            id: "mistral-large-latest",
            name: "Mistral Large",
            api: "openai-completions",
            provider: "mistral",
            base_url: "https://api.mistral.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 2.0, output: 6.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "mistral-small-latest",
            name: "Mistral Small",
            api: "openai-completions",
            provider: "mistral",
            base_url: "https://api.mistral.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.1, output: 0.3, cache_read: null, cache_write: null },
        },
    ]
}

function _fireworks_models() -> Model[] {
    [
        Model {
            id: "accounts/fireworks/models/kimi-k2-instruct",
            name: "Kimi K2 Instruct (Fireworks)",
            api: "anthropic-messages",
            provider: "fireworks",
            base_url: "https://api.fireworks.ai/inference",
            reasoning: false,
            input: ["text"],
            context_window: 200000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.2, output: 3.6, cache_read: null, cache_write: null },
        },
        Model {
            id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
            name: "Llama 3.3 70B Instruct (Fireworks)",
            api: "anthropic-messages",
            provider: "fireworks",
            base_url: "https://api.fireworks.ai/inference",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 8192,
            cost: ModelCost { input: 0.9, output: 0.9, cache_read: null, cache_write: null },
        },
    ]
}

// Azure serves the user's own deployments, not a fixed model list — these
// are the well-known OpenAI models commonly deployed there (any deployment
// id works; the catalog is advisory). No pi data JSON to transcribe;
// ids below are stable public model names.
function _azure_models() -> Model[] {
    [
        Model {
            id: "gpt-4o",
            name: "GPT-4o (Azure deployment)",
            api: "azure-responses",
            provider: "azure-openai-responses",
            base_url: "",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 2.5, output: 10.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "gpt-4o-mini",
            name: "GPT-4o mini (Azure deployment)",
            api: "azure-responses",
            provider: "azure-openai-responses",
            base_url: "",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 0.15, output: 0.6, cache_read: null, cache_write: null },
        },
    ]
}

// Cloudflare Workers AI serves @cf/ models on the account endpoint —
// stable public ids (no pi data JSON to transcribe). Windows/costs are
// advisory (Workers AI bills per-neuron); the template base_url mirrors
// the provider row and materializes per request.
function _cloudflare_models() -> Model[] {
    [
        Model {
            id: "@cf/meta/llama-3.1-8b-instruct",
            name: "Llama 3.1 8B Instruct (Cloudflare)",
            api: "openai-completions",
            provider: "cloudflare-workers-ai",
            base_url: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 128000,
            max_tokens: 4096,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "@cf/mistral/mistral-7b-instruct-v0.1",
            name: "Mistral 7B Instruct v0.1 (Cloudflare)",
            api: "openai-completions",
            provider: "cloudflare-workers-ai",
            base_url: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 8192,
            max_tokens: 4096,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
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
