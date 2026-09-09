testset "tools registry" {
    test "ListTools returns 19 (7 pi + 10 bais + 2 report)" {
        assert.equal(ListTools().length(), 19)
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

testset "bais_list structured filters (bi#214)" {
    test "bais_list advertises the filter set and the loud-refuse + explicit-empty rules" {
        let t = GetTool("bais_list");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "title_regex");
                assert.contains(tool.description, "body_regex");
                assert.contains(tool.description, "id_min");
                assert.contains(tool.description, "query");
                assert.contains(tool.description, "refuse loud naming the pattern");
                assert.contains(tool.description, "explicit ({issues: []})")
            },
            _ => assert.is_true(false),
        }
    }
}

testset "bais_ready/check/graph row-mode contracts (bi#213)" {
    test "bais_ready advertises rows + include_bodies like bais_list" {
        let t = GetTool("bais_ready");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "ROWS");
                assert.contains(tool.description, "include_bodies");
                assert.contains(tool.description, "60k");
                assert.contains(tool.description, "bais show")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_ready names its new arg in the description (schema pinned host-side by the drill)" {
        let t = GetTool("bais_ready");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "include_bodies:true")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_check advertises verdict rows, never bodies, failures first" {
        let t = GetTool("bais_check");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "verdict rows");
                assert.contains(tool.description, "never bodies");
                assert.contains(tool.description, "complete by construction")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_graph advertises rows + depth cap + named refinement" {
        let t = GetTool("bais_graph");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "ROWS");
                assert.contains(tool.description, "include_bodies");
                assert.contains(tool.description, "depth");
                assert.contains(tool.description, "narrower --from, shallower depth");
                assert.contains(tool.description, "pass depth for shallower/deeper");
                assert.contains(tool.description, "include_bodies:true")
            },
            _ => assert.is_true(false),
        }
    }
}

testset "bais CRUD tools (bi#215)" {
    test "show/link/renew/reap are listed with GetTool" {
        for (let name in ["bais_show", "bais_link", "bais_renew", "bais_reap"]) {
            let t = GetTool(name);
            assert.not_null(t);
            match (t) {
                let tool: ToolSpec => assert.equal(tool.name, name),
                _ => assert.is_true(false),
            }
        }
    }

    test "bais_show advertises the full record + fail-closed unknown" {
        let t = GetTool("bais_show");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "full record");
                assert.contains(tool.description, "holder/lease");
                assert.contains(tool.description, "fail closed naming themselves");
                assert.contains(tool.description, "compact JSON")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_new advertises edges at birth" {
        let t = GetTool("bais_new");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "edges");
                assert.contains(tool.description, "kind, to");
                assert.contains(tool.description, "existing ends")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_move advertises claim-capable as/for with the bare-move contract" {
        let t = GetTool("bais_move");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "`as`");
                assert.contains(tool.description, "`for`");
                assert.contains(tool.description, "anonymous-but-instantly-stale")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_link advertises validated edges over linkBaisIssues" {
        let t = GetTool("bais_link");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "no self-links/dups/cycles");
                assert.contains(tool.description, "never half-writes")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_renew advertises the holder-only heartbeat" {
        let t = GetTool("bais_renew");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "recorded holder");
                assert.contains(tool.description, "heartbeat")
            },
            _ => assert.is_true(false),
        }
    }

    test "bais_reap advertises expired-only with live claims untouched" {
        let t = GetTool("bais_reap");
        assert.not_null(t);
        match (t) {
            let tool: ToolSpec => {
                assert.contains(tool.description, "expired-only");
                assert.contains(tool.description, "never touched")
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
