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
}
