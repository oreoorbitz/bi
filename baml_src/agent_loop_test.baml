testset "agent_loop" {
    test "loop_context_new idle" {
        let c = loop_context_new(5, "loop1");
        assert.equal(c.state, LoopState.Idle);
        assert.equal(c.max_turns, 5);
        assert.equal(c.loop_id, "loop1");
    }

    test "can_continue false when empty" {
        let c = loop_context_new(5, "a");
        assert.is_true(!can_continue(c));
    }

    test "can_continue true when has messages" {
        let c = loop_context_new(5, "a");
        c.messages.push("user: hi");
        assert.is_true(can_continue(c));
    }

    test "validate_continue throws on empty" {
        let c = loop_context_new(5, "a");
        let threw = false;
        validate_continue(c) catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
            }
        };
        assert.is_true(threw);
    }

    test "validate_continue throws on assistant" {
        let c = loop_context_new(5, "a");
        c.messages.push("user: hi");
        c.messages.push("assistant: hello");
        let threw = false;
        validate_continue(c) catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
            }
        };
        assert.is_true(threw);
    }

    test "validate_continue passes on user" {
        let c = loop_context_new(5, "a");
        c.messages.push("user: hi");
        let threw = false;
        validate_continue(c) catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
            }
        };
        assert.is_true(!threw);
    }

    test "next_loop_state" {
        assert.equal(next_loop_state(LoopState.Idle, false, false), LoopState.Thinking);
        assert.equal(next_loop_state(LoopState.Thinking, true, false), LoopState.ToolUse);
        assert.equal(next_loop_state(LoopState.ToolUse, false, true), LoopState.Done);
        assert.equal(next_loop_state(LoopState.Waiting, false, false), LoopState.Waiting);
    }

    test "agent_event_new" {
        let e = agent_event_new(AgentEventKind.TurnStart, 0, "start");
        assert.equal(e.kind, AgentEventKind.TurnStart);
        assert.equal(e.turn, 0);
    }
}
