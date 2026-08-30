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

    test "google invoke_stream reaches the wire and classifies transport failure" {
        let result = StreamTurn("google", "gemini-2.0-flash", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
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
