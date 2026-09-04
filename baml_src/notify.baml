// bi/baml_src/notify.baml — notification policy (bi#63).
//
// Shaping prompt-facing text is BAML's job: this decision table maps a
// validated hub event onto one prompt-context line (or null when the
// event is never prompt-worthy). The host owns transport, SSE parsing,
// the watch filter, and queue timing — it extracts plain string fields
// from the JSON body and calls the shaper, so no template literal with
// policy meaning remains in TS. New notification kinds land here as new
// arms first (ties to bi#54 exhaustiveness).

// First non-empty string wins; "?" when every slot is empty (mirrors
// the host's old `?? "?"` fallback so probe fixtures stay byte-identical).
function first_present(items: string?[]) -> string {
    let out = "?";
    let found = false;
    for (let it in items) {
        match (it) {
            null => {},
            let s: string => {
                if (found == false && s != "") {
                    out = s;
                    found = true
                }
            },
        }
    }
    out
}

// One prompt-context line per validated event, null for Heartbeat
// liveness. Expiry fires on the LeaseExpiring type OR on expiry keys in
// the body (the hub sets either); the host precomputes has_expiry and
// the display string so BAML never touches JSON.
function shape_notification(
    event_type: string,
    entity: string?,
    lease_ref: string?,
    task_ref: string?,
    flag_ref: string?,
    subject_ref: string?,
    has_expiry: bool,
    expires_text: string?,
    reason: string?,
) -> string? {
    if (event_type == "Heartbeat") {
        null
    } else if (event_type == "LeaseRelease") {
        `peer released ${first_present([entity, lease_ref, task_ref])}`
    } else if (event_type == "LeaseExpiring" || has_expiry) {
        let n = match (expires_text) {
            null => "undefined",
            let s: string => s,
        };
        `lease on ${first_present([entity, lease_ref, task_ref])} expires in ${n}`
    } else if (event_type == "OversightFlag" || event_type == "Oversight" || event_type == "ConflictFlag") {
        let target = first_present([entity, flag_ref, subject_ref, task_ref]);
        match (reason) {
            null => `oversight flagged ${target}`,
            let r: string => `oversight flagged ${target} (${r})`,
        }
    } else {
        match (entity) {
            null => `hub ${event_type}`,
            let e: string => `hub ${event_type} on ${e}`,
        }
    }
}
