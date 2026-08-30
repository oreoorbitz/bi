testset "agent helpers" {
    test "CreateTextTurn yields Complete with text" {
        let turn = CreateTextTurn("hello");
        assert.equal(turn.stop_reason, ai.content.StopReason.Complete);
        assert.equal(turn.terminal_text(), "hello");
        assert.equal(turn.tool_uses().length(), 0)
    }

    test "CreateToolUseTurn yields ToolUse with correct name and args" {
        let turn = CreateToolUseTurn("get_weather", "call_1", { "city": "Paris" });
        assert.equal(turn.stop_reason, ai.content.StopReason.ToolUse);
        let uses = turn.tool_uses();
        assert.equal(uses.length(), 1);
        assert.equal(uses[0].name, "get_weather");
        assert.equal(uses[0].id, "call_1")
    }

    test "CreateMixedTurn yields both text and ToolUse" {
        let turn = CreateMixedTurn("thinking", "search", "call_2", { "q": "test" });
        assert.equal(turn.stop_reason, ai.content.StopReason.ToolUse);
        assert.equal(turn.terminal_text(), "thinking");
        assert.equal(turn.tool_uses().length(), 1);
        assert.equal(turn.tool_uses()[0].name, "search")
    }
}
