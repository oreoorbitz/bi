testset "provider registry" {
    test "ListProviders returns 22" {
        assert.equal(ListProviders().length(), 37)
    }

    test "GetProvider meta is openai-completions over api.meta.ai" {
        let p = GetProvider("meta");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://api.meta.ai/v1");
                assert.equal(prov.api, "openai-completions");
                assert.equal(prov.auth_env, "META_API_KEY")
            },
            _ => assert.is_true(false),
        }
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
        // Full-table parity with pi's envApiKeyAuth single-var lists
        // (bi#17): every ported provider names exactly pi's var.
        match (ProviderAuthEnv("google")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "GEMINI_API_KEY"),
        }
        match (ProviderAuthEnv("together")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "TOGETHER_API_KEY"),
        }
        match (ProviderAuthEnv("cerebras")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "CEREBRAS_API_KEY"),
        }
        match (ProviderAuthEnv("moonshotai")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "MOONSHOT_API_KEY"),
        }
        match (ProviderAuthEnv("nvidia")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "NVIDIA_API_KEY"),
        }
        match (ProviderAuthEnv("meta")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "META_API_KEY"),
        }
        match (ProviderAuthEnv("zai")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "ZAI_API_KEY"),
        }
        match (ProviderAuthEnv("baseten")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "BASETEN_API_KEY"),
        }
        match (ProviderAuthEnv("mistral")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "MISTRAL_API_KEY"),
        }
        match (ProviderAuthEnv("minimax")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "MINIMAX_API_KEY"),
        }
        match (ProviderAuthEnv("kimi-coding")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "KIMI_API_KEY"),
        }
        match (ProviderAuthEnv("openrouter")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "OPENROUTER_API_KEY"),
        }
        match (ProviderAuthEnv("qwen-token-plan")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "QWEN_TOKEN_PLAN_API_KEY"),
        }
        match (ProviderAuthEnv("azure-openai-responses")) {
            null => assert.is_true(false),
            let v: string => assert.equal(v, "AZURE_OPENAI_API_KEY"),
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

    test "GetProvider cloudflare keeps the account template and key var" {
        let p = GetProvider("cloudflare-workers-ai");
        assert.not_null(p);
        match (p) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-completions");
                assert.is_true(prov.base_url.includes("{CLOUDFLARE_ACCOUNT_ID}"))
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("cloudflare-workers-ai")) {
            let v: string => assert.equal(v, "CLOUDFLARE_API_KEY"),
            _ => assert.is_true(false),
        }
    }

    test "GetProvider gateways land with their template url and key var" {
        let g = GetProvider("cloudflare-ai-gateway");
        assert.not_null(g);
        match (g) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-responses");
                assert.is_true(prov.base_url.includes("{CLOUDFLARE_ACCOUNT_ID}"));
                assert.is_true(prov.base_url.includes("{CLOUDFLARE_GATEWAY_ID}"))
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("cloudflare-ai-gateway")) {
            let v: string => assert.equal(v, "CLOUDFLARE_API_KEY"),
            _ => assert.is_true(false),
        }
        let v = GetProvider("vercel-ai-gateway");
        assert.not_null(v);
        match (v) {
            let prov: Provider => {
                assert.equal(prov.api, "anthropic-messages");
                assert.equal(prov.base_url, "https://ai-gateway.vercel.sh")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("vercel-ai-gateway")) {
            let w: string => assert.equal(w, "AI_GATEWAY_API_KEY"),
            _ => assert.is_true(false),
        }
    }

    test "GetProvider copilot and zen pin completions with their key var" {
        match (GetProvider("github-copilot")) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-completions");
                assert.equal(prov.base_url, "https://api.individual.githubcopilot.com")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("github-copilot")) {
            let v: string => assert.equal(v, "COPILOT_GITHUB_TOKEN"),
            _ => assert.is_true(false),
        }
        match (GetProvider("opencode")) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-completions");
                assert.equal(prov.base_url, "https://opencode.ai/zen/v1")
            },
            _ => assert.is_true(false),
        }
        match (GetProvider("opencode-go")) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-completions");
                assert.equal(prov.base_url, "https://opencode.ai/zen/go/v1")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("opencode-go")) {
            let v: string => assert.equal(v, "OPENCODE_API_KEY"),
            _ => assert.is_true(false),
        }
    }

    test "GetProvider xiaomi family lands with regional endpoints" {
        match (GetProvider("xiaomi")) {
            let prov: Provider => assert.equal(prov.base_url, "https://api.xiaomimimo.com/v1"),
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("xiaomi")) {
            let v: string => assert.equal(v, "XIAOMI_API_KEY"),
            _ => assert.is_true(false),
        }
        match (GetProvider("xiaomi-token-plan-cn")) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://token-plan-cn.xiaomimimo.com/v1")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("xiaomi-token-plan-cn")) {
            let v: string => assert.equal(v, "XIAOMI_TOKEN_PLAN_CN_API_KEY"),
            _ => assert.is_true(false),
        }
        match (GetProvider("xiaomi-token-plan-ams")) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://token-plan-ams.xiaomimimo.com/v1")
            },
            _ => assert.is_true(false),
        }
        match (GetProvider("xiaomi-token-plan-sgp")) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://token-plan-sgp.xiaomimimo.com/v1")
            },
            _ => assert.is_true(false),
        }
        assert.is_true(ProviderExists("xiaomi-token-plan-ams"));
        assert.is_true(ProviderExists("xiaomi-token-plan-sgp"))
    }

    test "GetProvider CN variants land with domestic endpoints" {
        match (GetProvider("ant-ling")) {
            let prov: Provider => {
                assert.equal(prov.api, "openai-completions");
                assert.equal(prov.base_url, "https://api.ant-ling.com/v1")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("ant-ling")) {
            let v: string => assert.equal(v, "ANT_LING_API_KEY"),
            _ => assert.is_true(false),
        }
        match (GetProvider("minimax-cn")) {
            let prov: Provider => {
                assert.equal(prov.api, "anthropic-messages");
                assert.equal(prov.base_url, "https://api.minimaxi.com/anthropic")
            },
            _ => assert.is_true(false),
        }
        match (GetProvider("moonshotai-cn")) {
            let prov: Provider => assert.equal(prov.base_url, "https://api.moonshot.cn/v1"),
            _ => assert.is_true(false),
        }
        // pi shares one var across the moonshot pair and the qwen pair.
        match (ProviderAuthEnv("moonshotai-cn")) {
            let v: string => assert.equal(v, "MOONSHOT_API_KEY"),
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("moonshotai")) {
            let v: string => assert.equal(v, "MOONSHOT_API_KEY"),
            _ => assert.is_true(false),
        }
        match (GetProvider("qwen-token-plan-cn")) {
            let prov: Provider => {
                assert.equal(
                    prov.base_url,
                    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
                )
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("qwen-token-plan-cn")) {
            let v: string => assert.equal(v, "QWEN_TOKEN_PLAN_CN_API_KEY"),
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("qwen-token-plan-individual")) {
            let v: string => assert.equal(v, "QWEN_TOKEN_PLAN_API_KEY"),
            _ => assert.is_true(false),
        }
        match (GetProvider("zai-coding-cn")) {
            let prov: Provider => {
                assert.equal(prov.base_url, "https://open.bigmodel.cn/api/coding/paas/v4")
            },
            _ => assert.is_true(false),
        }
        match (ProviderAuthEnv("zai-coding-cn")) {
            let v: string => assert.equal(v, "ZAI_CODING_CN_API_KEY"),
            _ => assert.is_true(false),
        }
    }

    test "provider_headers sends copilot static headers and nothing else" {
        match (provider_headers("github-copilot")) {
            let h: map<string, string> => {
                assert.equal(h["Copilot-Integration-Id"], "vscode-chat");
                assert.is_true(h["User-Agent"].includes("GitHubCopilotChat"))
            },
            _ => assert.is_true(false),
        }
        assert.is_true(provider_headers("groq") is null);
        assert.is_true(provider_headers("bogus") is null)
    }

    test "resolve_endpoint_template passes plain urls through" {
        assert.equal(resolve_endpoint_template("https://api.x.ai/v1"), "https://api.x.ai/v1");
        assert.equal(resolve_endpoint_template(""), "")
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

    test "MissingKeyMessage names the var for known providers" {
        assert.equal(
            MissingKeyMessage("groq"),
            "groq needs an API key: pass --api-key, set GROQ_API_KEY, or run `bi login groq`",
        );
        assert.equal(
            MissingKeyMessage("openai_responses"),
            "openai_responses needs an API key: pass --api-key, set OPENAI_API_KEY, or run `bi login openai_responses`",
        );
        assert.equal(
            MissingKeyMessage("huggingface"),
            "huggingface needs an API key: pass --api-key, set HF_TOKEN, or run `bi login huggingface`",
        );
        assert.equal(
            MissingKeyMessage("azure-openai-responses"),
            "azure-openai-responses needs an API key: pass --api-key, set AZURE_OPENAI_API_KEY, or run `bi login azure-openai-responses`",
        );
        // bi#15 gateway/CN ids resolve now that they are catalogued.
        assert.equal(
            MissingKeyMessage("cloudflare-ai-gateway"),
            "cloudflare-ai-gateway needs an API key: pass --api-key, set CLOUDFLARE_API_KEY, or run `bi login cloudflare-ai-gateway`",
        );
        assert.equal(
            MissingKeyMessage("minimax-cn"),
            "minimax-cn needs an API key: pass --api-key, set MINIMAX_CN_API_KEY, or run `bi login minimax-cn`",
        )
    }

    test "MissingKeyMessage says unknown for unmapped ids, never a panic" {
        assert.equal(
            MissingKeyMessage("bogus"),
            "unknown provider \"bogus\": no auth mapping (see ListProviders)",
        );
        // Custom-wire bi#15 ids never land (no BAML client arm) — they
        // stay unknown rather than listed-but-broken.
        assert.is_true(MissingKeyMessage("amazon-bedrock").includes("unknown provider"));
        assert.is_true(MissingKeyMessage("google-vertex").includes("unknown provider"));
        assert.is_true(MissingKeyMessage("openai-codex").includes("unknown provider"));
        assert.is_true(MissingKeyMessage("radius").includes("unknown provider"))
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
        assert.equal(RefreshAllModels(), 37)
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
