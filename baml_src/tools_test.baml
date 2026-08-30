testset "tools registry" {
    test "ListTools returns 7" {
        assert.equal(ListTools().length(), 7)
    }

    test "GetTool read has required path" {
        let t = GetTool("read");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.equal(tool.name, "read");
                assert.is_true(tool.description.length() > 0)
            },
            _ => assert.is_true(false),
        }
    }

    test "GetTool unknown returns null" {
        assert.is_true(GetTool("bogus") is null)
    }

    test "all tools have name and description and input_schema" {
        for (let t in ListTools()) {
            assert.is_true(t.name.length() > 0);
            assert.is_true(t.description.length() > 0);
            assert.not_null(t.input_schema)
        }
    }

    test "tool specs round-trip through SendTurn without panic" {
        let tools = ListTools();
        let result = SendTurn(
            "anthropic",
            "claude-haiku-4-5",
            "test-key",
            "hi",
            [],
            tools,
            base_url = "http://127.0.0.1:1",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }
}
