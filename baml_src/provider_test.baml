testset "provider registry" {
    test "ListProviders returns 20" {
        assert.equal(ListProviders().length(), 20)
    }

    test "GetProvider groq has chat-completions api and auth env" {
        let p = GetProvider("groq");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://api.groq.com/openai/v1");
                assert.equal(prov.api, "openai-completions")
            },
            _ => assert.is_true(false),
        }
    }

    test "ProviderAuthEnv returns canonical env vars" {
        match (ProviderAuthEnv("groq")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "GROQ_API_KEY"),
        }
        match (ProviderAuthEnv("deepseek")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "DEEPSEEK_API_KEY"),
        }
        match (ProviderAuthEnv("anthropic")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "ANTHROPIC_API_KEY"),
        }
        match (ProviderAuthEnv("openai_responses")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "OPENAI_API_KEY"),
        }
        // Non-KEY-suffixed var name also resolves (token, not key).
        match (ProviderAuthEnv("huggingface")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "HF_TOKEN"),
        }
        match (ProviderAuthEnv("fireworks")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "FIREWORKS_API_KEY"),
        }
        match (ProviderAuthEnv("xai")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "XAI_API_KEY"),
        }
        assert.is_true(ProviderAuthEnv("bogus") is null)
    }

    test "GetProvider xai routes the responses arm" {
        let p = GetProvider("xai");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://api.x.ai/v1");
                assert.equal(prov.api, "openai-responses")
            },
            _ => assert.is_true(false),
        }
    }

    test "GetProvider azure has empty base_url sentinel and azure arm" {
        let p = GetProvider("azure-openai-responses");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.base_url, "");
                assert.equal(prov.api, "azure-responses")
            },
            _ => assert.is_true(false),
        }
    }

    test "ProviderAuthEnv azure names AZURE_OPENAI_API_KEY" {
        match (ProviderAuthEnv("azure-openai-responses")) {
            let v: string => assert.equal(v, "AZURE_OPENAI_API_KEY"),
            _ => assert.is_true(false),
        }
    }

    test "GetProvider anthropic has correct base_url and api" {
        let p = GetProvider("anthropic");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.name, "Anthropic");
                assert.equal(prov.base_url, "https://api.anthropic.com");
                assert.equal(prov.api, "anthropic-messages")
            },
            _ => assert.is_true(false),
        }
    }

    test "GetProvider unknown returns null" {
        assert.is_true(GetProvider("bogus") is null)
    }

    test "ProviderExists true for known, false for unknown" {
        assert.is_true(ProviderExists("google"));
        assert.is_true(!ProviderExists("bogus"))
    }

    test "ProviderForModel maps model to its provider" {
        let p = ProviderForModel("claude-haiku-4-5");
        assert.not_null(p);
        match (p) {
            let prov: Provider => assert.equal(prov.id, "anthropic"),
            _ => assert.is_true(false),
        }
        let q = ProviderForModel("gemini-2.0-flash");
        assert.not_null(q);
        match (q) {
            let prov: Provider => assert.equal(prov.id, "google"),
            _ => assert.is_true(false),
        }
        assert.is_true(ProviderForModel("nope") is null)
    }

    test "ListModels via provider id matches provider registry" {
        let prov = GetProvider("openai");
        assert.not_null(prov);
        match (prov) {
            let p: Provider => {
                let models = ListModels(p.id);
                assert.equal(models.length(), 2)
            },
            _ => assert.is_true(false),
        }
    }

    test "RefreshModels returns true for known provider, false for bogus" {
        assert.is_true(RefreshModels("anthropic"));
        assert.is_true(RefreshModels("google"));
        assert.is_true(!RefreshModels("bogus"))
    }

    test "RefreshAllModels returns provider count" {
        assert.equal(RefreshAllModels(), 20)
    }

    test "RefreshModelsWithResult static vs remote vs unknown" {
        let a = RefreshModelsWithResult("anthropic");
        assert.is_true(a.refreshed);
        assert.equal(a.source, "static");
        assert.equal(a.model_count, 3);
        let b = RefreshModelsWithResult("anthropic", allow_network = true, remote_count = 7);
        assert.is_true(b.refreshed);
        assert.equal(b.source, "remote");
        assert.equal(b.model_count, 3);
        let c = RefreshModelsWithResult("bogus", allow_network = true, remote_count = 5);
        assert.is_true(!c.refreshed);
        assert.equal(c.source, "unknown");
        assert.equal(c.model_count, 0)
    }
}
