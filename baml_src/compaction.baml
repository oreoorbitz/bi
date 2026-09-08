// Compaction for long sessions — ported from pi (packages/agent harness +
// coding-agent core compaction), reduced to the smallest BAML surface.
//
// Split (same rule as the rest of bi): BAML owns the DECISION (trigger rule,
// cut point, summary schema, prompt spec); the host owns MEASUREMENT
// (per-turn token estimates over ConversationTurn) and EXECUTION (the
// summarization LLM call + history splice in compaction.ts / agent_loop.ts).
// pi's session-entry tree (branch ancestry, file-op extraction) has no bi
// counterpart — bi compacts flat message arrays, so branch summaries carry
// file lists supplied by the host instead of extracted ones.

class CompactionSettings {
    enabled: bool,
    reserve_tokens: int @description(
        "tokens reserved for the summary prompt + output; trigger fires past window - reserve",
    ),
    keep_recent_tokens: int @description("approximate recent-context tokens retained after the cut"),
}

function default_compaction_settings() -> CompactionSettings {
    CompactionSettings { enabled: true, reserve_tokens: 16384, keep_recent_tokens: 20000 }
}

// pi's rule exactly: compact when usage exceeds window minus reserve.
// Disabled settings never trigger, no matter the usage.
function should_compact(
    context_tokens: int,
    context_window: int,
    enabled: bool,
    reserve_tokens: int,
) -> bool {
    if (!enabled) {
        false
    } else {
        context_tokens > context_window - reserve_tokens
    }
}

// pi's char heuristic exactly: ceil(chars / 4), images counted upstream as
// 4800 chars. Integer math: (chars + 3) / 4 truncates like ceil for chars >= 0.
function estimate_text_tokens(chars: int) -> int {
    if (chars <= 0) {
        0
    } else {
        (chars + 3) / 4
    }
}

// Message-granularity cut point: walk sizes from the end until the keep budget
// is met; return the first index to KEEP (0 keeps everything). The host refines
// to turn starts when its message list has sub-turn structure; bi's
// ConversationTurn list is already turn-granular, so this is the cut.
function find_cut_index(sizes: int[], keep_recent_tokens: int) -> int {
    let acc = 0;
    let cut = 0;
    let stopped = false;
    let i = sizes.length() - 1;
    while (i >= 0 && !stopped) {
        acc = acc + sizes[i];
        if (acc >= keep_recent_tokens) {
            cut = i;
            stopped = true;
        }
        i = i - 1;
    }
    cut
}

// Structured summary schema — typed where pi uses markdown sections, so the
// continued session can read goals/decisions as values. Field order mirrors
// pi's SUMMARIZATION_PROMPT sections (Goal, Constraints, Progress,
// Decisions, Next Steps, Critical Context).
class CompactionSummary {
    goal: string,
    constraints: string,
    done: string[],
    in_progress: string[],
    blocked: string[],
    decisions: string[],
    next_steps: string[],
    context: string,
}

// Branch summary for subagent explorations: same shape plus identity and the
// host-supplied file lists pi extracts from session entries (bi has no entry
// tree, so the host passes what it observed).
class BranchSummary {
    branch_id: string,
    summary: CompactionSummary,
    read_files: string[],
    modified_files: string[],
}

// Prompt spec (pure builder — the LLM call stays host-side via SendTurn, so
// this is testable offline). Section structure follows pi verbatim; the model
// is instructed to output the summary as plain sections the host parses back
// into CompactionSummary.
function summarize_prompt(history: string) -> string {
    `
        You are a context summarization assistant. Read the conversation below, then produce a structured summary another LLM will use to continue the work.

        Do NOT continue the conversation. Do NOT answer questions in it. ONLY output the summary, using this EXACT format:

        ## Goal
        [What is the user trying to accomplish?]

        ## Constraints & Preferences
        [Any constraints or requirements, or "(none)"]

        ## Progress
        ### Done
        - [x] [Completed tasks/changes]

        ### In Progress
        - [ ] [Current work]

        ### Blocked
        - [Issues preventing progress, if any]

        ## Key Decisions
        - **[Decision]**: [Brief rationale] (preserve all previous, add new)

        ## Next Steps
        1. [Ordered list of what should happen next]

        ## Critical Context
        [Any data, examples, or references needed to continue, or "(none)"]

        Keep each section concise. Preserve exact file paths, function names, and error messages.

        Conversation:
        ${history}
    `
}

function branch_prompt(branch_id: string, history: string) -> string {
    `
        Branch ${branch_id} explored alternatives to the main line. Summarize it with the same section format, plus the files it read and modified.

        ${summarize_prompt(history)}
    `
}

test "trigger fires past window minus reserve" {
    let s = default_compaction_settings();
    assert.equal(s.enabled, true);
    assert.equal(s.reserve_tokens, 16384);
    assert.equal(s.keep_recent_tokens, 20000);
    // 200k window, 16384 reserve → fires past 183616.
    assert.equal(should_compact(183616, 200000, s.enabled, s.reserve_tokens), false);
    assert.equal(should_compact(183617, 200000, s.enabled, s.reserve_tokens), true);
    assert.equal(should_compact(999999, 200000, false, s.reserve_tokens), false)
}

test "char heuristic matches pi ceil(chars/4)" {
    assert.equal(estimate_text_tokens(0), 0);
    assert.equal(estimate_text_tokens(1), 1);
    assert.equal(estimate_text_tokens(4), 1);
    assert.equal(estimate_text_tokens(5), 2);
    assert.equal(estimate_text_tokens(4800), 1200);
    assert.equal(estimate_text_tokens(-10), 0)
}

test "cut keeps trailing budget, 0 keeps all" {
    // sizes [10, 20, 30], keep 35 → 30 + 20 >= 35 → keep from index 1.
    assert.equal(find_cut_index([10, 20, 30], 35), 1);
    assert.equal(find_cut_index([10, 20, 30], 1000), 0);
    assert.equal(find_cut_index([], 35), 0);
    // exact budget hit keeps the fitting message.
    assert.equal(find_cut_index([10, 20, 30], 30), 2)
}

test "summary prompt carries pi sections and history" {
    let p = summarize_prompt("user: fix the login bug");
    assert.is_true(p.index_of("## Goal") != null);
    assert.is_true(p.index_of("## Key Decisions") != null);
    assert.is_true(p.index_of("## Critical Context") != null);
    assert.is_true(p.index_of("Do NOT continue the conversation") != null);
    assert.is_true(p.index_of("user: fix the login bug") != null)
}

test "branch prompt names the branch and reuses sections" {
    let p = branch_prompt("branch-7", "user: try another approach");
    assert.is_true(p.index_of("branch-7") != null);
    assert.is_true(p.index_of("## Next Steps") != null);
    assert.is_true(p.index_of("user: try another approach") != null)
}

// Transcript marker (bi#97): the splice leaves this user turn in history,
// so the session file carries the compaction record and /resume can replay
// the block. BAML owns format + parse; the host owns token measurement
// (estimateHistoryTokens) and emission (printCompactionSummary). The legacy
// marker ("... folded in):\n...") carries no token counts — it parses with
// null tokens and replays as plain text, never invented numbers.
class CompactionMarker {
    folded_turns: int,
    tokens_before: int?,
    tokens_after: int?,
    summary: string,
}

function format_compaction_marker(
    folded_turns: int,
    tokens_before: int,
    tokens_after: int,
    summary: string,
) -> string {
    `Session summary (compacted, ${folded_turns} earlier turns folded in, ${tokens_before}→${tokens_after} tokens):\n${summary}`
}

function parse_uint_digits(s: string) -> int? {
    if (s.length() == 0) {
        null
    } else {
        let v = 0;
        let ok = true;
        for (let c in s.chars()) {
            match ("0123456789".index_of(c)) {
                null => {
                    ok = false
                },
                let d: int => {
                    v = v * 10 + d
                },
            }
        }
        ;
        if (ok) {
            v
        } else {
            null
        }
    }
}

function parse_compaction_marker(text: string) -> CompactionMarker? {
    let open = "Session summary (compacted, ";
    if (!text.starts_with(open)) {
        null
    } else {
        let r = text.slice(open.length(), text.length());
        match (r.index_of(" earlier turns folded in")) {
            null => null,
            let q1: int => {
                match (parse_uint_digits(r.slice(0, q1))) {
                    null => null,
                    let folded: int => {
                        let r2 = r.slice(q1 + " earlier turns folded in".length(), r.length());
                        if (r2.starts_with("):\n")) {
                            CompactionMarker {
                                folded_turns: folded,
                                tokens_before: null,
                                tokens_after: null,
                                summary: r2.slice(3, r2.length()),
                            }
                        } else if (r2.starts_with(", ")) {
                            let r3 = r2.slice(2, r2.length());
                            match (r3.index_of("→")) {
                                null => null,
                                let qa: int => {
                                    match (parse_uint_digits(r3.slice(0, qa))) {
                                        null => null,
                                        let before: int => {
                                            let r4 = r3.slice(qa + "→".length(), r3.length());
                                            match (r4.index_of(" tokens):\n")) {
                                                null => null,
                                                let qb: int => {
                                                    match (parse_uint_digits(r4.slice(0, qb))) {
                                                        null => null,
                                                        let after: int => {
                                                            CompactionMarker {
                                                                folded_turns: folded,
                                                                tokens_before: before,
                                                                tokens_after: after,
                                                                summary: r4.slice(
                                                                    qb + " tokens):\n".length(),
                                                                    r4.length(),
                                                                ),
                                                            }
                                                        },
                                                    }
                                                },
                                            }
                                        },
                                    }
                                },
                            }
                        } else {
                            null
                        }
                    },
                }
            },
        }
    }
}

test "summary schema round-trips through construction" {
    let s = CompactionSummary {
        goal: "fix login",
        constraints: "(none)",
        done: ["repro test"],
        in_progress: ["patch"],
        blocked: [],
        decisions: ["use JWT"],
        next_steps: ["ship"],
        context: "auth.ts:42",
    };
    let b = BranchSummary { branch_id: "branch-7", summary: s, read_files: ["auth.ts"], modified_files: [] };
    assert.equal(b.summary.goal, "fix login");
    assert.equal(b.read_files.length(), 1);
    assert.equal(b.branch_id, "branch-7")
}

test "marker formats, parses, and round-trips" {
    let m = format_compaction_marker(7, 48000, 12000, "did stuff");
    assert.equal(
        m,
        "Session summary (compacted, 7 earlier turns folded in, 48000→12000 tokens):\ndid stuff",
    );
    match (parse_compaction_marker(m)) {
        null => assert.is_true(false),
        let p: CompactionMarker => {
            assert.equal(p.folded_turns, 7);
            assert.equal(p.tokens_before ?? -1, 48000);
            assert.equal(p.tokens_after ?? -1, 12000);
            assert.equal(p.summary, "did stuff")
        },
    };
    // Multiline summaries ride along verbatim.
    match (parse_compaction_marker(format_compaction_marker(1, 100, 90, "a\nb"))) {
        null => assert.is_true(false),
        let p: CompactionMarker => assert.equal(p.summary, "a\nb"),
    }
}

test "marker rejects non-markers and legacy parses tokenless" {
    assert.is_true(parse_compaction_marker("user: hello") is null);
    assert.is_true(
        parse_compaction_marker("Session summary (compacted, x earlier turns folded in):\ny") is null,
    );
    assert.is_true(
        parse_compaction_marker("Session summary (compacted, 7 earlier turns folded in, 48x→12 tokens):\ny") is null,
    );
    assert.is_true(
        parse_compaction_marker("Session summary (compacted, 7 earlier turns folded in, 48000→12000 tokens) y") is null,
    );
    match (parse_compaction_marker("Session summary (compacted, 7 earlier turns folded in):\ndid stuff")) {
        null => assert.is_true(false),
        let p: CompactionMarker => {
            assert.equal(p.folded_turns, 7);
            assert.is_true(p.tokens_before is null);
            assert.is_true(p.tokens_after is null);
            assert.equal(p.summary, "did stuff")
        },
    };
    assert.is_true(parse_uint_digits("") is null);
    assert.is_true(parse_uint_digits("12a") is null);
    assert.equal(parse_uint_digits("007") ?? -1, 7)
}
