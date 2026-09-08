test "dialog title names the provider" {
    // Pi's `Login to ${providerName}` (providerNameOverride or id).
    assert.equal(login_dialog_title("Anthropic"), "Login to Anthropic");
    assert.equal(login_dialog_title("xai"), "Login to xai");
}

test "auth-url block carries url and click hint" {
    assert.equal(
        login_auth_url_block("https://example.com/auth", "Cmd+click"),
        "Complete login in your browser:\nhttps://example.com/auth\nCmd+click to open",
    );
}

test "device block carries uri and code" {
    assert.equal(
        login_device_block("https://example.com/device", "ABCD-1234"),
        "Enter this code at https://example.com/device:\n  ABCD-1234",
    );
}

test "waiting line matches pi phrasing" {
    assert.equal(login_waiting_line(), "Waiting for authentication...");
}

test "row hint deep-links the board number" {
    // 1-based, same numbering as format_oauth_status (bi#102).
    assert.equal(login_row_hint("anthropic", 1), "/oauth 1 — anthropic");
    assert.equal(login_row_hint("xai", 7), "/oauth 7 — xai");
}

test "expired notice names provider and resume path" {
    assert.equal(
        login_expired_notice("anthropic", 1),
        "Stored credential for anthropic expired — refreshing (see /oauth 1 — anthropic)",
    );
}

test "terminal lines close the dialog" {
    assert.equal(
        login_cancelled_line("Anthropic"),
        "Login to Anthropic cancelled — nothing stored, session unchanged.",
    );
    assert.equal(login_success_line("Anthropic"), "Logged in to Anthropic.");
}
