testset "session header + trust (bi namespace)" {
    test "valid ids pass" {
        assert.is_true(is_valid_session_id("a"));
        assert.is_true(is_valid_session_id("a1"));
        assert.is_true(is_valid_session_id("a-b_c.d"));
        assert.is_true(is_valid_session_id("Ab1-_.2"));
        // 8 hex chars like pi's generateId
        assert.is_true(is_valid_session_id("abc123ef"));
    }

    test "invalid ids fail" {
        assert.is_true(!is_valid_session_id(""));
        assert.is_true(!is_valid_session_id("-ab"));
        assert.is_true(!is_valid_session_id("ab-"));
        assert.is_true(!is_valid_session_id(".ab"));
        assert.is_true(!is_valid_session_id("ab."));
        assert.is_true(!is_valid_session_id("a/b"));
        assert.is_true(!is_valid_session_id("a b"));
    }

    test "is_valid_session_id_char" {
        assert.is_true(is_valid_session_id_char("a"));
        assert.is_true(is_valid_session_id_char("Z"));
        assert.is_true(is_valid_session_id_char("0"));
        assert.is_true(is_valid_session_id_char("-"));
        assert.is_true(is_valid_session_id_char("_"));
        assert.is_true(is_valid_session_id_char("."));
        assert.is_true(!is_valid_session_id_char("/"));
        assert.is_true(!is_valid_session_id_char(" "));
    }

    test "validate_session_id throws on bad" {
        let threw = false;
        let _ = validate_session_id("-bad") catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
            }
        };
        assert.is_true(threw);
        let threw2 = false;
        validate_session_id("good-id_1.2") catch (e) {
            baml.errors.InvalidArgument => {
                threw2 = true;
            }
        };
        assert.is_true(!threw2);
    }

    test "create_session_header success" {
        let h = create_session_header("abc123ef", "/Users/adrian", "2026-08-30T12:00:00Z");
        assert.equal(h.type, "session");
        assert.equal(h.version, 3);
        assert.equal(h.id, "abc123ef");
        assert.equal(h.cwd, "/Users/adrian");
        assert.is_true(h.parent_session == null);
    }

    test "create_session_header with parent" {
        let h = create_session_header("new12345", "/tmp", "2026-08-30T12:00:00Z", parent_session = "parent99");
        assert.equal(h.parent_session, "parent99");
        assert.equal(h.id, "new12345");
    }

    test "create_session_header rejects bad id" {
        let threw = false;
        let _ = create_session_header("-bad", "/tmp", "2026-08-30T12:00:00Z") catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
                SessionHeader {
                    type: "session",
                    version: 3,
                    id: "",
                    timestamp: "",
                    cwd: "",
                    parent_session: null,
                }
            }
        };
        assert.is_true(threw);
    }

    test "create_session_header rejects empty cwd" {
        let threw = false;
        let _ = create_session_header("goodId1", "", "2026-08-30T12:00:00Z") catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
                SessionHeader {
                    type: "session",
                    version: 3,
                    id: "",
                    timestamp: "",
                    cwd: "",
                    parent_session: null,
                }
            }
        };
        assert.is_true(threw);
    }

    test "current_session_version is 3" {
        assert.equal(current_session_version(), 3);
    }

    test "format_project_trust_prompt uses bi" {
        let p = format_project_trust_prompt("/Users/adrian/code/orion/orion-learn-baml");
        assert.contains(p, "bi");
        assert.contains(p, ".bi");
        assert.is_true(trust_prompt_contains_bi(p));
        assert.is_true(!p.includes(".pi"));
    }

    test "app_name is bi in session context" {
        assert.equal(app_name(), "bi");
        assert.equal(config_dir_name(), ".bi");
    }

    test "history entry validation accepts user/assistant, rejects junk" {
        assert.equal(validate_history_entry("user", "hi").length(), 0);
        assert.equal(validate_history_entry("assistant", "hello").length(), 0);
        assert.equal(validate_history_entry("system", "hi").length(), 1);
        assert.equal(validate_history_entry("user", "").length(), 1);
        assert.equal(validate_history_entry("", "").length(), 2)
    }

    test "select_valid_history keeps good lines, drops the rest" {
        let entries = [
            HistoryEntry { type: "history", role: "user", text: "hi", provider: null, model: null, thinking: null },
            HistoryEntry { type: "session", role: "user", text: "hi", provider: null, model: null, thinking: null },
            HistoryEntry { type: "history", role: "tool", text: "x", provider: null, model: null, thinking: null },
            HistoryEntry { type: "history", role: "assistant", text: "", provider: null, model: null, thinking: null },
            HistoryEntry { type: "history", role: "assistant", text: "ok", provider: "xai", model: "grok-4.6", thinking: "high" },
        ];
        let kept = select_valid_history(entries);
        assert.equal(kept.length(), 2);
        assert.equal(kept[0].text, "hi");
        assert.equal(kept[1].model, "grok-4.6")
    }

    test "resume list marks current and counts turns" {
        assert.equal(format_resume_list([], null), "no saved sessions");
        let sessions = [
            ResumeEntry { id: "aaa", timestamp: "t1", cwd: "/x", turns: 1 },
            ResumeEntry { id: "bbb", timestamp: "t2", cwd: "/y", turns: 3 },
        ];
        let out = format_resume_list(sessions, "bbb");
        assert.contains(out, "* bbb — 3 turns");
        assert.contains(out, "  aaa — 1 turn")
    }

    test "session info names backend and lineage" {
        let info = format_session_info("abc123ef", "/s/abc123ef.jsonl", "/work", null, "meta", "muse-spark-1.3", "high", 2, 5);
        assert.contains(info, "session abc123ef");
        assert.contains(info, "meta/muse-spark-1.3 · thinking high");
        assert.contains(info, "forked from: none");
        assert.contains(info, "turns: 2 · messages: 5");
        let forked = format_session_info("def456ab", "/s/def456ab.jsonl", "/work", "abc123ef", "meta", "muse-spark-1.3", null, 0, 0);
        assert.contains(forked, "forked from: abc123ef");
        assert.contains(forked, "thinking default")
    }
}
