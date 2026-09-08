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
    for (let m in _meta_models()) {
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
    for (let m in _cloudflare_gateway_models()) {
        out.push(m)
    }
    for (let m in _vercel_gateway_models()) {
        out.push(m)
    }
    for (let m in _copilot_models()) {
        out.push(m)
    }
    for (let m in _opencode_models()) {
        out.push(m)
    }
    for (let m in _opencode_go_models()) {
        out.push(m)
    }
    for (let m in _xiaomi_models()) {
        out.push(m)
    }
    for (let m in _xiaomi_ams_models()) {
        out.push(m)
    }
    for (let m in _xiaomi_cn_models()) {
        out.push(m)
    }
    for (let m in _xiaomi_sgp_models()) {
        out.push(m)
    }
    for (let m in _ant_ling_models()) {
        out.push(m)
    }
    for (let m in _minimax_cn_models()) {
        out.push(m)
    }
    for (let m in _moonshotai_cn_models()) {
        out.push(m)
    }
    for (let m in _qwen_token_plan_cn_models()) {
        out.push(m)
    }
    for (let m in _qwen_token_plan_individual_models()) {
        out.push(m)
    }
    for (let m in _zai_coding_cn_models()) {
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
        "meta" => _meta_models(),
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
        "cloudflare-ai-gateway" => _cloudflare_gateway_models(),
        "vercel-ai-gateway" => _vercel_gateway_models(),
        "github-copilot" => _copilot_models(),
        "opencode" => _opencode_models(),
        "opencode-go" => _opencode_go_models(),
        "xiaomi" => _xiaomi_models(),
        "xiaomi-token-plan-ams" => _xiaomi_ams_models(),
        "xiaomi-token-plan-cn" => _xiaomi_cn_models(),
        "xiaomi-token-plan-sgp" => _xiaomi_sgp_models(),
        "ant-ling" => _ant_ling_models(),
        "minimax-cn" => _minimax_cn_models(),
        "moonshotai-cn" => _moonshotai_cn_models(),
        "qwen-token-plan-cn" => _qwen_token_plan_cn_models(),
        "qwen-token-plan-individual" => _qwen_token_plan_individual_models(),
        "zai-coding-cn" => _zai_coding_cn_models(),
        _ => [],
    }
}

// xAI Grok (https://docs.x.ai/developers/models, https://docs.x.ai/developers/pricing):
// Responses API over https://api.x.ai/v1. Costs below are the base tier
// (<200k prompt tokens); every text model doubles input/output/cached
// past 200k prompt tokens. Dated 4.20 snapshots omitted — the three
// mainline versions plus the Grok Build coding model cover the lineup.
function _xai_models() -> Model[] {
    [
        Model {
            id: "grok-4.6",
            name: "Grok 4.6",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 500000,
            max_tokens: 8192,
            cost: ModelCost { input: 2.0, output: 6.0, cache_read: 0.50, cache_write: null },
        },
        Model {
            id: "grok-4.5",
            name: "Grok 4.5",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 500000,
            max_tokens: 8192,
            cost: ModelCost { input: 2.0, output: 6.0, cache_read: 0.30, cache_write: null },
        },
        Model {
            id: "grok-4.3",
            name: "Grok 4.3",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1000000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 2.50, cache_read: 0.20, cache_write: null },
        },
        Model {
            id: "grok-build-0.1",
            name: "Grok Build 0.1",
            api: "openai-responses",
            provider: "xai",
            base_url: "https://api.x.ai/v1",
            reasoning: false,
            input: ["text"],
            context_window: 256000,
            max_tokens: 8192,
            cost: ModelCost { input: 1.0, output: 2.0, cache_read: 0.20, cache_write: null },
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

// Meta Muse Spark (https://dev.meta.ai/docs/models): OpenAI-compatible
// chat completions over https://api.meta.ai/v1. Spark always reasons
// server-side; 1M-token window on every version; no long-context
// premium. Standard tier (1.25/4.25/0.15 per 1M) vs contributor tier
// (0.10/0.20/0.002 — training-eligible, discounted). Image/Video/PDF
// understanding collapses to bi's "image" input tag.
function _meta_models() -> Model[] {
    [
        Model {
            id: "muse-spark-1.3",
            name: "Muse Spark 1.3",
            api: "openai-completions",
            provider: "meta",
            base_url: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1048576,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 4.25, cache_read: 0.15, cache_write: null },
        },
        Model {
            id: "muse-spark-1.3-contributor",
            name: "Muse Spark 1.3 Contributor",
            api: "openai-completions",
            provider: "meta",
            base_url: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1048576,
            max_tokens: 8192,
            cost: ModelCost { input: 0.10, output: 0.20, cache_read: 0.002, cache_write: null },
        },
        Model {
            id: "muse-spark-1.2",
            name: "Muse Spark 1.2",
            api: "openai-completions",
            provider: "meta",
            base_url: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1048576,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 4.25, cache_read: 0.15, cache_write: null },
        },
        Model {
            id: "muse-spark-1.2-contributor",
            name: "Muse Spark 1.2 Contributor",
            api: "openai-completions",
            provider: "meta",
            base_url: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1048576,
            max_tokens: 8192,
            cost: ModelCost { input: 0.10, output: 0.20, cache_read: 0.002, cache_write: null },
        },
        Model {
            id: "muse-spark-1.1",
            name: "Muse Spark 1.1",
            api: "openai-completions",
            provider: "meta",
            base_url: "https://api.meta.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1048576,
            max_tokens: 8192,
            cost: ModelCost { input: 1.25, output: 4.25, cache_read: 0.15, cache_write: null },
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

// Cloudflare AI Gateway OpenAI passthrough (pi maps openai/* upstream
// ids to the responses arm on the /openai base). Ids/limits/costs from
// models.dev cloudflare-ai-gateway (2026-09); the template base_url
// mirrors the provider row.
function _cloudflare_gateway_models() -> Model[] {
    [
        Model {
            id: "openai/gpt-4o",
            name: "GPT-4o (Cloudflare Gateway)",
            api: "openai-responses",
            provider: "cloudflare-ai-gateway",
            base_url: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
            reasoning: false,
            input: ["text", "image"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 1.25, output: 5.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "openai/gpt-4o-mini",
            name: "GPT-4o mini (Cloudflare Gateway)",
            api: "openai-responses",
            provider: "cloudflare-ai-gateway",
            base_url: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
            reasoning: false,
            input: ["text", "image"],
            context_window: 128000,
            max_tokens: 16384,
            cost: ModelCost { input: 0.075, output: 0.3, cache_read: null, cache_write: null },
        },
    ]
}

// Vercel AI Gateway BYO passthrough (pi fetches the catalog live from
// the gateway; these two anthropic/* ids are the stable flagships from
// models.dev vercel, 2026-09). pi routes the gateway through the
// anthropic-messages arm — the id carries the upstream.
function _vercel_gateway_models() -> Model[] {
    [
        Model {
            id: "anthropic/claude-opus-4.8",
            name: "Claude Opus 4.8 (Vercel Gateway)",
            api: "anthropic-messages",
            provider: "vercel-ai-gateway",
            base_url: "https://ai-gateway.vercel.sh",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1000000,
            max_tokens: 128000,
            cost: ModelCost { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "anthropic/claude-opus-4.7",
            name: "Claude Opus 4.7 (Vercel Gateway)",
            api: "anthropic-messages",
            provider: "vercel-ai-gateway",
            base_url: "https://ai-gateway.vercel.sh",
            reasoning: true,
            input: ["text", "image"],
            context_window: 1000000,
            max_tokens: 128000,
            cost: ModelCost { input: 5.0, output: 25.0, cache_read: null, cache_write: null },
        },
    ]
}

// GitHub Copilot on the pinned openai-completions arm (pi's per-model
// arm mapping puts gpt-6-astra and kimi-k2.7-code here — not claude-4/5,
// not gpt-5/grok/oswe/mai-). Limits/costs from models.dev
// github-copilot (2026-09). Requests carry COPILOT_STATIC_HEADERS.
function _copilot_models() -> Model[] {
    [
        Model {
            id: "gpt-6-astra",
            name: "GPT-6 Astra (Copilot)",
            api: "openai-completions",
            provider: "github-copilot",
            base_url: "https://api.individual.githubcopilot.com",
            reasoning: true,
            input: ["text"],
            context_window: 1050000,
            max_tokens: 128000,
            cost: ModelCost { input: 10.0, output: 50.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "kimi-k2.7-code",
            name: "Kimi K2.7 Code (Copilot)",
            api: "openai-completions",
            provider: "github-copilot",
            base_url: "https://api.individual.githubcopilot.com",
            reasoning: true,
            input: ["text"],
            context_window: 256000,
            max_tokens: 32000,
            cost: ModelCost { input: 0.95, output: 4.0, cache_read: null, cache_write: null },
        },
    ]
}

// OpenCode Zen on the pinned openai-completions arm (pi's npm mapping:
// null/undefined npm → completions on <basePath>/v1). Ids/limits from
// models.dev opencode (2026-09); zen serves free + paid lanes, costs
// below are the paid lane (free lane bills 0).
function _opencode_models() -> Model[] {
    [
        Model {
            id: "nemotron-3-ultra-free",
            name: "Nemotron 3 Ultra Free (Zen)",
            api: "openai-completions",
            provider: "opencode",
            base_url: "https://opencode.ai/zen/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 128000,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek V4 Flash Vision Exp (Zen)",
            api: "openai-completions",
            provider: "opencode",
            base_url: "https://opencode.ai/zen/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 384000,
            cost: ModelCost { input: 0.14, output: 0.28, cache_read: null, cache_write: null },
        },
    ]
}

// OpenCode Go variant on its own basePath (same arm pinning).
function _opencode_go_models() -> Model[] {
    [
        Model {
            id: "qwen3.7-max",
            name: "Qwen3.7 Max (Zen Go)",
            api: "openai-completions",
            provider: "opencode-go",
            base_url: "https://opencode.ai/zen/go/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 65536,
            cost: ModelCost { input: 2.5, output: 7.5, cache_read: null, cache_write: null },
        },
        Model {
            id: "longcat-2.0",
            name: "LongCat-2.0 (Zen Go)",
            api: "openai-completions",
            provider: "opencode-go",
            base_url: "https://opencode.ai/zen/go/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 131072,
            cost: ModelCost { input: 0.3, output: 1.2, cache_read: null, cache_write: null },
        },
    ]
}

// Xiaomi MiMo flagships (models.dev xiaomi, 2026-09) on the API billing
// endpoint. The three token-plan variants serve the same ids on their
// regional prepaid endpoints with plan billing (0.0 advisory here).
function _xiaomi_models() -> Model[] {
    [
        Model {
            id: "mimo-v2.5",
            name: "MiMo-V2.5 (Xiaomi)",
            api: "openai-completions",
            provider: "xiaomi",
            base_url: "https://api.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.14, output: 0.28, cache_read: null, cache_write: null },
        },
        Model {
            id: "mimo-v2.5-pro",
            name: "MiMo-V2.5-Pro (Xiaomi)",
            api: "openai-completions",
            provider: "xiaomi",
            base_url: "https://api.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.435, output: 0.87, cache_read: null, cache_write: null },
        },
    ]
}

function _xiaomi_ams_models() -> Model[] {
    [
        Model {
            id: "mimo-v2.5",
            name: "MiMo-V2.5 (Xiaomi AMS)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-ams",
            base_url: "https://token-plan-ams.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "mimo-v2.5-pro",
            name: "MiMo-V2.5-Pro (Xiaomi AMS)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-ams",
            base_url: "https://token-plan-ams.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
}

function _xiaomi_cn_models() -> Model[] {
    [
        Model {
            id: "mimo-v2.5",
            name: "MiMo-V2.5 (Xiaomi CN)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-cn",
            base_url: "https://token-plan-cn.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "mimo-v2.5-pro",
            name: "MiMo-V2.5-Pro (Xiaomi CN)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-cn",
            base_url: "https://token-plan-cn.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
}

function _xiaomi_sgp_models() -> Model[] {
    [
        Model {
            id: "mimo-v2.5",
            name: "MiMo-V2.5 (Xiaomi SGP)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-sgp",
            base_url: "https://token-plan-sgp.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "mimo-v2.5-pro",
            name: "MiMo-V2.5-Pro (Xiaomi SGP)",
            api: "openai-completions",
            provider: "xiaomi-token-plan-sgp",
            base_url: "https://token-plan-sgp.xiaomimimo.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
}

// Ant Ling lineup transcribed verbatim from pi's generate-models static
// block (not on models.dev): Ling flash + Ring reasoning flagship.
function _ant_ling_models() -> Model[] {
    [
        Model {
            id: "Ling-2.6-flash",
            name: "Ling 2.6 Flash",
            api: "openai-completions",
            provider: "ant-ling",
            base_url: "https://api.ant-ling.com/v1",
            reasoning: false,
            input: ["text"],
            context_window: 262144,
            max_tokens: 65536,
            cost: ModelCost { input: 0.01, output: 0.02, cache_read: null, cache_write: null },
        },
        Model {
            id: "Ring-2.6-1T",
            name: "Ring 2.6 1T",
            api: "openai-completions",
            provider: "ant-ling",
            base_url: "https://api.ant-ling.com/v1",
            reasoning: true,
            input: ["text"],
            context_window: 262144,
            max_tokens: 65536,
            cost: ModelCost { input: 0.06, output: 0.25, cache_read: null, cache_write: null },
        },
    ]
}

// MiniMax CN flagships (models.dev minimax-cn, 2026-09) on the domestic
// anthropic-messages endpoint.
function _minimax_cn_models() -> Model[] {
    [
        Model {
            id: "MiniMax-M2.5",
            name: "MiniMax-M2.5 (CN)",
            api: "anthropic-messages",
            provider: "minimax-cn",
            base_url: "https://api.minimaxi.com/anthropic",
            reasoning: true,
            input: ["text"],
            context_window: 204800,
            max_tokens: 131072,
            cost: ModelCost { input: 0.3, output: 1.2, cache_read: null, cache_write: null },
        },
        Model {
            id: "MiniMax-M2.1",
            name: "MiniMax-M2.1 (CN)",
            api: "anthropic-messages",
            provider: "minimax-cn",
            base_url: "https://api.minimaxi.com/anthropic",
            reasoning: true,
            input: ["text"],
            context_window: 204800,
            max_tokens: 131072,
            cost: ModelCost { input: 0.3, output: 1.2, cache_read: null, cache_write: null },
        },
    ]
}

// Moonshot CN flagships (models.dev moonshotai-cn, 2026-09).
function _moonshotai_cn_models() -> Model[] {
    [
        Model {
            id: "kimi-k2.5",
            name: "Kimi K2.5 (CN)",
            api: "openai-completions",
            provider: "moonshotai-cn",
            base_url: "https://api.moonshot.cn/v1",
            reasoning: true,
            input: ["text"],
            context_window: 262144,
            max_tokens: 262144,
            cost: ModelCost { input: 0.6, output: 3.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "kimi-k3",
            name: "Kimi K3 (CN)",
            api: "openai-completions",
            provider: "moonshotai-cn",
            base_url: "https://api.moonshot.cn/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1048576,
            max_tokens: 131072,
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: null, cache_write: null },
        },
    ]
}

// Qwen Token Plan CN (models.dev alibaba-token-plan-cn, 2026-09).
function _qwen_token_plan_cn_models() -> Model[] {
    [
        Model {
            id: "qwen3.7-max",
            name: "Qwen3.7 Max (CN)",
            api: "openai-completions",
            provider: "qwen-token-plan-cn",
            base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "qwen3.6-plus",
            name: "Qwen3.6 Plus (CN)",
            api: "openai-completions",
            provider: "qwen-token-plan-cn",
            base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 65536,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
}

// Individual is pi's narrower QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS view
// over the international source (models.dev alibaba-token-plan).
function _qwen_token_plan_individual_models() -> Model[] {
    [
        Model {
            id: "qwen3.7-max",
            name: "Qwen3.7 Max (Individual)",
            api: "openai-completions",
            provider: "qwen-token-plan-individual",
            base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "deepseek-v4-pro-0813",
            name: "DeepSeek V4 Pro 0813 (Individual)",
            api: "openai-completions",
            provider: "qwen-token-plan-individual",
            base_url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 384000,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
    ]
}

// Z.AI Coding CN (models.dev zhipuai-coding-plan, 2026-09) on the
// bigmodel.cn endpoint.
function _zai_coding_cn_models() -> Model[] {
    [
        Model {
            id: "glm-5.3",
            name: "GLM-5.3 (CN)",
            api: "openai-completions",
            provider: "zai-coding-cn",
            base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 131072,
            cost: ModelCost { input: 0.0, output: 0.0, cache_read: null, cache_write: null },
        },
        Model {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash (CN)",
            api: "openai-completions",
            provider: "zai-coding-cn",
            base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
            reasoning: true,
            input: ["text"],
            context_window: 1000000,
            max_tokens: 131072,
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

// Image parts only reach models whose input list says so — pasting onto
// a text-only model fails here instead of at the provider wire.
function ModelSupportsImage(id: string) -> bool {
    match (GetModel(id)) {
        null => false,
        let m: Model => {
            let ok = false;
            for (let i in m.input) {
                if (i == "image") {
                    ok = true
                }
            }
            ok
        },
    }
}

// bi#89: host-owned catalog refresh, BAML-validated. The host fetches the
// remote listing (fetch/dedupe/abort are host concerns — see
// src/models.ts refreshCatalog, mirroring pi's per-runtime refresh
// coordinator); every candidate entry passes through here before it can
// join the overlay. Valid entries come out as full Model rows (the
// validated catalog schema); anything else becomes a loud error and never
// reaches the overlay. Strict on purpose: unknown provider poisons the
// whole batch, and each entry needs a bare id (no provider/id scoped
// form), a known wire arm, and positive context_window/max_tokens — the
// host fetcher enriches wire listings that lack them. First-valid-wins
// on duplicate ids.
class RefreshedModel {
    id: string,
    name: string?,
    api: string?,
    reasoning: bool?,
    context_window: int?,
    max_tokens: int?,
}

class RefreshEntryError {
    id: string,
    reason: string,
}

class RefreshedValidation {
    valid: Model[],
    errors: RefreshEntryError[],
}

class CheckedRefreshedEntry {
    model: Model?,
    error: string?,
}

function _refresh_api_arms() -> string[] {
    ["anthropic-messages", "openai-completions", "openai-responses", "google", "azure-responses"]
}

function _check_refreshed_entry(
    p: Provider,
    e: RefreshedModel,
    seen: string[],
) -> CheckedRefreshedEntry {
    if (e.id.length() == 0) {
        return CheckedRefreshedEntry { model: null, error: "empty model id" };
    }
    if (!(e.id.index_of("/") is null)) {
        return CheckedRefreshedEntry {
            model: null,
            error: `scoped id "${e.id}" — refresh entries are bare ids`,
        };
    }
    if (seen.includes(e.id)) {
        return CheckedRefreshedEntry { model: null, error: `duplicate id "${e.id}" — first entry wins` };
    }
    let api = e.api ?? p.api;
    if (!_refresh_api_arms().includes(api)) {
        return CheckedRefreshedEntry { model: null, error: `unknown api "${api}" for "${e.id}"` };
    }
    match (e.context_window) {
        null => CheckedRefreshedEntry { model: null, error: `missing context_window for "${e.id}"` },
        let cw: int => {
            match (e.max_tokens) {
                null => {
                    CheckedRefreshedEntry { model: null, error: `missing max_tokens for "${e.id}"` }
                },
                let mt: int => {
                    if (cw < 1) {
                        CheckedRefreshedEntry {
                            model: null,
                            error: `non-positive context_window for "${e.id}"`,
                        }
                    } else if (mt < 1) {
                        CheckedRefreshedEntry {
                            model: null,
                            error: `non-positive max_tokens for "${e.id}"`,
                        }
                    } else {
                        CheckedRefreshedEntry {
                            model: Model {
                                id: e.id,
                                name: e.name ?? e.id,
                                api: api,
                                provider: p.id,
                                base_url: p.base_url,
                                reasoning: e.reasoning ?? false,
                                input: ["text"],
                                context_window: cw,
                                max_tokens: mt,
                                cost: ModelCost {
                                    input: 0.0,
                                    output: 0.0,
                                    cache_read: null,
                                    cache_write: null,
                                },
                            },
                            error: null,
                        }
                    }
                },
            }
        },
    }
}

function validate_refreshed_models(
    provider: string,
    entries: RefreshedModel[],
) -> RefreshedValidation {
    let valid: Model[] = [];
    let errors: RefreshEntryError[] = [];
    match (GetProvider(provider)) {
        null => {
            for (let e in entries) {
                errors.push(
                    RefreshEntryError { id: e.id, reason: `unknown provider "${provider}"` },
                )
            }
        },
        let p: Provider => {
            let seen: string[] = [];
            for (let e in entries) {
                let checked = _check_refreshed_entry(p, e, seen);
                match (checked.model) {
                    null => {
                        errors.push(
                            RefreshEntryError { id: e.id, reason: checked.error ?? "invalid entry" },
                        )
                    },
                    let m: Model => {
                        valid.push(m);
                        seen.push(m.id)
                    },
                }
            }
        },
    }
    RefreshedValidation { valid: valid, errors: errors }
}
