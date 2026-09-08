// hub#203 tests — all offline: literal digests, literal model output,
// ReviewTurn$parse / ReviewTurn@spec only. No test makes an LLM call.
//
// bi#57 red-check record for the BAML half (host staging-gate red-check
// lives in bi/scripts/review-staging.mjs):
//   hunk: review_prompt_for's `let other` throw arm
//   expected reason: a bogus mode must be a clean InvalidArgument naming
//     the value, never a silent fall-through to combined
//   observed: with the arm replaced by `_ => combined_review_prompt()`,
//     test "unknown review mode fails fast naming it" FAILS (no throw,
//     threw == false); restored, suite green.

testset "review digest + prompts (hub#203)" {
    test "render_digest shapes roles, tools, earlier summary, skills" {
        let d = TranscriptDigest {
            session_id: "abc123ef",
            earlier_summary: "We set up the project skeleton.",
            recent: [
                DigestEntry { role: "user", text: "add a retry loop", tools: [] },
                DigestEntry {
                    role: "assistant",
                    text: "done, with backoff",
                    tools: ["edit", "bash"],
                },
            ],
            skills_loaded: ["baml-core"],
        };
        let out = render_digest(d);
        assert.contains(out, "Earlier conversation digest");
        assert.contains(out, "We set up the project skeleton.");
        assert.contains(out, "USER: add a retry loop");
        assert.contains(out, "ASSISTANT[tools: edit, bash]");
        assert.contains(out, "ASSISTANT: done, with backoff");
        assert.contains(out, "Skills loaded this session: baml-core")
    }

    test "render_digest omits empty sections" {
        let d = TranscriptDigest {
            session_id: "abc123ef",
            earlier_summary: null,
            recent: [DigestEntry { role: "user", text: "hi", tools: [] }],
            skills_loaded: [],
        };
        let out = render_digest(d);
        assert.is_true(!out.includes("Earlier conversation digest"));
        assert.is_true(!out.includes("Skills loaded"));
        assert.is_true(!out.includes("[tools:"));
        assert.contains(out, "USER: hi")
    }

    test "staging preamble frames proposals-not-writes" {
        let p = staging_preamble();
        assert.contains(p, "CANNOT write to any store");
        assert.contains(p, "approves or rejects");
        assert.contains(p, "you proposed it, that is all")
    }

    test "NothingToSave is a real outcome in all three prompts" {
        // hub#203 acceptance: not biased away. Memory and combined offer it
        // plainly; skill keeps hermes' 'real option but not the default'.
        assert.contains(memory_review_prompt(), "return NothingToSave and stop");
        assert.contains(skill_review_prompt(), "NothingToSave is a real option");
        assert.contains(combined_review_prompt(), "return NothingToSave and stop");
        assert.contains(combined_review_prompt(), "do not reach for that conclusion as a default")
    }

    test "do-not-capture rules ride the skill and combined prompts only" {
        assert.contains(skill_review_prompt(), "harden into refusals");
        assert.contains(combined_review_prompt(), "harden into refusals");
        assert.contains(skill_review_prompt(), "sequence of failures as validated guidance");
        assert.is_true(!memory_review_prompt().includes("harden into refusals"))
    }

    test "combined prompt carries the BAIS issue arm" {
        let p = combined_review_prompt();
        assert.contains(p, "IssueProposal");
        assert.contains(p, "One-off task narratives are NOT issues")
    }

    test "unknown review mode fails fast naming it" {
        let threw = false;
        let _ = review_prompt_for("evrything") catch (e) {
            baml.errors.InvalidArgument => {
                threw = true;
                "caught"
            }
        };
        assert.is_true(threw)
    }

    test "ReviewTurn spec embeds the digest and offers NothingToSave" {
        let d = TranscriptDigest {
            session_id: "abc123ef",
            earlier_summary: null,
            recent: [DigestEntry { role: "user", text: "prefer terse answers", tools: [] }],
            skills_loaded: [],
        };
        let spec = ReviewTurn@spec(d);
        let prompt = spec.prompt_template("OUTPUT_FORMAT_HERE").text();
        assert.contains(prompt, "prefer terse answers");
        assert.contains(prompt, "abc123ef");
        assert.contains(prompt, "NothingToSave");
        assert.contains(prompt, "OUTPUT_FORMAT_HERE");
        assert.is_true(spec.tools().is_empty())
    }

    test "model output parses into the union — MemoryAdd" {
        let a = ReviewTurn$parse(
            `{"op": "add", "content": "User prefers terse answers with no preamble.", "old_text": null, "rationale": "explicit correction this session"}`,
        );
        assert.is_type<MemoryAdd>(a);
        if let m: MemoryAdd = a {
            assert.equal(m.op, "add");
            assert.equal(m.content, "User prefers terse answers with no preamble.")
        }
    }

    test "model output parses into the union — SkillPatch" {
        let a = ReviewTurn$parse(
            `{"skill": "baml-core", "action": "add_reference", "target_file": "references/toolchain-pins.md", "content": "# Pins\nMatch sdk and bridge versions.", "rationale": "pin mismatch cost a session"}`,
        );
        assert.is_type<SkillPatch>(a);
        if let s: SkillPatch = a {
            assert.equal(s.action, "add_reference");
            assert.equal(s.target_file, "references/toolchain-pins.md")
        }
    }

    test "model output parses into the union — IssueProposal" {
        let a = ReviewTurn$parse(
            `{"title": "review fork double-stages on retry", "kind": "Bug", "area": "bi/review", "body": "Repro: ... Acceptance: ...", "rationale": "outlives this session"}`,
        );
        assert.is_type<IssueProposal>(a);
        if let i: IssueProposal = a {
            assert.equal(i.kind, "Bug");
            assert.equal(i.area, "bi/review")
        }
    }

    test "model output parses into the union — NothingToSave is a real parse" {
        let a = ReviewTurn$parse(`{"reason": "smooth session, no corrections, no new technique"}`);
        assert.is_type<NothingToSave>(a);
        if let n: NothingToSave = a {
            assert.contains(n.reason, "no corrections")
        }
    }
}
