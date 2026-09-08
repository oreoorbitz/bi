test "release names the entity, falls back through refs" {
    assert.equal(
        shape_notification("LeaseRelease", "bi#44", null, null, null, null, false, null, null),
        "peer released bi#44",
    );
    assert.equal(
        shape_notification("LeaseRelease", null, "hub:claim:3", null, null, null, false, null, null),
        "peer released hub:claim:3",
    );
    assert.equal(
        shape_notification("LeaseRelease", null, null, null, null, null, false, null, null),
        "peer released ?",
    );
}

test "heartbeat never shapes, expiry fires on type or body keys" {
    assert.is_true(
        shape_notification("Heartbeat", null, null, null, null, null, false, null, null) is null,
    );
    assert.equal(
        shape_notification("LeaseExpiring", "bi#45", null, null, null, null, false, "7", null),
        "lease on bi#45 expires in 7",
    );
    // Body-carried expiry with a non-expiry type still shapes.
    assert.equal(
        shape_notification("Renewed", null, "bi#45", null, null, null, true, "12", null),
        "lease on bi#45 expires in 12",
    );
}

test "notification modes accept off unfocused always" {
    assert.is_true(is_valid_notifications_mode("off"));
    assert.is_true(is_valid_notifications_mode("unfocused"));
    assert.is_true(is_valid_notifications_mode("always"));
    assert.is_true(!is_valid_notifications_mode("loud"));
    assert.is_true(!is_valid_notifications_mode(""))
}

test "terminal notification shapes title and body" {
    assert.equal(format_terminal_notification("bi turn complete", null), "bi turn complete");
    assert.equal(format_terminal_notification("bi turn complete", "sess"), "bi turn complete: sess");
    assert.equal(format_terminal_notification("", "sess"), "sess");
    assert.equal(format_terminal_notification("", null), "");
    assert.equal(format_terminal_notification("  spaced  ", "  out  "), "spaced: out")
}

test "terminal notification strips control bytes" {
    // BAML escapes stay literal (proposal 13) — build controls by code point.
    let bel = baml.String.from_code_points([7]);
    let esc = baml.String.from_code_points([27]);
    let nl = baml.String.from_code_points([10]);
    assert.equal(sanitize_notification_text(`a${bel}b${esc}c`), "a b c");
    assert.equal(format_terminal_notification(`t${bel}`, `b${nl}c`), "t: b c");
    // C1 DEL..APC go too; printable unicode survives.
    let del = baml.String.from_code_points([127]);
    let apc = baml.String.from_code_points([159]);
    assert.equal(sanitize_notification_text(`x${del}y${apc}z ✓`), "x y z ✓")
}

test "terminal notification caps at 240 chars" {
    let long = "x".repeat(300);
    assert.equal(format_terminal_notification(long, null).length(), 240);
    assert.equal(format_terminal_notification("t", long).length(), 240)
}

test "oversight carries the reason, unknown types fall back" {
    assert.equal(
        shape_notification("OversightFlag", "bi#46", null, null, null, null, false, null, "conflict"),
        "oversight flagged bi#46 (conflict)",
    );
    assert.equal(
        shape_notification("Oversight", null, null, null, null, "bi#46", false, null, null),
        "oversight flagged bi#46",
    );
    assert.equal(
        shape_notification("SomethingNew", "bi#47", null, null, null, null, false, null, null),
        "hub SomethingNew on bi#47",
    );
    assert.equal(
        shape_notification("SomethingNew", null, null, null, null, null, false, null, null),
        "hub SomethingNew",
    );
}
