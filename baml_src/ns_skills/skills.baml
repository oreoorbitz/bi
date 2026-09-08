// ns_skills — skill-as-BAML (hub#205): self-authored procedural memory as
// compiled, tested code instead of linted markdown.
//
// hermes rebuilt a poor-man's compiler in Python/regex to make markdown
// skills safe (skill_linter.py, _validate_frontmatter, provenance
// ContextVars, ownership fences, ledger+rollback). Every one of those gates
// approximates what `baml check` + `baml test` + the type system give
// natively: an agent-authored skill here is a TYPED impl of the `Skill`
// interface — `baml check` rejects a malformed one with the compiler error,
// `baml test` on literal TurnContext fixtures is an executable "When to
// Use", and file-per-skill layout (BAIS-style) makes git the ledger and
// rollback hermes hand-built.
//
// Self-contained on purpose (`ns_*` no imports): TurnContext is DEFINED
// here as plain data (bi's FFI idiom — plain data crosses the host/BAML
// boundary; the host fills it per turn). bi root has no TurnContext today;
// if one ever appears, mirror by convention with a header note on both
// sides (bits/baml_src/do_not_capture.baml mirroring bi review.baml is the
// precedent). The root `Skill` class in bi/baml_src/skills.baml (pi's
// registry row) is unrelated to this namespace's `skills.Skill` interface.

// Plain-data view of the turn the host assembles: enough for a skill's
// applies_to to be an honest executable "When to Use" without the skill
// touching session internals.
class TurnContext {
    text: string,
    provider: string,
    model: string,
    cwd: string,
    session_start: bool,
    staged_attachments: int,
}

// Ownership provenance for the fence. "user" skills are user-authored (or
// user-blessed) and refuse curator-origin patches; "curator" skills are
// agent-maintained and accept them. User-origin patches are always allowed.
type SkillOwner = "user" | "curator";

// The contract every agent-authored skill implements. applies_to is the
// executable "When to Use" — gated by baml test on literal TurnContext
// fixtures; guidance is what reaches the model when the skill applies.
interface Skill {
    function applies_to(self, ctx: TurnContext) -> bool
    function guidance(self) -> string
}

// A proposed patch to a skill file, as plain data. The host (or a review
// fork) constructs these; the fence decides. diff_summary is a description
// of the change, not the patch body — the fence judges provenance, not
// content (content is what baml check/test gate).
class SkillPatch {
    skill_name: string,
    target_owner: SkillOwner,
    origin: SkillOwner,
    diff_summary: string,
}

// Owner fence (hub#205 acceptance): curator-origin patches to owner="user"
// skills are refused. Everything else passes — user edits are sovereign,
// curator maintenance of curator-owned skills is the normal loop.
function owner_fence_allows(patch: SkillPatch) -> bool {
    if (patch.target_owner == "user" && patch.origin == "curator") {
        false
    } else {
        true
    }
}

// Adoption (hub#208 rail 2): the EXPLICIT ownership transfer — hermes
// `hermes curator adopt <name>`, the only supported way a user-owned skill
// enters curator management. Deliberately a standalone decision, never a
// side effect of a patch: the fence can never opt itself in. Only a
// user-origin request adopts; a curator-origin "adoption" is the fence's
// own bypass and refuses with the reason named (bi#55).
class SkillAdoption {
    skill_name: string,
    requested_by: SkillOwner,
}

class SkillAdopted {
    skill_name: string,
    owner: SkillOwner, // always "curator" — adopted INTO curator management
}

class SkillAdoptRefused {
    skill_name: string,
    reason: string,
}

type SkillAdoptResult = SkillAdopted | SkillAdoptRefused;

function adopt_skill(req: SkillAdoption) -> SkillAdoptResult {
    if (req.requested_by == "user") {
        SkillAdopted { skill_name: req.skill_name, owner: "curator" }
    } else {
        SkillAdoptRefused {
            skill_name: req.skill_name,
            reason: `refusing curator-origin adoption of "${req.skill_name}": adoption is the explicit ownership transfer and only the user may grant it — a curator that could adopt user skills would be its own fence's bypass`,
        }
    }
}

// Registry filter: the skills whose executable When-to-Use fires on this
// turn. Dynamic dispatch — a Skill[] holds any implementor.
function active_skills(skills: Skill[], ctx: TurnContext) -> Skill[] {
    let out: Skill[] = [];
    for (let s in skills) {
        if (s.applies_to(ctx)) {
            out.push(s)
        }
    }
    out
}

// Prompt compilation: ONLY active skills reach the model. A skill whose
// applies_to is wrong fails its fixture test and — even if it somehow
// shipped — is excluded here, so a failing skill never reaches the prompt
// (hub#205 acceptance). Empty registry compiles to "" (no section).
function compile_skills_prompt(skills: Skill[], ctx: TurnContext) -> string {
    let out = "";
    for (let s in skills) {
        if (s.applies_to(ctx)) {
            out = `${out}<skill>\n${s.guidance()}\n</skill>\n`
        }
    }
    if (out == "") {
        ""
    } else {
        `<available_skills>\n${out}</available_skills>`
    }
}

// Provider-neutral spec (TurnPrompt precedent, bi/baml_src/turn.baml:128-134):
// only used for its compiled prompt template, never called directly. The
// declared client is a nominal default — the real client is constructed in
// the host. The host renders compile_skills_prompt and splices the result
// in as `compiled_skills`.
function SkillsPrompt(compiled_skills: string) -> string {
    client: "anthropic/claude-haiku-4-5"
    prompt: `${role("system")}The following skills apply to this turn. Follow their guidance.\n\n${compiled_skills}`
}
