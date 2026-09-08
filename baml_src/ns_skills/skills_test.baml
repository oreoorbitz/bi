// ns_skills/skills_test — namespace core gates (hub#205): owner fence,
// applies_to filtering, prompt compilation on literal TurnContext fixtures.
//
// ── Red-check records (bi#57) ────────────────────────────────────────────
// Each gate below was reverted once, observed failing FOR THE RIGHT REASON,
// restored, and re-run green. See NOTES at /tmp/hub205-deliver/NOTES.md.
//
// RC-2 (test-rejection gate) — hunk: in ns_skills/skills.baml
//   compile_skills_prompt, drop the applies_to filter (`if (true)`).
//   Expected: "inactive skills never reach the compiled prompt" FAILS
//   because <skill> blocks for the inert stub leak into the prompt.
//   Observed: FAIL root.skills::inactive skills never reach the compiled
//   prompt (assertion failed: left = "<available_skills>...) AND FAIL
//   root.skills::plain coding questions do not apply and stay out of the
//   prompt — 456 passed / 2 failed. Restored, re-ran: 458/458 green.
//
// RC-3 (owner-fence gate) — hunk: in ns_skills/skills.baml
//   owner_fence_allows, make the body unconditionally `true`.
//   Expected: "owner fence refuses curator patches to user skills" FAILS
//   on the curator->user arm.
//   Observed: FAIL root.skills::owner fence refuses curator patches to user
//   skills + FAIL root.skills::owner is user — the fence protects this
//   skill + FAIL root.skills::fence composition — 455 passed / 3 failed,
//   each "assertion failed: expected true" on a !owner_fence_allows arm.
//   Restored, re-ran: 458/458 green.
// ─────────────────────────────────────────────────────────────────────────

// Minimal implementor for fence/prompt tests: applies_to is a field so one
// class plays both the active and the inert arm.
class StubSkill {
    owner: SkillOwner,
    applies: bool,
    body: string,
    implements Skill {
        function applies_to(self, ctx: TurnContext) -> bool {
            self.applies
        }
        function guidance(self) -> string {
            self.body
        }
    }
}

function fixture_ctx(text: string, session_start: bool) -> TurnContext {
    TurnContext {
        text: text,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        cwd: "/repo",
        session_start: session_start,
        staged_attachments: 0,
    }
}

test "owner fence refuses curator patches to user skills" {
    let curator_to_user = SkillPatch {
        skill_name: "ground-first",
        target_owner: "user",
        origin: "curator",
        diff_summary: "curator rewrites a user-owned rule",
    };
    assert.is_true(!owner_fence_allows(curator_to_user));
    let curator_to_curator = SkillPatch {
        skill_name: "some-curator-skill",
        target_owner: "curator",
        origin: "curator",
        diff_summary: "normal curator maintenance",
    };
    assert.is_true(owner_fence_allows(curator_to_curator));
    let user_to_user = SkillPatch {
        skill_name: "ground-first",
        target_owner: "user",
        origin: "user",
        diff_summary: "user edits their own skill",
    };
    assert.is_true(owner_fence_allows(user_to_user));
    let user_to_curator = SkillPatch {
        skill_name: "some-curator-skill",
        target_owner: "curator",
        origin: "user",
        diff_summary: "user is sovereign over curator skills too",
    };
    assert.is_true(owner_fence_allows(user_to_curator))
}

test "inactive skills never reach the compiled prompt" {
    let skills: Skill[] = [
        StubSkill { owner: "curator", applies: true, body: "ACTIVE BODY" },
        StubSkill { owner: "curator", applies: false, body: "INERT BODY" },
    ];
    let ctx = fixture_ctx("anything", false);
    let prompt = compile_skills_prompt(skills, ctx);
    assert.is_true(prompt.index_of("<available_skills>") != null);
    assert.is_true(prompt.index_of("ACTIVE BODY") != null);
    // The gate: an inert skill's guidance is absent from the prompt.
    assert.is_true(prompt.index_of("INERT BODY") == null);
    // Empty / fully-inert registry compiles to no section at all.
    assert.equal(compile_skills_prompt([], ctx), "");
    let inert_only: Skill[] = [StubSkill { owner: "curator", applies: false, body: "X" }];
    assert.equal(compile_skills_prompt(inert_only, ctx), "")
}

test "active_skills filters via dynamic dispatch" {
    let skills: Skill[] = [
        StubSkill { owner: "curator", applies: true, body: "A" },
        StubSkill { owner: "curator", applies: false, body: "B" },
        ground_first_skill(),
    ];
    let ctx = fixture_ctx("plain refactor question", false);
    let active = active_skills(skills, ctx);
    // Stub A applies; stub B does not; ground-first does not fire on a
    // plain refactor question with session_start=false.
    assert.equal(active.length(), 1);
    // Session start flips ground-first on through the same interface call.
    let at_start = active_skills(skills, fixture_ctx("", true));
    assert.equal(at_start.length(), 2)
}

test "fence composition: refused patch implies skill stays user-owned" {
    // The invariant as a whole: for EVERY curator-origin patch aimed at a
    // user-owned skill the fence says no, so ownership is stable under the
    // curator loop.
    for (let name in ["ground-first", "baml-core", "strong-solver"]) {
        let p = SkillPatch {
            skill_name: name,
            target_owner: "user",
            origin: "curator",
            diff_summary: "any curator diff",
        };
        assert.is_true(!owner_fence_allows(p))
    }
}
