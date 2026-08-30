// Seam A — BAML-local incremental streaming tests (no host round-trip).
// Verifies the BamlStream-tagged Stream primitive that survives FFI, and the
// raw TurnStream in-VM behavior. Offline, no API key, no network.

testset "stream incremental" {
    test "CreateTypedStream yields accumulated partials then Done" {
        let s = CreateTypedStream(["hello ", "world", "!"]);
        assert.equal(s.next(), "hello ");
        assert.equal(s.next(), "hello world");
        assert.equal(s.next(), "hello world!");
        assert.is_true(s.next() is ai.stream.Done);
        assert.is_true(s.next() is ai.stream.Done)
    }

    test "CreateTypedStream final drains and equals last partial" {
        let s = CreateTypedStream(["a", "b", "c"]);
        assert.equal(s.final(), "abc")
    }

    test "CreateTypedStream next then final interleaving" {
        let s = CreateTypedStream(["x", "y", "z"]);
        assert.equal(s.next(), "x");
        assert.equal(s.final(), "xyz")
    }

    test "CreateTypedStream empty chunks yields Done immediately" {
        let s = CreateTypedStream([]);
        assert.is_true(s.next() is ai.stream.Done);
        assert.equal(s.final(), "")
    }

    test "CreateTypedStream single chunk" {
        let s = CreateTypedStream(["solo"]);
        assert.equal(s.next(), "solo");
        assert.is_true(s.next() is ai.stream.Done);
        assert.equal(s.final(), "solo")
    }

    test "CreateScriptedStream in-VM next advances (contrast with host handle gap)" {
        let s = CreateScriptedStream(["a", "b", "c"]);
        assert.equal(s.next(), "a");
        assert.equal(s.next(), "b");
        assert.equal(s.next(), "c");
        assert.is_true(s.next() is ai.stream.Done);
        assert.is_true(s.next() is ai.stream.Done)
    }

    test "CreateScriptedStream final_turn accumulates text" {
        let s = CreateScriptedStream(["a", "b", "c"]);
        let turn = s.final_turn();
        assert.equal(turn.content.length(), 1);
        let text = match (turn.content[0]) {
            let t: ai.content.Text => t.text,
            _ => "",
        };
        assert.equal(text, "abc")
    }

    test "CreateScriptedStream final_turn after partial next still accumulates all" {
        let s = CreateScriptedStream(["x", "y", "z"]);
        assert.equal(s.next(), "x");
        let turn = s.final_turn();
        let text = match (turn.content[0]) {
            let t: ai.content.Text => t.text,
            _ => "",
        };
        assert.equal(text, "xyz")
    }

    test "StartTurnStream closed-port still classifies as TurnFailure in BAML" {
        let result = StartTurnStream("anthropic", "claude-haiku-4-5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => {
                assert.equal(f.kind, "network");
                assert.is_true(f.retry_safe)
            },
            _ => assert.is_true(false),
        }
    }

    test "StartIncrementalStream closed-port classifies as TurnFailure at create" {
        let result = StartIncrementalStream("anthropic", "claude-haiku-4-5", "test-key", "hi", [], [], base_url = "http://127.0.0.1:1");
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => {
                assert.equal(f.kind, "network");
                assert.is_true(f.retry_safe)
            },
            _ => assert.is_true(false),
        }
    }

    test "richer history with reasoning and ToolUse round-trips through invoke without panic" {
        let history: ai.events.Event[] = [
            ai.events.UserMessage { content: "hello" },
            ai.events.AssistantMessage {
                content: [
                    ai.content.Text { text: "thinking..." },
                    ai.content.Reasoning { summary: "let me think" },
                    ai.content.ToolUse {
                        id: "call_1",
                        name: "get_weather",
                        args: { "city": "Paris" },
                    },
                ],
                client_id: "anthropic/claude-haiku-4-5",
            },
            ai.events.ToolCompleted { id: "call_1", output: "sunny" },
            ai.events.ToolFailed { id: "call_2", message: "timeout" },
            ai.events.ToolRequested { id: "call_3", name: "search", args: { "q": "test" } },
        ];
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "follow-up",
            history,
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "richer history via StreamTurn also classifies transport failure" {
        let history: ai.events.Event[] = [
            ai.events.UserMessage { content: "hi" },
            ai.events.AssistantMessage {
                content: [ai.content.Reasoning { summary: "reason" }],
                client_id: "anthropic/claude-haiku-4-5",
            },
            ai.events.ToolCompleted { id: "call_1", output: "ok" },
        ];
        let result = StreamTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "next",
            history,
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.is_true(f.retry_safe),
            _ => assert.is_true(false),
        }
    }

    test "CreateMediaBlock yields Media with kind image in-VM" {
        let media = CreateMediaBlock("aGVsbG8=", "image/png");
        assert.equal(media.kind(), "image")
    }

    test "CreateMediaBlockFromUrl yields Media with kind image in-VM" {
        let media = CreateMediaBlockFromUrl("https://example.com/img.png", "image/png");
        assert.equal(media.kind(), "image")
    }

    test "SendTurnWithImage in-VM media history reaches wire and classifies transport failure" {
        let result = SendTurnWithImage(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            "aGVsbG8=",
            "image/png",
            client_id = "test-client",
            base_url = "http://127.0.0.1:1",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => {
                assert.equal(f.kind, "network");
                assert.is_true(f.retry_safe)
            },
            _ => assert.is_true(false),
        }
    }

    test "toolResult with image placeholder string reaches wire" {
        let history: ai.events.Event[] = [
            ai.events.AssistantMessage {
                content: [ai.content.ToolUse { id: "call_2", name: "screenshot", args: {} }],
                client_id: "test",
            },
            ai.events.ToolCompleted {
                id: "call_2",
                output: "see image\n[image:image/png aGVsbG8=...]",
            },
        ];
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "next",
            history,
            [],
            base_url = "http://127.0.0.1:1",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "temperature passthrough reaches wire without panic" {
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
            temperature = 0.7,
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "thinking enabled reaches wire without panic" {
        let thinking = anthropic.ThinkingConfig.enabled(1024);
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
            thinking = thinking,
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "thinking disabled reaches wire without panic" {
        let thinking = anthropic.ThinkingConfig.disabled();
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            [],
            [],
            base_url = "http://127.0.0.1:1",
            thinking = thinking,
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "ThinkingConfig helpers produce correct type field" {
        let enabled = anthropic.ThinkingConfig.enabled(2048);
        assert.equal(enabled.type, "enabled");
        assert.equal(enabled.budget_tokens, 2048);
        let disabled = anthropic.ThinkingConfig.disabled();
        assert.equal(disabled.type, "disabled");
        assert.is_true(disabled.budget_tokens is null)
    }
}
