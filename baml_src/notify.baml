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

// bi#171: user-facing terminal notifications. BAML shapes the text
// (sanitize + join + bound); the host owns the bytes (OSC 9 / BEL /
// tmux DCS) and the enabled / unfocused / TTY gates. Shaping here keeps
// model and session text from reaching the terminal raw.

// Valid `notifications` settings values: off (or unset) emits zero
// bytes; unfocused pages only a backgrounded terminal; always pages
// every completed turn. Called from settings.baml validation.
function is_valid_notifications_mode(mode: string) -> bool {
    mode == "off" || mode == "unfocused" || mode == "always"
}

// One text field with no control bytes: C0/C1 controls and whitespace
// runs become single spaces, ends trimmed. `is_control` is Unicode Cc
// (0x00-0x1F, 0x7F-0x9F) — the same set kimi strips — so BEL/ESC can
// never terminate or forge the OSC 9 payload the host wraps.
function sanitize_notification_text(value: string) -> string {
    //# Map controls/whitespace to spaces
    let parts = value.chars().map((ch) -> {
        if (ch.is_control() || ch.is_whitespace()) {
            " "
        } else {
            ch
        }
    });
    //# Collapse runs, trim ends
    let joined = parts.join("");
    while (joined.includes("  ")) {
        joined = joined.replace_all("  ", " ")
    }
    joined.trim()
}

// "title: body" capped at 240 chars (kimi's
// MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH). Empty sides drop out;
// fully-empty input shapes to "" and the host emits zero bytes.
function format_terminal_notification(title: string, body: string?) -> string {
    let t = sanitize_notification_text(title);
    let b = match (body) {
        null => "",
        let s: string => sanitize_notification_text(s),
    };
    let message = if (t != "" && b != "") {
        `${t}: ${b}`
    } else if (t != "") {
        t
    } else {
        b
    };
    if (message.length() > 240) {
        message.slice(0, 240)
    } else {
        message
    }
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
