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
        let result = SendTurn("xai", "grok-4", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.equal(turn_result_label(result), "failure:network:retry_safe=true")
    }

    test "xai invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("xai", "grok-4", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
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
}
