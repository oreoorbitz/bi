testset "provider registry" {
    test "ListProviders returns 3" {
        assert.equal(ListProviders().length(), 3)
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
        assert.equal(RefreshAllModels(), 3)
    }
}
