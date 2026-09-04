test "codebook is fixed and lines shape exactly" {
    assert.equal(action_codes().length(), 8);
    assert.is_true(is_action_code("turn.start"));
    assert.is_true(is_action_code("edit.write"));
    assert.is_true(is_action_code("lease.release") == true);
    assert.is_true(is_action_code("agent.gossip") == false);
    assert.is_true(is_action_code("") == false);
    assert.equal(
        format_action_line("2026-09-04T00:00:00Z", "abc123", "turn.start", "hello"),
        "2026-09-04T00:00:00Z abc123 turn.start hello",
    );
    assert.equal(
        format_action_line("2026-09-04T00:00:00Z", "abc123", "tool.call", ""),
        "2026-09-04T00:00:00Z abc123 tool.call",
    );
}

test "unknown codes shape null, long details cap" {
    assert.is_true(format_action_line("t", "s", "ax", "d") is null);
    let long_detail = "01234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789EXTRA";
    let line = format_action_line("t", "s", "tool.call", long_detail);
    assert.contains(line ?? "", "…");
    assert.is_true((line ?? "").index_of("EXTRA") == null);
}
