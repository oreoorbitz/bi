// ns_skills/ground_first — reference port of .agents/skills/ground-first
// (hub#205 shape proof: ONE existing markdown skill ported to a typed Skill
// impl). The markdown original stays the prose source; this class is the
// executable half — its "When to Use" is applies_to, gated by baml test on
// literal TurnContext fixtures in ground_first_test.baml. Companion doc:
// .agents/skills/ground-first/BAML.md.
//
// owner = "user": the markdown original is user-authored, so the owner
// fence (skills.baml owner_fence_allows) refuses curator-origin patches to
// this skill. File-per-skill layout (BAIS-style): one skill, one file, git
// is the ledger.

class GroundFirstSkill {
    name: string,
    owner: SkillOwner,
    implements Skill {
        // Executable form of ground-first's "When to Use": session start,
        // before surveys, and whenever a doc prior substitutes for a live
        // observation (existence/inventory claims about the world).
        function applies_to(self, ctx: TurnContext) -> bool {
            if (ctx.session_start) {
                true
            } else {
                let text = ctx.text.to_lower_case();
                let markers = [
                    "does not exist",
                    "doesn't exist",
                    " exist",
                    "not implemented",
                    "isn't implemented",
                    "no such file",
                    "survey",
                    "readme says",
                    "agents.md says",
                ];
                let hit = false;
                for (let m in markers) {
                    if (text.index_of(m) != null) {
                        hit = true
                    }
                }
                hit
            }
        }

        function guidance(self) -> string {
            "# ground-first — enumerate before you theorize\nA doc prior (README, session summary, issue body) is a hypothesis about the world; `ls`, `read`, and command output are the world.\n\nRules:\n1. List before you claim — before asserting what exists, run the enumerating command (`ls`, `rg --files`, `<cli> --help`, `check`).\n2. Docs are hypotheses — when a doc and a listing disagree, the listing wins; then fix the doc.\n3. Absence is not evidence — \"I haven't seen X\" never becomes \"X doesn't exist\" without an enumerating check that should have shown X; name the check.\n4. Spell out strawberry — when a claim depends on exact contents, quote the output, don't summarize from memory.\n5. Re-ground after compaction — re-run the one-line enumerations your plan depends on.\n\nChecklist: `ls` the workspace root; `<project> check/test --help` before assuming CLI capabilities; `rg` the symbol before asserting it is/isn't implemented; after a move/migration, check both sides + `cmp` before deleting either."
        }
    }
}

// The shipped instance. owner = "user" — see the fence invariant test.
function ground_first_skill() -> GroundFirstSkill {
    GroundFirstSkill { name: "ground-first", owner: "user" }
}
