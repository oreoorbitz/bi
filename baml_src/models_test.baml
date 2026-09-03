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

    test "ListAllModels returns 43" {
        assert.equal(ListAllModels().length(), 43)
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
        assert.equal(ListModels("zai").length(), 2);
        assert.equal(ListModels("huggingface").length(), 2);
        assert.equal(ListModels("baseten").length(), 2);
        assert.equal(ListModels("mistral").length(), 2);
        assert.equal(ListModels("fireworks").length(), 2);
        assert.equal(ListModels("xai").length(), 2);
        assert.equal(ListModels("minimax").length(), 2);
        assert.equal(ListModels("kimi-coding").length(), 2);
        assert.equal(ListModels("openrouter").length(), 2);
        assert.equal(ListModels("qwen-token-plan").length(), 2)
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
