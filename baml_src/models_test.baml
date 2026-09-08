testset "model catalog" {
    test "ListModels anthropic returns 3" {
        assert.equal(ListModels("anthropic").length(), 3)
    }

    test "ListModels google returns 2" {
        assert.equal(ListModels("google").length(), 2)
    }

    test "ListModels openai returns 2" {
        assert.equal(ListModels("openai").length(), 2)
    }

    test "ListAllModels returns 82" {
        assert.equal(ListAllModels().length(), 82)
    }

    test "ListModels azure returns advisory deployments" {
        let ms = ListModels("azure-openai-responses");
        assert.equal(ms.length(), 2);
        assert.equal(ms[0].api, "azure-responses");
        assert.equal(ms[0].provider, "azure-openai-responses")
    }

    test "ListModels cloudflare returns template-based workers" {
        let ms = ListModels("cloudflare-workers-ai");
        assert.equal(ms.length(), 2);
        assert.equal(ms[0].api, "openai-completions");
        assert.is_true(ms[0].base_url.includes("{CLOUDFLARE_ACCOUNT_ID}"))
    }

    test "ListModels compat providers return 2 each" {
        assert.equal(ListModels("groq").length(), 2);
        assert.equal(ListModels("deepseek").length(), 2);
        assert.equal(ListModels("together").length(), 2);
        assert.equal(ListModels("cerebras").length(), 2);
        assert.equal(ListModels("moonshotai").length(), 2);
        assert.equal(ListModels("nvidia").length(), 2);
        assert.equal(ListModels("zai").length(), 4);
        assert.equal(ListModels("meta").length(), 5);
        assert.equal(ListModels("huggingface").length(), 2);
        assert.equal(ListModels("baseten").length(), 2);
        assert.equal(ListModels("mistral").length(), 2);
        assert.equal(ListModels("fireworks").length(), 2);
        assert.equal(ListModels("xai").length(), 4);
        assert.equal(ListModels("minimax").length(), 2);
        assert.equal(ListModels("kimi-coding").length(), 2);
        assert.equal(ListModels("openrouter").length(), 2);
        assert.equal(ListModels("qwen-token-plan").length(), 2)
    }

    test "ListModels batch-4 providers return 2 each on their pinned arm" {
        assert.equal(ListModels("cloudflare-ai-gateway").length(), 2);
        assert.equal(ListModels("vercel-ai-gateway").length(), 2);
        assert.equal(ListModels("github-copilot").length(), 2);
        assert.equal(ListModels("opencode").length(), 2);
        assert.equal(ListModels("opencode-go").length(), 2);
        assert.equal(ListModels("xiaomi").length(), 2);
        assert.equal(ListModels("xiaomi-token-plan-ams").length(), 2);
        assert.equal(ListModels("xiaomi-token-plan-cn").length(), 2);
        assert.equal(ListModels("xiaomi-token-plan-sgp").length(), 2);
        assert.equal(ListModels("ant-ling").length(), 2);
        assert.equal(ListModels("minimax-cn").length(), 2);
        assert.equal(ListModels("moonshotai-cn").length(), 2);
        assert.equal(ListModels("qwen-token-plan-cn").length(), 2);
        assert.equal(ListModels("qwen-token-plan-individual").length(), 2);
        assert.equal(ListModels("zai-coding-cn").length(), 2);
        assert.equal(ListModels("cloudflare-ai-gateway")[0].api, "openai-responses");
        assert.equal(ListModels("vercel-ai-gateway")[0].api, "anthropic-messages");
        assert.equal(ListModels("github-copilot")[0].api, "openai-completions");
        assert.equal(ListModels("minimax-cn")[0].api, "anthropic-messages")
    }

    test "GetModel batch-4 flagships pin provider, arm, and gateway template" {
        let g = GetModel("openai/gpt-4o-mini");
        assert.not_null(g);
        match (g) {
            let model: Model => {
                assert.equal(model.provider, "cloudflare-ai-gateway");
                assert.equal(model.api, "openai-responses");
                assert.is_true(model.base_url.includes("{CLOUDFLARE_GATEWAY_ID}"))
            },
            _ => assert.is_true(false),
        }
        let c = GetModel("gpt-6-astra");
        assert.not_null(c);
        match (c) {
            let model: Model => {
                assert.equal(model.provider, "github-copilot");
                assert.equal(model.api, "openai-completions");
                assert.is_true(model.reasoning)
            },
            _ => assert.is_true(false),
        }
        let l = GetModel("Ling-2.6-flash");
        assert.not_null(l);
        match (l) {
            let model: Model => {
                assert.equal(model.provider, "ant-ling");
                assert.is_true(!model.reasoning);
                assert.equal(model.context_window, 262144)
            },
            _ => assert.is_true(false),
        }
        let m = GetModel("MiniMax-M2.5");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "minimax-cn");
                assert.equal(model.api, "anthropic-messages")
            },
            _ => assert.is_true(false),
        }
        // NOTE: glm-5.3* ids collide with the intl zai catalog (first
        // match wins), so the CN spot check uses kimi-k3 instead.
        let z = GetModel("kimi-k3");
        assert.not_null(z);
        match (z) {
            let model: Model => {
                assert.equal(model.provider, "moonshotai-cn");
                assert.equal(model.context_window, 1048576)
            },
            _ => assert.is_true(false),
        }
        let d = GetModel("deepseek-v4-pro-0813");
        assert.not_null(d);
        match (d) {
            let model: Model => {
                assert.equal(model.provider, "qwen-token-plan-individual");
                assert.equal(model.max_tokens, 384000)
            },
            _ => assert.is_true(false),
        }
    }

    test "GetModel muse-spark-1.3 is meta reasoning with 1M context" {
        let m = GetModel("muse-spark-1.3");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "meta");
                assert.equal(model.api, "openai-completions");
                assert.is_true(model.reasoning);
                assert.equal(model.context_window, 1048576);
                assert.equal(model.cost.input, 1.25);
                assert.equal(model.cost.output, 4.25)
            },
            _ => assert.is_true(false),
        }
    }

    test "GetModel grok-4.6 is xai reasoning with base-tier pricing" {
        let m = GetModel("grok-4.6");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "xai");
                assert.equal(model.api, "openai-responses");
                assert.is_true(model.reasoning);
                assert.equal(model.context_window, 500000);
                assert.equal(model.cost.input, 2.0);
                assert.equal(model.cost.output, 6.0)
            },
            _ => assert.is_true(false),
        }
    }

    test "GetModel fireworks pins the anthropic-messages arm" {
        let m = GetModel("accounts/fireworks/models/kimi-k2-instruct");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "fireworks");
                assert.equal(model.api, "anthropic-messages")
            },
            _ => assert.is_true(false),
        }
    }

    test "GetModel deepseek-chat has completions api and reasoning flag" {
        let m = GetModel("deepseek-chat");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "deepseek");
                assert.equal(model.api, "openai-completions");
                assert.is_true(!model.reasoning)
            },
            _ => assert.is_true(false),
        }
        assert.is_true(ModelSupportsReasoning("deepseek-reasoner"))
    }

    test "GetModel known id returns correct provider and api" {
        let m = GetModel("claude-haiku-4-5");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.provider, "anthropic");
                assert.equal(model.api, "anthropic-messages");
                assert.equal(model.name, "Claude Haiku 4.5");
                assert.is_true(model.context_window == 200000);
            },
            _ => assert.is_true(false),
        }
    }

    test "GetModel unknown returns null" {
        assert.is_true(GetModel("nope") is null)
    }

    test "ModelSupportsImage follows the input list" {
        assert.is_true(ModelSupportsImage("muse-spark-1.3"));
        assert.is_true(ModelSupportsImage("grok-4.6"));
        assert.is_true(!ModelSupportsImage("grok-build-0.1"));
        assert.is_true(!ModelSupportsImage("bogus-model"))
    }

    test "ModelSupportsReasoning true for reasoning model" {
        assert.is_true(ModelSupportsReasoning("claude-sonnet-4-5"));
        assert.is_true(ModelSupportsReasoning("gemini-2.5-pro"))
    }

    test "ModelSupportsReasoning false for non-reasoning" {
        assert.is_true(!ModelSupportsReasoning("claude-haiku-4-5"));
        assert.is_true(!ModelSupportsReasoning("gpt-4o-mini"))
    }

    test "ListModels unknown provider returns empty" {
        assert.equal(ListModels("bogus").length(), 0)
    }

    test "Model cost fields are present" {
        let m = GetModel("gemini-2.0-flash");
        assert.not_null(m);
        match (m) {
            let model: Model => {
                assert.equal(model.cost.input, 0.1);
                assert.equal(model.cost.output, 0.4);
            },
            _ => assert.is_true(false),
        }
    }
}

testset "catalog refresh" {
    test "unknown provider poisons the batch" {
        let v = validate_refreshed_models(
            "bogus",
            [
                RefreshedModel {
                    id: "x-1",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
            ],
        );
        assert.equal(v.valid.length(), 0);
        assert.equal(v.errors.length(), 1);
        assert.contains(v.errors[0].reason, "unknown provider")
    }

    test "sparse entry fills provider defaults" {
        let v = validate_refreshed_models(
            "openai",
            [
                RefreshedModel {
                    id: "gpt-9",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 128000,
                    max_tokens: 16384,
                },
            ],
        );
        assert.equal(v.errors.length(), 0);
        assert.equal(v.valid.length(), 1);
        let m = v.valid[0];
        assert.equal(m.id, "gpt-9");
        assert.equal(m.name, "gpt-9");
        assert.equal(m.provider, "openai");
        assert.equal(m.api, "openai-responses");
        assert.equal(m.base_url, "https://api.openai.com/v1");
        assert.is_true(!m.reasoning)
    }

    test "explicit api and reasoning survive" {
        let v = validate_refreshed_models(
            "groq",
            [
                RefreshedModel {
                    id: "llama-9",
                    name: "Llama 9",
                    api: "openai-completions",
                    reasoning: true,
                    context_window: 128000,
                    max_tokens: 8192,
                },
            ],
        );
        assert.equal(v.errors.length(), 0);
        assert.equal(v.valid[0].api, "openai-completions");
        assert.is_true(v.valid[0].reasoning)
    }

    test "bad entries fail loudly, first duplicate wins" {
        let v = validate_refreshed_models(
            "openai",
            [
                RefreshedModel {
                    id: "",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "openai/gpt-9",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "gpt-9",
                    name: "First",
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "gpt-9",
                    name: "Second",
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "weird",
                    name: null,
                    api: "soap",
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "nowindow",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: null,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "notokens",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: null,
                },
                RefreshedModel {
                    id: "negwindow",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 0,
                    max_tokens: 100,
                },
                RefreshedModel {
                    id: "negtokens",
                    name: null,
                    api: null,
                    reasoning: null,
                    context_window: 1000,
                    max_tokens: -5,
                },
            ],
        );
        assert.equal(v.valid.length(), 1);
        assert.equal(v.valid[0].name, "First");
        assert.equal(v.errors.length(), 8);
        assert.contains(v.errors[0].reason, "empty model id");
        assert.contains(v.errors[1].reason, "bare ids");
        assert.contains(v.errors[2].reason, "duplicate");
        assert.contains(v.errors[3].reason, "unknown api");
        assert.contains(v.errors[4].reason, "context_window");
        assert.contains(v.errors[5].reason, "max_tokens");
        assert.contains(v.errors[6].reason, "context_window");
        assert.contains(v.errors[7].reason, "max_tokens")
    }

    test "empty batch validates clean" {
        let v = validate_refreshed_models("anthropic", []);
        assert.equal(v.valid.length(), 0);
        assert.equal(v.errors.length(), 0)
    }
}
