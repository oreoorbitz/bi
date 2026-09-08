test "countdown formats whole seconds with s suffix" {
    assert.equal(format_countdown(7), "7s");
    assert.equal(format_countdown(1), "1s");
    assert.equal(format_countdown(0), "0s");
}

test "countdown clamps negative input to zero" {
    // The host decrements to <= 0 before expiring; onTick(0) is the last
    // legitimate tick, but a stray negative must never render as "-1s".
    assert.equal(format_countdown(-1), "0s");
    assert.equal(format_countdown(-99), "0s");
}

test "dialog title wraps the base with the countdown" {
    // Pi's login/device-code title shape: `Sign in (7s)`.
    assert.equal(countdown_title("Sign in", 7), "Sign in (7s)");
    assert.equal(countdown_title("Sign in", 0), "Sign in (0s)");
    assert.equal(countdown_title("Sign in", -2), "Sign in (0s)");
}

test "retry message carries attempt progress and countdown" {
    // Pi's RetryStatusIndicator shape: `Retrying (1/3) in 7s...`.
    assert.equal(countdown_retry_message(1, 3, 7), "Retrying (1/3) in 7s...");
    assert.equal(countdown_retry_message(3, 3, 0), "Retrying (3/3) in 0s...");
}
