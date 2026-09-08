// Offline plumbing tests for SendTurn/StreamTurn/ToolDef: no real network
// call, no API key needed — a closed local port exercises client
// construction, spec/tool derivation, Journal/Toolbox assembly, and
// invoke()/invoke_stream() dispatch, and confirms failures come back as a
// concrete, boundary-safe TurnFailure rather than an undecodable thrown
// interface value or a panic (see turn.baml's header, point 3).
//
// Real live-provider tests (needing ANTHROPIC_API_KEY / OPENAI_API_KEY) are
// a separate concern for a `live` test profile later — not added yet since
// no keys are available to verify against in this environment.

function turn_result_label(result: ai.ModelTurn | TurnFailure) -> string {
    match (result) {
        let f: TurnFailure => `failure:${f.kind}:retry_safe=${f.retry_safe}`,
        let t: ai.ModelTurn => `turn:blocks=${t.content.length()}`,
    }
}

testset "turn plumbing" {
    test "anthropic invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("anthropic", "claude-haiku-4-5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "openai responses invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "openai_responses",
            "gpt-4o-mini",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "anthropic invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("anthropic", "claude-haiku-4-5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "openai responses invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn(
            "openai_responses",
            "gpt-4o-mini",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "google invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("google", "gemini-2.0-flash", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "azure missing resource fails fast naming the opt and env" {
        SendTurn("azure-openai-responses", "gpt-4o", "test-key", "hi", [], []) catch (e) {
            baml.errors.InvalidArgument => {
                assert.is_true(e.message.includes("AZURE_OPENAI_RESOURCE"))
            },
        }
    }

    test "cloudflare missing account fails fast naming the env var" {
        SendTurn("cloudflare-workers-ai", "@cf/meta/llama-3.1-8b-instruct", "test-key", "hi", [], []) catch (e) {
            baml.errors.InvalidArgument => {
                assert.is_true(e.message.includes("CLOUDFLARE_ACCOUNT_ID"))
            },
        }
    }

    test "azure missing deployment fails fast naming the opt and env" {
        SendTurn(
            "azure-openai-responses",
            "gpt-4o",
            "test-key",
            "hi",
            [],
            [],
            azure_resource = "test-resource",
        ) catch (e) {
            baml.errors.InvalidArgument => {
                assert.is_true(e.message.includes("AZURE_OPENAI_DEPLOYMENT"))
            },
        }
    }

    // No closed-port wire test for azure: the client's endpoint derives
    // from the resource (a base_url override is rejected client-side), and
    // Azure's wildcard DNS answers any resource with HTTP 404 — verified
    // live as failure:invalid_request, which goes network-flaky offline.
    // Wire coverage lives in the CLI smoke (see bi#15).

    test "google invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("google", "gemini-2.0-flash", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "groq invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "groq",
            "llama-3.3-70b-versatile",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "groq invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn(
            "groq",
            "llama-3.3-70b-versatile",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "deepseek invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("deepseek", "deepseek-chat", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "deepseek invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("deepseek", "deepseek-chat", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "together invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "together",
            "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "together invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn(
            "together",
            "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "cerebras invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("cerebras", "llama-3.3-70b", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "cerebras invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("cerebras", "llama-3.3-70b", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "a null api_key resolves the catalog env ref without panicking" {
        // No key passed and DEEPSEEK_API_KEY unset: resolve_credential builds
        // baml.env.ref(DEEPSEEK_API_KEY), which resolves to null, and the
        // client refuses before the wire with a classified invalid_request
        // (missing credential), retry-safe. Proves the Ref path constructs
        // and dispatches instead of panicking.
        let result = SendTurn("deepseek", "deepseek-chat", null, "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:invalid_request:retry_safe=true")
    }

    test "a catalog provider with no base_url override uses the catalog url" {
        // No host override: build_client must fill the catalog base_url.
        // resolved_base_url is pure (no request), so this stays offline.
        let cl = build_client("groq", "llama-3.3-70b-versatile", "test-key", null);
        match (cl) {
            let c: openai.ChatClient => {
                assert.equal(c.resolved_base_url(), "https://api.groq.com/openai/v1")
            },
            _ => assert.is_true(false),
        }
    }

    test "moonshotai invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "moonshotai",
            "kimi-k2-0711-preview",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "nvidia invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "nvidia",
            "meta/llama-3.3-70b-instruct",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "zai invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("zai", "glm-4.5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "meta invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("meta", "muse-spark-1.3", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "huggingface invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "huggingface",
            "moonshotai/Kimi-K2-Instruct",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "baseten invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("baseten", "Qwen/Qwen3-32B", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "mistral invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "mistral",
            "mistral-small-latest",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "mistral invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn(
            "mistral",
            "mistral-small-latest",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    // Fireworks exercises the anthropic-messages compat arm (a different
    // constructor path than batch 1's ChatClient), so it gets both invoke
    // and invoke_stream coverage.
    test "fireworks invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "fireworks",
            "accounts/fireworks/models/llama-v3p3-70b-instruct",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "fireworks invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn(
            "fireworks",
            "accounts/fireworks/models/llama-v3p3-70b-instruct",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    // xAI exercises the openai-responses compat arm (third constructor
    // path), so it gets both invoke and invoke_stream coverage.
    test "xai invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("xai", "grok-4.6", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xai invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("xai", "grok-4.6", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "minimax invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("minimax", "MiniMax-M2", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "kimi-coding invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "kimi-coding",
            "kimi-k2-0711-preview",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "openrouter invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "openrouter",
            "anthropic/claude-sonnet-4-5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "qwen-token-plan invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("qwen-token-plan", "qwen-max", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "cloudflare-ai-gateway invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "cloudflare-ai-gateway",
            "openai/gpt-4o-mini",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "vercel-ai-gateway invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "vercel-ai-gateway",
            "anthropic/claude-opus-4.8",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "github-copilot invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("github-copilot", "gpt-6-astra", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "opencode invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "opencode",
            "nemotron-3-ultra-free",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "opencode-go invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("opencode-go", "qwen3.7-max", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xiaomi invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("xiaomi", "mimo-v2.5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xiaomi-token-plan-ams invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "xiaomi-token-plan-ams",
            "mimo-v2.5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xiaomi-token-plan-cn invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "xiaomi-token-plan-cn",
            "mimo-v2.5-pro",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xiaomi-token-plan-sgp invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "xiaomi-token-plan-sgp",
            "mimo-v2.5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "ant-ling invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("ant-ling", "Ling-2.6-flash", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "minimax-cn invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("minimax-cn", "MiniMax-M2.5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "moonshotai-cn invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("moonshotai-cn", "kimi-k2.5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "qwen-token-plan-cn invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "qwen-token-plan-cn",
            "qwen3.7-max",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "qwen-token-plan-individual invoke reaches the wire and classifies transport failure" {
        let result = SendTurn(
            "qwen-token-plan-individual",
            "deepseek-v4-pro-0813",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "zai-coding-cn invoke reaches the wire and classifies transport failure" {
        let result = SendTurn("zai-coding-cn", "glm-5.3", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "gateway missing gateway id fails fast naming the env var" {
        // Explicit base_url with the account filled isolates the gateway
        // check from ambient env (a bare catalog call hits the same arm
        // whenever both ids are unset).
        SendTurn(
            "cloudflare-ai-gateway",
            "openai/gpt-4o-mini",
            "test-key",
            "hi",
            [],
            [],
            base_url = "https://gateway.ai.cloudflare.com/v1/acct/{CLOUDFLARE_GATEWAY_ID}/openai",
        ) catch (e) {
            baml.errors.InvalidArgument => {
                assert.is_true(e.message.includes("CLOUDFLARE_GATEWAY_ID"))
            },
        }
    }

    test "an unknown provider tag is a clean InvalidArgument, not a panic" {
        let outcome = SendTurn("bogus", "some-model", "test-key", "hi", [], []) catch_all (e) {
            _ => e.to_string(),
        };
        assert.equal(outcome, "InvalidArgument { message: \"unknown provider: bogus\" }")
    }

    test "a tool spec round-trips through invoke without a panic" {
        let tool_spec = ToolSpec {
            name: "get_weather",
            description: "get the weather",
            input_schema: { "type": "object" },
        };
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            [],
            [tool_spec],
            base_url = "http://127.0.0.1:1",
        );
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "TurnPrompt spec derivation is tool-free and string-typed" {
        let spec = TurnPrompt@spec("hello");
        assert.is_true(spec.tools().is_empty());
        assert.equal(spec.output_type().to_string(), "string")
    }

    // bi#01: a concrete client IS usable as ai.Client inside one VM call —
    // only the host round-trip breaks it. Pins the in-VM side of the
    // build-and-consume-in-one-call workaround (turn.baml header, point 1).
    test "a built client dispatches through ai.Client in one call" {
        let cl: ai.Client = build_client("anthropic", "claude-haiku-4-5", "test-key", null);
        assert.equal(cl.id(), "anthropic/claude-haiku-4-5")
    }

    // bi#02: the string provider tag is validated at the boundary — an
    // unknown tag is a clean InvalidArgument naming the tag, which is the
    // typo-safety a real enum param would give (turn.baml header, point 2).
    test "build_client rejects an unknown provider tag with InvalidArgument" {
        build_client("bogus", "some-model", "test-key", null) catch (e) {
            baml.errors.InvalidArgument => {
                assert.equal(e.message, "unknown provider: bogus")
            },
        }
    }

    // bi#03: classify_failure narrows a caught Failure to a concrete kind +
    // retry flag, which is what makes the returned TurnFailure decodable
    // where the thrown interface value is not (turn.baml header, point 3).
    test "classify_failure maps a RateLimited to a retry-safe TurnFailure" {
        let f = classify_failure(ai.errors.RateLimited { provider: "anthropic", retry_after_ms: null, raw_body: null });
        assert.equal(f.kind, "rate_limited");
        assert.is_true(f.retry_safe)
    }
}
