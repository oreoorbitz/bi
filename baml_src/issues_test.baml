test "issue rows shape the pick list" {
    assert.equal(
        format_issue_row(3, "bi#79", "Open", "Feat", "Staged issue context for the agent loop", []),
        "3  bi#79 [Open/Feat] Staged issue context for the agent loop",
    );
    assert.equal(
        format_issue_row(1, "bi#80", "Open", "Bug", "x", ["bi#79"]),
        "1  bi#80 [Open/Bug] x (blocked by bi#79)",
    );
    // Long titles cap at 60 chars so the select frame stays aligned.
    let long = format_issue_row(
        2,
        "bi#81",
        "Open",
        "Feat",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [],
    );
    assert.is_true(long.length() < 2 + 2 + 5 + 12 + 1 + 60 + 5);
    assert.contains(long, "bi#81");
}

test "issue context carries body, edges, neighbors" {
    let ctx = format_issue_context(
        "bi#79",
        "Staged issue context",
        "Open",
        "Feat",
        null,
        "Build it.",
        4000,
        ["bi#79"],
        ["bi#80"],
        ["Blocks"],
        ["bi#80"],
        ["Follow-up"],
        ["Open"],
    );
    assert.contains(ctx, "## bi#79 [Open/Feat]: Staged issue context");
    assert.contains(ctx, "Build it.");
    assert.contains(ctx, "- bi#79 Blocks bi#80");
    assert.contains(ctx, "- bi#80 [Open] Follow-up");
}

test "issue context caps long bodies and marks area" {
    let ctx = format_issue_context("bi#79", "T", "Doing", "Feat", "tui", "abcdefghij", 4, [], [], [], [], [], []);
    assert.contains(ctx, "[Doing/Feat] (tui): T");
    assert.contains(ctx, "abcd");
    assert.contains(ctx, "[… body capped at 4 chars]");
    assert.is_true(ctx.index_of("efghij") == null);
}
