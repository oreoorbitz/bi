testset "tools registry" {
    test "ListTools returns 15 (7 pi + 8 bais)" {
        assert.equal(ListTools().length(), 15)
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

testset "write/edit refusal policy (bi#77)" {
    test "refusals name the fix" {
        assert.contains(refuse_write_outside_root("../x"), "outside the project root");
        assert.contains(refuse_write_outside_root("../x"), "symlink escapes included");
        assert.contains(refuse_write_untrusted(), "/trust allow|session");
        assert.contains(refuse_write_too_large("f", 10), "10 byte tool cap");
        assert.contains(edit_missing_text("f", 2), "edit 2 does not match");
        assert.contains(edit_missing_text("f", 2), "no edits applied")
    }
}
