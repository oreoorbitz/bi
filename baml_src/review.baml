// hub#203: post-turn background review as a BAML function.
//
// Port of hermes' forked post-turn review (hermes-agent/agent/
// background_review.py:299-517 — _MEMORY_REVIEW_PROMPT, _SKILL_REVIEW_PROMPT,
// _COMBINED_REVIEW_PROMPT plus the shared lesson-layer and do-not-capture
// blocks) into a single structured-output function:
//
//     ReviewTurn(digest: TranscriptDigest) -> ReviewAction
//
// Two deliberate adaptations from the hermes original:
//
// 1. PROPOSALS, NOT WRITES. hermes' fork calls memory/skill tools directly
//    and serializes writes behind approval UX. bi's fork returns ONE typed
//    plain-data proposal; the TS host stages it into a pending/ dir and a
//    human approves or rejects it (bi review pending|approve|reject).
//    Nothing reaches memory, skills, or .bais/issues/ without approval —
//    the prompt below says exactly that so the model never narrates writes
//    it did not perform.
//
// 2. AN ISSUE ARM. bi's store trio is memory + skills + BAIS issues, so the
//    combined prompt gains a third target hermes does not have: a durable
//    problem or follow-up becomes an IssueProposal (staged like the rest,
//    approved into .bais/issues/ via createBaisIssue).
//
// Plain-data FFI idiom (turn.baml limitations 2/4): every type here is
// field-only classes and literal-string unions — no enums, no interfaces,
// no handles. The union crosses the bridge as a returned value, the
// direction that decodes cleanly.
//
// Offline surface: render_digest / *_review_prompt / review_prompt_for are
// pure and unit-tested on literal data; ReviewTurn itself is exercised via
// ReviewTurn$parse on literal model output — no test makes an LLM call.

// One transcript turn, pre-digested by the host (tools.ts
// buildTranscriptDigest — hermes' 300/200-char truncation lives there, so
// the VM only ever sees bounded text).
class DigestEntry {
    role: string, // "user" | "assistant"
    text: string,
    tools: string[], // tool names this turn invoked (assistant; [] for user)
}

class TranscriptDigest {
    session_id: string,
    earlier_summary: string?, // older turns pre-summarised by the host; null = none
    recent: DigestEntry[],
    skills_loaded: string[], // skills consulted this session (patch candidates)
}

// Memory proposal — hermes' add/replace/remove op set. `remove` carries
// the text to forget in old_text; `add`/`replace` carry the new content.
class MemoryAdd {
    op: "add" | "replace" | "remove",
    content: string,
    old_text: string?,
    rationale: string,
}

// Skill proposal. target_file is relative to the skill dir: "SKILL.md",
// "references/<topic>.md", "templates/<name>.<ext>", "scripts/<name>.<ext>".
class SkillPatch {
    skill: string,
    action: "patch" | "add_reference" | "add_template" | "add_script" | "create",
    target_file: string,
    content: string,
    rationale: string,
}

// BAIS issue proposal (bi's third store — no hermes counterpart).
class IssueProposal {
    title: string,
    // The BAIS Kind set verbatim (bais/baml_src ns_toml parse_kind:
    // Bug/Feat/Proposal/Debt/Flake/Spike) — an approved IssueProposal must
    // never fail BAIS validation on kind ("Chore" is NOT a Kind).
    kind: "Bug" | "Feat" | "Proposal" | "Debt" | "Flake" | "Spike",
    area: string?,
    body: string,
    rationale: string,
}

// A real outcome, not a failure: smooth sessions with no corrections and
// no new technique SHOULD return this (hermes: 'Nothing to save.').
class NothingToSave {
    reason: string,
}

type ReviewAction = MemoryAdd | SkillPatch | IssueProposal | NothingToSave;

// Shared framing for all three modes: the fork proposes, humans dispose.
function staging_preamble() -> string {
    "You are the post-turn review fork for the bi coding agent. The main conversation is over; you review its digest below with fresh eyes. You CANNOT write to any store — no memory tool, no skill tool, no issue tracker. You return exactly ONE typed proposal (or NothingToSave). Every proposal lands in a staging area where a human approves or rejects it; nothing reaches memory, skills, or the issue tracker without that approval. Never claim you saved, updated, or filed anything — you proposed it, that is all."
}

// render_digest is the VM-side mirror of hermes' digest lines (USER:/ASSISTANT:/
// ASSISTANT[tools: ...]); truncation already happened host-side.
function render_digest(digest: TranscriptDigest) -> string {
    let lines: string[] = [];
    if let s: string = digest.earlier_summary {
        lines.push(
            `[Earlier conversation digest — older turns summarised to bound review cost]\n${s}`,
        );
    }
    for (let e in digest.recent) {
        if (e.tools.length() > 0) {
            lines.push(`${e.role.to_upper_case()}[tools: ${e.tools.join(", ")}]`);
        }
        if (e.text.length() > 0) {
            lines.push(`${e.role.to_upper_case()}: ${e.text}`);
        }
    }
    if (digest.skills_loaded.length() > 0) {
        lines.push(`[Skills loaded this session: ${digest.skills_loaded.join(", ")}]`);
    }
    lines.join("\n")
}

// --- Port: hermes _MEMORY_REVIEW_PROMPT (background_review.py:299-308) ---
function memory_review_prompt() -> string {
    "Review the conversation above and consider proposing a memory write if appropriate.\n\nFocus on:\n1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?\n2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?\n\nIf something stands out, return a MemoryAdd proposal (op add for a new fact, replace with old_text to correct an existing one, remove with old_text to forget one). If nothing is worth saving, return NothingToSave and stop."
}

// Shared shape contract (hermes _LESSON_LAYER_BLOCK, :313-340) — the
// anti-hoarding rules for anything written into a skill.
function lesson_layer_block() -> string {
    "What a skill IS: the instructions for doing a class of task the most efficient and correct way, to THIS user's specifications — the procedure, the tools and commands that work, the order, the user's preferences for how the result should look, and the pitfalls that cost time. A future session should be able to follow it and produce what the user wants on the first try. Everything below is about writing that well:\n  - Procedure first: the steps in the order they are done, with the concrete commands, tool calls, and decision points. Lessons and pitfalls attach to the step they affect.\n  - A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative. 'Grep the test tree for the SYMBOL before widening a helper signature — hand-rolled mocks reimplement the old shape and fail on a shard you did not run.' Not a narrative of what happened this session.\n  - No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must stand without the incident behind it. Keep a short quote ONLY when the quote itself is the clearest statement of the rule.\n  - The same lesson learned twice is ONE rule. Before proposing, search the digest for the rule already stated; strengthen or clarify it rather than appending a second copy.\n  - Not a duplicate of what the environment already teaches: repo AGENTS.md files, tool schema descriptions, and other always-loaded context. A skill carries the WORKFLOW and the pitfalls; it does not restate the codebase map or a tool's parameter list.\n  - Always-on rules (standing user preferences, gates that apply to every instance of the task) live in SKILL.md itself, whole. references/ is for depth that is only needed sometimes: a decision table, a recipe, a domain note — each file topical and reusable, never '<date>-<incident>.md'.\n  - Fix the skill in place when it is wrong: the proposal's content REPLACES the misleading passage, it does not append 'UPDATE: actually...' underneath it.\n"
}

// Shared tail (hermes _DO_NOT_CAPTURE_BLOCK, :343-366) — what must NOT
// become a persistent self-imposed constraint.
function do_not_capture_block() -> string {
    " (these become persistent self-imposed constraints that bite you later when the environment changes):\n  - Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.\n  - Negative claims about tools or features ('browser tools do not work', 'X tool is broken'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.\n  - Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.\n  - One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a skill.\n  - Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked — do NOT write those attempts up as a 'reliable workflow'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either return NothingToSave, or, only if you are independently confident of a real working alternative (not something you are merely guessing might work), capture ONLY that alternative — never the dead ends, and never dressed up as best practice.\n\nIf a tool failed because of setup state, propose the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill — never 'this tool does not work' as a standalone constraint.\n"
}

// --- Port: hermes _SKILL_REVIEW_PROMPT (background_review.py:368-452) ---
// hermes' tool machinery (skill_view read-before-write, skill_manage
// write_file, curator-managed vs pinned/user-owned protection) has no
// fork-side equivalent here: every write is a staged proposal, so the
// protection list collapses into one rule — you propose, the human's
// approve/reject IS the protection. The preference order and signals port
// verbatim.
function skill_review_prompt() -> string {
    `Review the conversation above and propose a skill-library update. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.\n\nTarget shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small references/ set of topical depth. Not a flat list of narrow one-session skills, and not an umbrella hoarding a references/ file per session. This shapes HOW you propose, not WHETHER you propose.\n\n${lesson_layer_block()}Signals to look for (any one of these warrants a proposal):\n  - User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', 'this is too verbose', 'why are you explaining', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory signals. Propose a patch to the relevant skill so the next session starts already knowing.\n  - User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.\n  - Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from.\n  - A skill that was loaded or consulted this session turned out to be wrong, missing a step, or outdated. Propose its patch NOW.\n\nPreference order — propose the earliest action that fits, but DO propose one when a signal above fired:\n  1. PATCH A SKILL LOADED THIS SESSION (the digest names them). It was in play, so it is the right one to extend.\n  2. PATCH AN EXISTING CLASS-LEVEL SKILL (action patch, target_file SKILL.md). Add a subsection, a pitfall, or broaden a trigger.\n  3. ADD A SUPPORT FILE under an existing umbrella: references/<topic>.md for topical depth (decision tables, recipes, provider quirks — extend an existing topical file before creating one, never a per-session file), templates/<name>.<ext> for starter files meant to be copied and modified, scripts/<name>.<ext> for statically re-runnable actions. The umbrella's SKILL.md should gain a one-line pointer to any new support file.\n  4. CREATE A NEW CLASS-LEVEL UMBRELLA (action create) when no existing skill covers the class. The name MUST be at the class level — NOT a PR number, error string, feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the proposed name only makes sense for today's task, fall back to (1), (2), or (3).\n\nUser-preference embedding: when the user expressed a style/format/workflow preference, the proposal belongs in the SKILL.md body, not just in memory. Memory captures who the user is; skills capture how to do this class of task for this user.\n\nDo NOT capture${do_not_capture_block()}NothingToSave is a real option but should NOT be the default. If the session ran smoothly with no corrections and produced no new technique, return NothingToSave and stop. Otherwise, propose.`
}

// --- Port: hermes _COMBINED_REVIEW_PROMPT (background_review.py:454-517) ---
// plus bi's third store (BAIS issues).
function combined_review_prompt() -> string {
    `Review the conversation above and propose an update to one of three stores:\n\n**Memory** (MemoryAdd): who the user is. Did the user reveal persona, desires, preferences, personal details, or expectations about how you should behave?\n\n**Skills** (SkillPatch): how to do this class of task. Be ACTIVE — most sessions produce at least one skill update. A pass that does nothing is a missed learning opportunity, not a neutral outcome. Target shape: CLASS-LEVEL skills with a SKILL.md of always-on rules and a small references/ set of topical depth — not narrow one-session skills, and not an umbrella hoarding a references/ file per session.\n\n**Issues** (IssueProposal): a durable problem, follow-up, or flake worth tracking in the BAIS issue graph. Propose an issue when the session surfaced work that outlives it — a bug not fixed, a feature agreed but not built, a recurring flake. One-off task narratives are NOT issues.\n\n${lesson_layer_block()}Signals that warrant a skill update (any one is enough):\n  - User corrected your style, tone, format, legibility, verbosity, or approach. Frustration is a FIRST-CLASS skill signal, not just a memory signal — embed the lesson in the skill that governs that task so the next session starts fixed.\n  - Non-trivial technique, fix, workaround, or debugging path emerged.\n  - A skill that was loaded or consulted turned out wrong, missing, or outdated — propose its patch now.\n\nPreference order for skills — pick the earliest that fits:\n  1. PATCH A SKILL LOADED THIS SESSION (named in the digest).\n  2. PATCH AN EXISTING CLASS-LEVEL SKILL.\n  3. ADD A SUPPORT FILE under an existing umbrella (references/ topical depth, templates/ starter files, scripts/ re-runnable actions; SKILL.md gains a one-line pointer).\n  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists — class-level name, never a session artifact.\n\nDo NOT capture as skills${do_not_capture_block()}Return the ONE proposal with the strongest signal across all three stores. If genuinely nothing stands out on any dimension, return NothingToSave and stop — but do not reach for that conclusion as a default.`
}

// Mode dispatch — a bogus mode is a clean InvalidArgument naming the value
// (same treatment as turn.baml's string provider tag).
function review_prompt_for(mode: string) -> string {
    match (mode) {
        "memory" => memory_review_prompt(),
        "skill" => skill_review_prompt(),
        "combined" => combined_review_prompt(),
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown review mode: ${other} (want "memory", "skill", or "combined")`,
            }
        },
    }
}

// Full prompt assembly, shared by the three entry points below. (A defaulted
// `mode` param on the DSL function itself breaks 0.17.0 desugaring — E0005
// "defaulted parameter must be passed by name" — so mode is three functions
// over this one builder instead of one function with a default. The builder
// takes the already-selected prompt TEXT, not the mode tag: a DSL prompt
// must be throws-never, and routing through review_prompt_for would carry
// its InvalidArgument into the prompt type.)
function review_prompt_full(digest: TranscriptDigest, prompt_text: string) -> string {
    `
        ${staging_preamble()}

        [Conversation digest — session ${digest.session_id}]
        ${render_digest(digest)}

        ${prompt_text}
    `
}

// The review fork. Plain-data union out (TurnFailure-union idiom); the host
// stages whatever comes back — ReviewTurn never touches a store itself.
// Combined covers all three stores (hermes' _COMBINED_REVIEW_PROMPT);
// ReviewTurnMemory / ReviewTurnSkill are hermes' two single-prompt passes.
function ReviewTurn(digest: TranscriptDigest) -> ReviewAction {
    client: "anthropic/claude-haiku-4-5"
    prompt: `
        ${role("user")}${review_prompt_full(digest, combined_review_prompt())}

        ${ctx.output_format}
    `
}

function ReviewTurnMemory(digest: TranscriptDigest) -> ReviewAction {
    client: "anthropic/claude-haiku-4-5"
    prompt: `
        ${role("user")}${review_prompt_full(digest, memory_review_prompt())}

        ${ctx.output_format}
    `
}

function ReviewTurnSkill(digest: TranscriptDigest) -> ReviewAction {
    client: "anthropic/claude-haiku-4-5"
    prompt: `
        ${role("user")}${review_prompt_full(digest, skill_review_prompt())}

        ${ctx.output_format}
    `
}
