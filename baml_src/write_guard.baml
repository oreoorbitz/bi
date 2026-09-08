// hub#208 rail 1: READ-BEFORE-WRITE as a tool-layer gate, not a prompt
// instruction. Port of hermes' skill_manager_guards.py
// _background_review_read_before_write_guard (lines 55-71 read marks,
// 220-230 refusal): the review fork must load the exact target content in
// this turn before mutating it — a patch to content only inferred from the
// transcript is refused with `_read_before_write_required`.
//
// bi generalizes the rail from hermes' background-review-only scope to the
// whole mutating tool surface: the TS host (src/tools.ts) keeps a per-session
// set of read marks (resolved absolute paths the `read` tool served this
// session) and consults THIS policy before any write/edit. BAML owns the
// policy decision and the refusal string (bi#55 named reason); the host owns
// only the mark set — byte work, no judgment.
//
// Named divergences from the hermes original:
//
// 1. SCOPE. hermes fences only the autonomous background-review fork
//    (_is_background_review()); bi's guarded entry point
//    (handleToolInSession) fences every mutating call routed through it.
//    Which sessions route through the guard is a host wiring decision (cli
//    wiring is a follow-up — the guard ships as an exported policy wrapper).
// 2. NEW-FILE CREATION IS UNFENCED. hermes' guard fires on edit/patch/
//    delete/write_file/remove_file of an EXISTING skill; there is nothing to
//    have read when creating a file that does not exist. `write` requires a
//    read mark only when the target already exists (overwrite); `edit`
//    always requires one (its target must exist to be edited).
// 3. MARK SOURCE. hermes marks via skill_view/read_file; bi marks on any
//    successful `read` tool call (the only tool that serves file content
//    verbatim). ls/grep/find do NOT mark — they show names/fragments, not
//    the content a write would destroy.

// What the host asks before a mutating call. All fields are plain data the
// host computes (path as given, existence + read-mark lookups against its
// resolved-path set).
class WriteGuardQuery {
    tool: string, // "write" | "edit"
    path: string, // the path as the caller gave it (for the refusal message)
    target_exists: bool, // host stat of the resolved path
    read_this_session: bool, // host read-mark lookup of the resolved path
}

class WriteGuardAllow {
    tool: string,
}

class WriteGuardRefuse {
    tool: string,
    path: string,
    reason: string, // the named reason (bi#55) — read-before-write required
}

type WriteGuardVerdict = WriteGuardAllow | WriteGuardRefuse;

// Which mutating calls need a read mark at all (divergence 2): edit always
// (its target exists by definition), write only when overwriting.
function write_guard_requires_read(tool: string, target_exists: bool) -> bool {
    match (tool) {
        "edit" => true,
        "write" => target_exists,
        let other => false,
    }
}

// The named refusal (bi#55). Mirrors the existing refuse_* string idiom in
// tools.baml: lowercase, names the tool, the target, the violated policy,
// and the fix.
function refuse_write_not_read(tool: string, path: string) -> string {
    `refusing ${tool} of "${path}": read-before-write — this target has not been read this session, so the write would replace content never loaded. Call read on "${path}" first, then retry the ${tool} using the content just returned`
}

// The gate itself. Requires-read tools with no mark refuse; everything else
// passes. An unread NEW-file write passes (creation, not rewrite).
function write_guard_check(query: WriteGuardQuery) -> WriteGuardVerdict {
    if (write_guard_requires_read(query.tool, query.target_exists) && !query.read_this_session) {
        WriteGuardRefuse {
            tool: query.tool,
            path: query.path,
            reason: refuse_write_not_read(query.tool, query.path),
        }
    } else {
        WriteGuardAllow { tool: query.tool }
    }
}
