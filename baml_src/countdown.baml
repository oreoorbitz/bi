// bi/baml_src/countdown.baml — countdown text shaping (bi#95).
//
// Pi's CountdownTimer consumers inline their second-formatting in TS
// (`${baseTitle} (${s}s)` in extension-input/extension-selector,
// `in ${seconds}s...` in RetryStatusIndicator). Bi puts that shaping in
// BAML so dialog/retry tick labels are pinned by `baml test`, not by
// eyeballing terminal output. The host (src/countdown.ts) owns the tick
// source — setInterval, expiry, cleanup — and calls these shapers.
//
// Neighbor precedent: tui.baml format_elapsed/format_status own the same
// kind of compact duration text for the live turn status.

function format_countdown(seconds: int) -> string {
    let s = if (seconds < 0) {
        0
    } else {
        seconds
    };
    `${s}s`
}

// Pi's dialog title shape: `Sign in (7s)`. Base is host-owned chrome;
// the parenthesized remainder is policy and lives here.
function countdown_title(base: string, seconds: int) -> string {
    `${base} (${format_countdown(seconds)})`
}

// Pi's retry-indicator shape: `Retrying (1/3) in 7s...`. Attempt counts
// are host-owned progress; the trailing countdown is policy here.
function countdown_retry_message(attempt: int, max_attempts: int, seconds: int) -> string {
    `Retrying (${attempt}/${max_attempts}) in ${format_countdown(seconds)}...`
}
