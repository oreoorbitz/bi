// bi/baml_src/meta_tools.baml — hub#207: meta-tools mined from bi session
// transcripts (arXiv:2601.22037, Meta-tools).
//
// Detect recurring tool-call sequences across session trajectories and
// compile each into a deterministic meta-tool proposal — the intermediate
// LLM steps collapse into one typed, plain-data sequence, cutting cost and
// failure surface. Trajectory source: session.baml SessionHeader (the host
// flattens each JSONL transcript into a SessionTrace; parent_session rides
// along as lineage provenance).
//
// Gating (hub#200 flip_gate, AgentDevel arXiv:2601.04620): mining alone
// NEVER materializes. A proposal carries null evidence until its claimed
// failure issues' drill arms have been flip-gated; the host calls
// gate_meta_tool_materialization and only an Accept verdict with named
// flipped-green arms yields a MetaToolSpec. Evidence mirrors bits'
// FlipVerdict by convention (cross-package bits refs are a 0.18-ism —
// bi/AGENTS.md), traveling as plain data.
//
// Staging (hub#203 convention): like review proposals, nothing here
// auto-installs — materialized specs are staged by the host for approval.
// The natural staging hook is review-turn.ts (out of this issue's
// footprint); see NOTES.
//
// Plain-data FFI idiom (turn.baml limitations 2/4): every type below is
// field-only classes and literal-string unions — no enums, no interfaces,
// no handles. The verdict union crosses the bridge as a returned value.
//
// bi#57 red-check record (materialization gate):
//   hunk: gate_meta_tool_materialization's `null => MaterializeRefuse { … }`
//         arm — neutered to materialize a spec with no evidence present.
//   expected reason: a proposal that never ran the hub#200 flip-gate on
//     its claimed drill arms must never become a tool — evidence presence
//     is ground truth, not the proposal's self-description.
//   observed: with the arm reverted (null materializes),
//     `node bi/scripts/meta-tools.mjs` FAILs as
//     "materialization gate holds: proposal without flip_gate evidence
//     refuses (gate bypassed — no-evidence proposal materialized)";
//     restored, the drill prints all ok, 0 failures.

// One session's tool-call trajectory, host-flattened from the JSONL
// transcript (HistoryEntry/toolUse blocks). parent_session is the
// SessionHeader lineage link (forks share a prefix with their parent).
class SessionTrace {
    session_id: string,
    parent_session: string?,
    tool_calls: string[], // tool names in invocation order
}

// Plain-data mirror of bits flip_gate's FlipVerdict (hub#200). verdict is
// a literal union so rejections cross the bridge named, never as bare
// bools (bi#55).
class FlipGateEvidence {
    verdict: "Accept" | "Reject" | "NoOp",
    drill_arm_ids: string[], // arms of the failure issues this meta-tool claims to fix
    flipped_green: string[], // arms that flipped fail -> pass on the gate run
    gate_run_id: string, // how/where the gate ran, e.g. "node bits/scripts/flip-gate.mjs prop#02 2026-09-08"
}

class MetaToolProposal {
    name: string, // derived: "meta_" + sequence joined by "_"
    sequence: string[], // the recurring tool-call sequence
    trigger: string, // when the meta-tool applies (plain-text condition)
    support: int, // distinct sessions the sequence recurred in
    session_ids: string[], // provenance
    evidence: FlipGateEvidence?, // null until the claimed drill arms are flip-gated
}

// The materialized meta-tool — same plain-data shape family as ToolSpec.
class MetaToolSpec {
    name: string,
    description: string,
    sequence: string[],
}

class MaterializeRefuse {
    reason: string @description("machine-readable slug naming the refusal (bi#55)"),
}

type MaterializationVerdict = MetaToolSpec | MaterializeRefuse;

function seq_equal(a: string[], b: string[]) -> bool {
    if (a.length() != b.length()) {
        false
    } else {
        let eq = true;
        let i = 0;
        while (i < a.length() && eq) {
            if (a.at(i) != b.at(i)) {
                eq = false;
            }
            i = i + 1;
        }
        eq
    }
}

function seq_list_contains(hay: string[][], needle: string[]) -> bool {
    hay.some((s) -> {
        seq_equal(s, needle)
    })
}

// Contiguous subsequence test — the recurrence unit is an uninterrupted
// run of tool calls, not a scattered set.
function contains_subsequence(hay: string[], needle: string[]) -> bool {
    if (needle.length() > hay.length()) {
        false
    } else {
        let found = false;
        let i = 0;
        while (i + needle.length() <= hay.length() && !found) {
            if (seq_equal(hay.slice(i, i + needle.length()), needle)) {
                found = true;
            }
            i = i + 1;
        }
        found
    }
}

// Mining (the issue's MineMetaTools): enumerate contiguous tool-call
// n-grams (length >= 2), keep those recurring in at least min_support
// DISTINCT sessions, keep only maximal patterns (a recurring n-gram
// contained in a longer recurring one is folded into it), and emit ONE
// proposal per distinct sequence — never one per occurrence.
function mine_meta_tools(sessions: SessionTrace[], min_support: int = 2) -> MetaToolProposal[] {
    let candidates: string[][] = [];
    for (let s in sessions) {
        let n = s.tool_calls.length();
        let start = 0;
        while (start + 2 <= n) {
            let len = 2;
            while (start + len <= n) {
                let cand = s.tool_calls.slice(start, start + len);
                if (!seq_list_contains(candidates, cand)) {
                    candidates.push(cand);
                }
                len = len + 1;
            }
            start = start + 1;
        }
    }
    let recurring: string[][] = [];
    let supports: int[] = [];
    let provenance: string[][] = [];
    for (let cand in candidates) {
        let support = 0;
        let ids: string[] = [];
        for (let s in sessions) {
            if (contains_subsequence(s.tool_calls, cand)) {
                support = support + 1;
                ids.push(s.session_id);
            }
        }
        if (support >= min_support) {
            recurring.push(cand);
            supports.push(support);
            provenance.push(ids);
        }
    }
    let proposals: MetaToolProposal[] = [];
    let i = 0;
    while (i < recurring.length()) {
        let cand = recurring.at(i) ?? [];
        // Maximal-pattern fold: drop this candidate if a strictly longer
        // recurring sequence contains it (it will be proposed as part of
        // the longer one).
        let folded = recurring.some((other) -> {
            other.length() > cand.length() && contains_subsequence(other, cand)
        });
        if (!folded) {
            proposals.push(
                MetaToolProposal {
                    name: "meta_" + cand.join("_"),
                    sequence: cand,
                    trigger: `when the tool sequence "${cand.join(" -> ")}" would run as separate LLM-driven calls`,
                    support: supports.at(i) ?? 0,
                    session_ids: provenance.at(i) ?? [],
                    evidence: null,
                },
            );
        }
        i = i + 1;
    }
    proposals
}

// The materialization gate. Mining proposes; only a hub#200 flip-gate
// Accept on the claimed drill arms disposes. Every refusal is named
// (bi#55) — never a bare false.
function gate_meta_tool_materialization(p: MetaToolProposal) -> MaterializationVerdict {
    match (p.evidence) {
        null => {
            MaterializeRefuse {
                reason: `no_flip_gate_evidence:${p.name} — run flip_gate on the claimed drill arms first (hub#200)`,
            }
        },
        let ev: FlipGateEvidence => {
            if (ev.verdict != "Accept") {
                MaterializeRefuse { reason: `flip_gate_not_accept:${p.name}:${ev.verdict}` }
            } else if (ev.flipped_green.length() == 0) {
                MaterializeRefuse {
                    reason: `flip_gate_empty_flip:${p.name} — Accept with zero flipped-green arms is a NoOp`,
                }
            } else if (ev.drill_arm_ids.length() == 0) {
                MaterializeRefuse {
                    reason: `no_drill_arms:${p.name} — the proposal claims to fix nothing`,
                }
            } else {
                MetaToolSpec {
                    name: p.name,
                    description: `Meta-tool mined from ${p.support} session(s): runs "${p.sequence.join(" -> ")}" as one deterministic step (arXiv:2601.22037). flip-gate: ${ev.gate_run_id}.`,
                    sequence: p.sequence,
                }
            }
        },
    }
}
