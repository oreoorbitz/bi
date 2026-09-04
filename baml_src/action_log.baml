// bi/baml_src/action_log.baml — host-recorded action log (bi#75).
//
// Agents cannot attest themselves (bi#37), so the host loop — which
// already observes every action — appends one line per event to a
// shared append-only log: `<ts> <session> <code> <detail>`. Reads are
// `rg` over one file with one total order for free.
//
// BAML owns the codebook (the fixed vocabulary) and the line shape;
// the host owns the file append. Unknown codes shape to null and the
// host drops them (counted, never thrown) — a misspelled emitter must
// not break a turn, and a forged line can never enter through the API
// because only codebook members shape.

// Fixed vocabulary. Codes stay readable words (tool.call, not ax) —
// we pay per misread, not per bit.
function action_codes() -> string[] {
    [
        "turn.start",
        "turn.end",
        "tool.call",
        "edit.write",
        "bais.new",
        "bais.move",
        "lease.claim",
        "lease.release",
    ]
}

function is_action_code(code: string) -> bool {
    let found = false;
    for (let c in action_codes()) {
        if (c == code) {
            found = true
        }
    }
    found
}

// One log line. Null for unknown codes (host drops + counts).
// Detail is free text capped at 200 chars so one chatty arg blob
// cannot bloat the shared file.
function format_action_line(ts: string, session: string, code: string, detail: string) -> string? {
    if (is_action_code(code) == false) {
        null
    } else {
        let cut = if (detail.length() > 200) {
            `${detail.slice(0, 200)}…`
        } else {
            detail
        };
        `${ts} ${session} ${code} ${cut}`.trim()
    }
}
