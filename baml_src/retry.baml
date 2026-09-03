// bi/baml_src/retry.baml — retry policy for provider calls (bi#16).
// BAML owns the pure policy: WHICH failures retry, how many times, how
// long to wait. The host owns timers, jitter, and the actual re-call.
// Fetch lives inside the VM (anthropic.AnthropicClient etc.), so the host
// retries whole SendTurn/StreamTurn calls — stateless, same args.
//
// Rules:
// - retry_safe == false never retries (the VM's retry_safety() verdict is
//   authoritative — e.g. invalid_request, refused, parse failures).
// - Only rate_limited + network retry: a 429/5xx means "try again later";
//   everything else means "don't send this again".
// - attempt counts retries already spent (0 = first retry after the initial
//   try); budget is max_retries() total retries, then the last failure wins.
// - backoff is exponential from base_backoff_ms(), capped at
//   max_backoff_ms(); the host adds ±25% jitter (BAML has no RNG).

function max_retries() -> int {
    3
}

function base_backoff_ms() -> int {
    500
}

function max_backoff_ms() -> int {
    10000
}

function should_retry(kind: string, retry_safe: bool, attempt: int) -> bool {
    if (!retry_safe) {
        false
    } else if (attempt >= max_retries()) {
        false
    } else {
        kind == "rate_limited" || kind == "network"
    }
}

function backoff_ms(attempt: int) -> int {
    // Guard the doubling itself: multiplying all the way to `attempt`
    // would overflow int64 long before the cap matters (e.g. attempt 100).
    let d = base_backoff_ms();
    let i = 0;
    while (i < attempt && d < max_backoff_ms()) {
        d = d * 2;
        i = i + 1
    }
    if (d > max_backoff_ms()) {
        max_backoff_ms()
    } else {
        d
    }
}
