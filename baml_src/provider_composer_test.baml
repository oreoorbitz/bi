testset "provider_composer" {
    test "compose with only base returns base" {
        let base = ComposedProvider {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            api: "anthropic",
            headers: null,
            models: [
                ComposedModel {
                    id: "claude-haiku",
                    name: "Haiku",
                    api: "anthropic",
                    provider: "anthropic",
                    base_url: "https://api.anthropic.com",
                    reasoning: true,
                    context_window: 200000,
                    max_tokens: 8192,
                    headers: null,
                },
            ],
        };
        let out = compose_provider("anthropic", base, null);
        assert.equal(out.id, "anthropic");
        assert.equal(out.base_url, "https://api.anthropic.com");
        assert.equal(out.models.length(), 1);
    }

    test "extension baseUrl overlays base models" {
        let base = ComposedProvider {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            api: "anthropic",
            headers: null,
            models: [
                ComposedModel {
                    id: "haiku",
                    name: "Haiku",
                    api: "anthropic",
                    provider: "anthropic",
                    base_url: "https://api.anthropic.com",
                    reasoning: false,
                    context_window: 100000,
                    max_tokens: 4096,
                    headers: null,
                },
            ],
        };
        let ext = ProviderExtension {
            name: null,
            base_url: "https://custom.example.com",
            api: null,
            headers: null,
            model_overrides: null,
            models: null,
        };
        let out = compose_provider("anthropic", base, ext);
        assert.equal(out.base_url, "https://custom.example.com");
        assert.equal(out.models[0].base_url, "https://custom.example.com");
    }

    test "extension models replace base" {
        let base = ComposedProvider {
            id: "test",
            name: "Base",
            base_url: "https://a.com",
            api: "anthropic",
            headers: null,
            models: [
                ComposedModel {
                    id: "old",
                    name: "Old",
                    api: "anthropic",
                    provider: "test",
                    base_url: "https://a.com",
                    reasoning: false,
                    context_window: 1000,
                    max_tokens: 100,
                    headers: null,
                },
            ],
        };
        let ext = ProviderExtension {
            name: "New",
            base_url: null,
            api: null,
            headers: null,
            model_overrides: null,
            models: [
                ComposedModel {
                    id: "new-model",
                    name: "New",
                    api: "anthropic",
                    provider: "test",
                    base_url: "https://a.com",
                    reasoning: true,
                    context_window: 2000,
                    max_tokens: 200,
                    headers: null,
                },
            ],
        };
        let out = compose_provider("test", base, ext);
        assert.equal(out.name, "New");
        assert.equal(out.models.length(), 1);
        assert.equal(out.models[0].id, "new-model");
    }

    test "modelOverrides applied topmost" {
        let base = ComposedProvider {
            id: "anthropic",
            name: "Anthropic",
            base_url: "https://api.anthropic.com",
            api: "anthropic",
            headers: null,
            models: [
                ComposedModel {
                    id: "haiku",
                    name: "Haiku",
                    api: "anthropic",
                    provider: "anthropic",
                    base_url: "https://api.anthropic.com",
                    reasoning: false,
                    context_window: 100000,
                    max_tokens: 4096,
                    headers: null,
                },
            ],
        };
        let ov = ModelOverride {
            id: "haiku",
            name: "Haiku Ov",
            reasoning: true,
            context_window: 200000,
            max_tokens: null,
        };
        let m: map<string, ModelOverride> = { "haiku": ov };
        let ext = ProviderExtension {
            name: null,
            base_url: null,
            api: null,
            headers: null,
            model_overrides: m,
            models: null,
        };
        let out = compose_provider("anthropic", base, ext);
        assert.equal(out.models[0].name, "Haiku Ov");
        assert.is_true(out.models[0].reasoning);
        assert.equal(out.models[0].context_window, 200000);
    }

    test "compose without base or extension throws" {
        let threw = false;
        let _ = compose_provider("ghost", null, null) catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
                ComposedProvider {
                    id: "",
                    name: "",
                    base_url: null,
                    api: null,
                    headers: null,
                    models: [],
                }
            }
        };
        assert.is_true(threw);
    }

    test "resolve_thinking_level off when not reasoning" {
        assert.is_true(resolve_thinking_level(ThinkingLevel.High, false) == null);
        assert.equal(resolve_thinking_level(ThinkingLevel.High, true), "high");
        assert.equal(resolve_thinking_level(ThinkingLevel.Off, false), "off");
        assert.is_true(resolve_thinking_level(null, true) == null);
        assert.equal(resolve_thinking_level(ThinkingLevel.Max, true), "max");
    }
}
