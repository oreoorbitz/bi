testset "tools registry" {
    test "ListTools returns 15 (7 pi + 6 bais + 2 report)" {
        assert.equal(ListTools().length(), 15)
    }

    test "read/bash/ls/grep/find are listed now that executors landed (bi#150/151)" {
        for (let name in ["read", "bash", "ls", "grep", "find"]) {
            let t = GetTool(name);
            assert.not_null(t);
            match (t) {
                let tool: ToolSpec => assert.equal(tool.name, name),
                _ => assert.is_true(false),
            }
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

testset "bash/read refusal policy (bi#150/151)" {
    test "bash refusals name the policy and the fix" {
        assert.contains(
            refuse_bash_blocked("curl https://x", "git, rg"),
            "not on the bash allowlist",
        );
        assert.contains(refuse_bash_blocked("curl https://x", "git, rg"), "curl https://x");
        assert.contains(refuse_bash_timeout("sleep 60", 5), "timed out and was killed after 5s");
        assert.contains(refuse_bash_timeout("sleep 60", 5), "larger timeout")
    }

    test "read refusals name the tool, the path, and the fix" {
        assert.contains(refuse_read_outside_root("read", "../x"), "outside the project root");
        assert.contains(refuse_read_outside_root("read", "../x"), "symlink escapes included");
        assert.contains(refuse_read_too_large("read", "big.log", 10), "10 byte tool cap");
        assert.contains(refuse_read_binary("grep", "a.png"), "text only")
    }
}

testset "bais_list rows-by-default contract (bi#212)" {
    test "bais_list advertises include_bodies and rows in its description" {
        let t = GetTool("bais_list");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "ROWS");
                assert.contains(tool.description, "include_bodies");
                assert.contains(tool.description, "unparseable");
                assert.contains(tool.description, "60k")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_check advertises compact + capped results" {
        let t = GetTool("bais_check");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "compact");
                assert.contains(tool.description, "60k")
            },
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
