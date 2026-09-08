// hub#208 rail 1 tests — literal data, no LLM. The host drills the live
// tool layer separately (bi/scripts/hub208-write-guard.mjs); these pin the
// POLICY the host consults.
//
// Acceptance coverage:
//   - write-without-read refused with a named reason: "overwrite without a
//     read refuses with the named reason", "edit without a read refuses"
//   - read-then-write succeeds: "read-then-write is allowed"
//   - new-file creation unfenced: "creating a new file needs no read"
//
// Red-check record (bi#57): the live refusal net is host-side; the drill
// (hub208-write-guard.mjs) carries the revert-guard-hunk record. BAML-side
// net: hunk — in write_guard.baml write_guard_check, change the condition to
// `if (false && ...)`. Expected reason: the refusal tests see WriteGuardAllow.
// Observed: FAIL write guard (hub#208)::overwrite without a read refuses with
// the named reason — `assert.is_type<WriteGuardRefuse>(v)` failed (verdict
// was WriteGuardAllow, overwrite of unread content permitted — exactly the
// silent rewrite the rail exists to prevent). Restored, suite green.

testset "write guard (hub#208)" {
    test "overwrite without a read refuses with the named reason" {
        let v = write_guard_check(
            WriteGuardQuery {
                tool: "write",
                path: "src/app.ts",
                target_exists: true,
                read_this_session: false,
            },
        );
        assert.is_type<WriteGuardRefuse>(v);
        if let r: WriteGuardRefuse = v {
            assert.contains(r.reason, "read-before-write");
            assert.contains(r.reason, "src/app.ts");
            // the fix is named: read the target, then retry
            assert.contains(r.reason, "Call read");
            assert.contains(r.reason, "then retry");
        }
    }

    test "edit without a read refuses" {
        let v = write_guard_check(
            WriteGuardQuery {
                tool: "edit",
                path: "README.md",
                target_exists: true,
                read_this_session: false,
            },
        );
        assert.is_type<WriteGuardRefuse>(v);
        if let r: WriteGuardRefuse = v {
            assert.contains(r.reason, "read-before-write");
            assert.contains(r.reason, "edit");
        }
    }

    test "read-then-write is allowed" {
        let v = write_guard_check(
            WriteGuardQuery {
                tool: "write",
                path: "src/app.ts",
                target_exists: true,
                read_this_session: true,
            },
        );
        assert.is_type<WriteGuardAllow>(v);
    }

    test "read-then-edit is allowed" {
        let v = write_guard_check(
            WriteGuardQuery {
                tool: "edit",
                path: "src/app.ts",
                target_exists: true,
                read_this_session: true,
            },
        );
        assert.is_type<WriteGuardAllow>(v);
    }

    test "creating a new file needs no read" {
        let v = write_guard_check(
            WriteGuardQuery {
                tool: "write",
                path: "src/new-file.ts",
                target_exists: false,
                read_this_session: false,
            },
        );
        assert.is_type<WriteGuardAllow>(v);
    }

    test "unrelated tools are not gated" {
        let v = write_guard_check(WriteGuardQuery { tool: "bash", path: "", target_exists: false, read_this_session: false });
        assert.is_type<WriteGuardAllow>(v);
    }
}
