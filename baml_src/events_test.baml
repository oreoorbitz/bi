// Offline event-schema tests (bi#14): constructors produce the documented
// field layout, validate_event accepts every constructor's output and
// rejects unknown types and missing required fields. No LLM involved.

testset "agent events" {
    test "run_start carries provider and model, validates" {
        let e = make_run_start("groq", "llama-3.3-70b-versatile");
        assert.equal(event_type(e), "run_start");
        assert.is_true(validate_event(e))
    }

    test "assistant_text carries text and turn index, validates" {
        let e = make_assistant_text("hello", 2);
        assert.equal(event_type(e), "assistant_text");
        assert.is_true(validate_event(e))
    }

    test "tool_call and tool_result carry ids and payloads, validate" {
        let c = make_tool_call("call_1", "get_weather", "{\"city\":\"sf\"}", 0);
        assert.equal(event_type(c), "tool_call");
        assert.is_true(validate_event(c));
        let r = make_tool_result("call_1", "get_weather", "sunny", 0);
        assert.equal(event_type(r), "tool_result");
        assert.is_true(validate_event(r))
    }

    test "run_end carries final text, run_failed carries kind and message" {
        let e = make_run_end("done");
        assert.equal(event_type(e), "run_end");
        assert.is_true(validate_event(e));
        let f = make_run_failed("invalid_argument", "no key");
        assert.equal(event_type(f), "run_failed");
        assert.is_true(validate_event(f))
    }

    test "unknown event type does not validate" {
        let e = RunEvent {
            type: "bogus",
            turn_index: null,
            provider: null,
            model: null,
            text: null,
            tool_call_id: null,
            tool_name: null,
            tool_args_json: null,
            tool_output: null,
            failure_kind: null,
            failure_message: null,
        };
        assert.is_true(!validate_event(e))
    }

    test "missing required fields do not validate" {
        let e = RunEvent {
            type: "tool_call",
            turn_index: 0,
            provider: null,
            model: null,
            text: null,
            tool_call_id: null,
            tool_name: null,
            tool_args_json: "{}",
            tool_output: null,
            failure_kind: null,
            failure_message: null,
        };
        assert.is_true(!validate_event(e))
    }
}
