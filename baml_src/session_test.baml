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
                    label: null,
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
                    label: null,
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
            ResumeEntry { id: "aaa", timestamp: "t1", cwd: "/x", turns: 1, label: "First" },
            ResumeEntry { id: "bbb", timestamp: "t2", cwd: "/y", turns: 3, label: null },
        ];
        let out = format_resume_list(sessions, "bbb");
        assert.contains(out, "* 2 bbb — 3 turns");
        assert.contains(out, "1 aaa — \"First\" — 1 turn")
    }

    test "labels validate and shape the export" {
        assert.equal(validate_session_label("work").length(), 0);
        assert.equal(validate_session_label("").length(), 1);
        assert.equal(validate_session_label("012345678901234567890123456789012345678901234567890123456789012345678901234567890").length(), 1);
        let h = create_session_header("abc123ef", "/w", "2026-08-30T12:00:00Z", label = "Work");
        assert.equal(h.label, "Work");
        let entries = [
            HistoryEntry { type: "history", role: "user", text: "hi", provider: null, model: null, thinking: null },
            HistoryEntry { type: "history", role: "assistant", text: "hello", provider: null, model: null, thinking: null },
        ];
        let md = format_session_markdown("abc123ef", "Work", "2026-08-30T12:00:00Z", "/w", entries);
        assert.contains(md, "# Work (abc123ef)");
        assert.contains(md, "## user");
        assert.contains(md, "## assistant");
        assert.contains(md, "hello");
        let plain = format_session_markdown("abc123ef", null, "2026-08-30T12:00:00Z", "/w", entries);
        assert.contains(plain, "# Session abc123ef")
    }

    test "gist name and description derive from the session" {
        assert.equal(gist_filename("abc123ef"), "bi-session-abc123ef.md");
        assert.equal(gist_description("abc123ef", null), "bi session abc123ef");
        assert.equal(gist_description("abc123ef", "Work"), "bi session abc123ef — Work")
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

    test "trust answers parse to decisions" {
        assert.equal(parse_trust_answer("y"), "allow");
        assert.equal(parse_trust_answer("YES"), "allow");
        assert.equal(parse_trust_answer("n"), "deny");
        assert.equal(parse_trust_answer("deny"), "deny");
        assert.equal(parse_trust_answer("s"), "session");
        assert.is_true(parse_trust_answer("maybe") is null);
        assert.is_true(parse_trust_answer("") is null)
    }

    test "trust status names cwd and decision" {
        assert.contains(format_trust_status("/work", null), "undecided");
        assert.contains(format_trust_status("/work", null), "/trust allow|deny|session");
        assert.equal(format_trust_status("/work", "allow"), "trust /work: allow");
        assert.equal(format_trust_status("/work", "session"), "trust /work: session")
    }
}
