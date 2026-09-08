// ns_skills/ground_first_test — the reference skill's executable "When to
// Use" (hub#205 shape proof): literal TurnContext fixtures gate the port of
// .agents/skills/ground-first.
//
// ── Red-check record (bi#57) ─────────────────────────────────────────────
// RC-1 (check-rejection gate) — hunk: in ns_skills/ground_first.baml
//   GroundFirstSkill.applies_to, return the string "yes" instead of a bool.
//   Expected: `baml check --project bi` REJECTS the file with a type error
//   naming the applies_to return type — an agent-authored skill that fails
//   check never compiles, let alone reaches the prompt.
//   Observed: `baml check --project bi` rejects with
//   "E0001 × mismatched types — ground_first.baml:20:61 — expected `bool`,
//   found `"yes"`" — the compiler error names the file, line, and expected
//   type. Restored, re-ran: 60 files checked, 458/458 tests green.
// ─────────────────────────────────────────────────────────────────────────

test "session start always applies" {
    let s = ground_first_skill();
    assert.is_true(s.applies_to(fixture_ctx("", true)));
    assert.is_true(s.applies_to(fixture_ctx("refactor the parser", true)))
}

test "existence and inventory claims apply" {
    let s = ground_first_skill();
    assert.is_true(s.applies_to(fixture_ctx("BITS does not exist in this repo", false)));
    assert.is_true(s.applies_to(fixture_ctx("check whether the retry module exists", false)));
    assert.is_true(s.applies_to(fixture_ctx("the bais integration is not implemented", false)));
    assert.is_true(s.applies_to(fixture_ctx("survey the codebase before planning", false)));
    assert.is_true(s.applies_to(fixture_ctx("the README says there are three siblings", false)))
}

test "plain coding questions do not apply and stay out of the prompt" {
    let s = ground_first_skill();
    let ctx = fixture_ctx("rename foo to bar in cli.ts", false);
    assert.is_true(!s.applies_to(ctx));
    let prompt = compile_skills_prompt([s], ctx);
    assert.equal(prompt, "")
}

test "guidance carries the ported rules" {
    let g = ground_first_skill().guidance();
    assert.is_true(g.index_of("enumerate before you theorize") != null);
    assert.is_true(g.index_of("List before you claim") != null);
    assert.is_true(g.index_of("Docs are hypotheses") != null);
    assert.is_true(g.index_of("Absence is not evidence") != null);
    assert.is_true(g.index_of("Re-ground after compaction") != null)
}

test "owner is user — the fence protects this skill" {
    let s = ground_first_skill();
    assert.equal(s.owner, "user");
    assert.equal(s.name, "ground-first");
    let curator_patch = SkillPatch {
        skill_name: s.name,
        target_owner: s.owner,
        origin: "curator",
        diff_summary: "curator rewrites ground-first",
    };
    assert.is_true(!owner_fence_allows(curator_patch))
}

test "dispatches through the Skill interface in a mixed registry" {
    let registry: Skill[] = [ground_first_skill()];
    let prompt = compile_skills_prompt(registry, fixture_ctx("does the theme module exist", false));
    assert.is_true(prompt.index_of("<available_skills>") != null);
    assert.is_true(prompt.index_of("ground-first") != null)
}
