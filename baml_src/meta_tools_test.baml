// bi/baml_src/meta_tools_test.baml — hub#207 fixtures for meta_tools.baml.
// All literal data, no LLM. Red-check record lives in meta_tools.baml's
// header (the materialization gate's null-evidence arm).

testset "meta-tools mining + gate (hub#207)" {
    test "recurring sequence is detected once, not per occurrence" {
        // [read, grep, edit] recurs in two sessions — twice in the first.
        let sessions = [
            SessionTrace {
                session_id: "s1",
                parent_session: null,
                tool_calls: ["read", "grep", "edit", "bash", "read", "grep", "edit"],
            },
            SessionTrace {
                session_id: "s2",
                parent_session: "s1",
                tool_calls: ["ls", "read", "grep", "edit", "write"],
            },
        ];
        let proposals = mine_meta_tools(sessions);
        assert.equal(proposals.length(), 1);
        let p = proposals.at(0);
        assert.is_true(p != null);
        if let prop: MetaToolProposal = p {
            assert.equal(prop.name, "meta_read_grep_edit");
            assert.equal(prop.sequence.join(","), "read,grep,edit");
            assert.equal(prop.support, 2);
            assert.equal(prop.session_ids.join(","), "s1,s2");
            assert.is_true(prop.evidence == null);
            assert.is_true(prop.trigger.includes("read -> grep -> edit"));
        }
    }

    test "no recurrence yields no proposals" {
        let sessions = [
            SessionTrace { session_id: "a1", parent_session: null, tool_calls: ["read", "write"] },
            SessionTrace { session_id: "a2", parent_session: null, tool_calls: ["ls", "bash"] },
        ];
        assert.equal(mine_meta_tools(sessions).length(), 0);
    }

    test "only maximal patterns are proposed" {
        // [read, grep, edit] recurs as a whole; [read, grep] / [grep, edit]
        // must fold into it, not propose separately.
        let sessions = [
            SessionTrace {
                session_id: "b1",
                parent_session: null,
                tool_calls: ["read", "grep", "edit"],
            },
            SessionTrace {
                session_id: "b2",
                parent_session: null,
                tool_calls: ["read", "grep", "edit"],
            },
        ];
        let proposals = mine_meta_tools(sessions);
        assert.equal(proposals.length(), 1);
        let p = proposals.at(0);
        if let prop: MetaToolProposal = p {
            assert.equal(prop.sequence.join(","), "read,grep,edit");
        } else {
            assert.is_true(false);
        }
    }

    test "two independent recurrences yield two proposals" {
        let sessions = [
            SessionTrace {
                session_id: "c1",
                parent_session: null,
                tool_calls: ["read", "write", "ls", "bash"],
            },
            SessionTrace {
                session_id: "c2",
                parent_session: null,
                tool_calls: ["read", "write", "ls", "bash"],
            },
        ];
        let proposals = mine_meta_tools(sessions);
        // [read, write] and [ls, bash] recur; the full 4-gram also recurs
        // and folds both — one maximal proposal.
        assert.equal(proposals.length(), 1);
        let sessions2 = [
            SessionTrace {
                session_id: "d1",
                parent_session: null,
                tool_calls: ["read", "write", "grep"],
            },
            SessionTrace {
                session_id: "d2",
                parent_session: null,
                tool_calls: ["grep", "ls", "bash", "find"],
            },
            SessionTrace {
                session_id: "d3",
                parent_session: null,
                tool_calls: ["read", "write", "edit"],
            },
            SessionTrace {
                session_id: "d4",
                parent_session: null,
                tool_calls: ["ls", "bash", "edit"],
            },
        ];
        let props2 = mine_meta_tools(sessions2);
        // [read, write] in d1+d3, [ls, bash] in d2+d4 → two proposals.
        assert.equal(props2.length(), 2);
        let names = props2.map((p) -> {
            p.name
        });
        assert.is_true(names.includes("meta_read_write"));
        assert.is_true(names.includes("meta_ls_bash"));
    }

    test "min_support is honored" {
        let sessions = [
            SessionTrace { session_id: "e1", parent_session: null, tool_calls: ["read", "edit"] },
            SessionTrace { session_id: "e2", parent_session: null, tool_calls: ["read", "edit"] },
        ];
        assert.equal(mine_meta_tools(sessions, min_support = 3).length(), 0);
        assert.equal(mine_meta_tools(sessions, min_support = 2).length(), 1);
    }

    test "gate refuses a proposal without flip_gate evidence" {
        let proposals = mine_meta_tools(
            [
                SessionTrace {
                    session_id: "f1",
                    parent_session: null,
                    tool_calls: ["read", "grep", "edit"],
                },
                SessionTrace {
                    session_id: "f2",
                    parent_session: null,
                    tool_calls: ["read", "grep", "edit"],
                },
            ],
        );
        let p = proposals.at(0);
        if let prop: MetaToolProposal = p {
            match (gate_meta_tool_materialization(prop)) {
                let r: MaterializeRefuse => {
                    assert.is_true(r.reason.includes("no_flip_gate_evidence"))
                },
                _ => assert.is_true(false),
            }
        } else {
            assert.is_true(false);
        }
    }

    test "gate refuses Reject and NoOp evidence" {
        let base = MetaToolProposal {
            name: "meta_read_edit",
            sequence: ["read", "edit"],
            trigger: "t",
            support: 2,
            session_ids: ["g1", "g2"],
            evidence: null,
        };
        let rej = MetaToolProposal {
            name: base.name,
            sequence: base.sequence,
            trigger: base.trigger,
            support: base.support,
            session_ids: base.session_ids,
            evidence: FlipGateEvidence {
                verdict: "Reject",
                drill_arm_ids: ["arm-1"],
                flipped_green: [],
                gate_run_id: "drill 2026-09-08",
            },
        };
        match (gate_meta_tool_materialization(rej)) {
            let r: MaterializeRefuse => assert.is_true(r.reason.includes("flip_gate_not_accept")),
            _ => assert.is_true(false),
        }
        let noop = MetaToolProposal {
            name: base.name,
            sequence: base.sequence,
            trigger: base.trigger,
            support: base.support,
            session_ids: base.session_ids,
            evidence: FlipGateEvidence {
                verdict: "NoOp",
                drill_arm_ids: ["arm-1"],
                flipped_green: [],
                gate_run_id: "drill 2026-09-08",
            },
        };
        match (gate_meta_tool_materialization(noop)) {
            let r: MaterializeRefuse => assert.is_true(r.reason.includes("flip_gate_not_accept")),
            _ => assert.is_true(false),
        }
    }

    test "gate refuses Accept with empty flips or no drill arms" {
        let empty_flip = MetaToolProposal {
            name: "meta_read_edit",
            sequence: ["read", "edit"],
            trigger: "t",
            support: 2,
            session_ids: ["h1", "h2"],
            evidence: FlipGateEvidence {
                verdict: "Accept",
                drill_arm_ids: ["arm-1"],
                flipped_green: [],
                gate_run_id: "drill 2026-09-08",
            },
        };
        match (gate_meta_tool_materialization(empty_flip)) {
            let r: MaterializeRefuse => assert.is_true(r.reason.includes("flip_gate_empty_flip")),
            _ => assert.is_true(false),
        }
        let no_arms = MetaToolProposal {
            name: "meta_read_edit",
            sequence: ["read", "edit"],
            trigger: "t",
            support: 2,
            session_ids: ["h1", "h2"],
            evidence: FlipGateEvidence {
                verdict: "Accept",
                drill_arm_ids: [],
                flipped_green: ["arm-1"],
                gate_run_id: "drill 2026-09-08",
            },
        };
        match (gate_meta_tool_materialization(no_arms)) {
            let r: MaterializeRefuse => assert.is_true(r.reason.includes("no_drill_arms")),
            _ => assert.is_true(false),
        }
    }

    test "gate materializes on a real flip-gate Accept" {
        let p = MetaToolProposal {
            name: "meta_read_grep_edit",
            sequence: ["read", "grep", "edit"],
            trigger: "t",
            support: 2,
            session_ids: ["i1", "i2"],
            evidence: FlipGateEvidence {
                verdict: "Accept",
                drill_arm_ids: ["arm-1", "arm-2"],
                flipped_green: ["arm-1"],
                gate_run_id: "node bits/scripts/flip-gate.mjs prop#02 2026-09-08",
            },
        };
        match (gate_meta_tool_materialization(p)) {
            let spec: MetaToolSpec => {
                assert.equal(spec.name, "meta_read_grep_edit");
                assert.equal(spec.sequence.join(","), "read,grep,edit");
                assert.is_true(spec.description.includes("flip-gate"));
            },
            _ => assert.is_true(false),
        }
    }
}
