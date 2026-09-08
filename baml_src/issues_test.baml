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

// --- Progressive-disclosure index tests (hub#206) -------------------------
//
// Red-check record (bi#57): the load-bearing hunk is the `> 60` guard in
// truncate_index_description. Reverting it to always-truncate makes
// "index truncation follows the hermes 60-char rule" fail with
// `assert.equal(truncate_index_description(sixty), sixty)` —
// observed: expected the 60-char string unchanged, got 57 + "...". The
// empty-guard hunk (`entries.length() == 0` → "") reverted to always-render
// makes "empty indexes render empty" fail on the assert.equal("", ...) —
// observed: got the 2-line header instead of "".

test "index truncation follows the hermes 60-char rule" {
    // hermes skill_utils.py:716,728 — SKILL_PROMPT_DESC_LIMIT = 60:
    // desc[:57] + "..." only when longer than 60, else untouched.
    assert.equal(truncate_index_description("short"), "short");
    let sixty = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.equal(sixty.length(), 60);
    assert.equal(truncate_index_description(sixty), sixty);
    let sixtyone = `${sixty}b`;
    let cut = truncate_index_description(sixtyone);
    assert.equal(cut.length(), 60);
    assert.equal(cut.slice(57, 60), "...");
    assert.equal(cut.slice(0, 57), sixtyone.slice(0, 57));
}

test "skill index renders sorted with a byte-stable shape" {
    let entries = [
        SkillIndexEntry { name: "zzz-skill", description: "Last by name" },
        SkillIndexEntry { name: "aaa-skill", description: "First by name" },
    ];
    let idx = format_skill_index(entries);
    // Sorted by name: host enumeration order never reaches the prompt.
    let a = idx.index_of("aaa-skill") ?? -1;
    let z = idx.index_of("zzz-skill") ?? -1;
    assert.is_true(a >= 0 && a < z);
    assert.contains(idx, "- aaa-skill: First by name");
    assert.contains(idx, "- zzz-skill: Last by name");
    // Pure function of the entry list: same data → same bytes, always.
    assert.equal(format_skill_index(entries), idx);
    // The block shape is constant: a different entry set keeps the header.
    let other = format_skill_index([SkillIndexEntry { name: "one", description: "d" }]);
    assert.equal(other.slice(0, 15), idx.slice(0, 15));
    assert.contains(other, "Load a skill's full body with the skill_view tool");
}

test "skill index cost is bounded per entry" {
    // Prompt-size accounting (hub#206 acceptance): each index line costs at
    // most 2 + name.length + 2 + 60 chars ("- " + name + ": " + description
    // ≤60), so the block is linear in entry count and the only unbounded
    // input (the description) is capped. Names are identity — never
    // truncated; bi-validated skills cap them at 64 chars anyway.
    let long_name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let long_desc = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let entries = [
        SkillIndexEntry { name: long_name, description: long_desc },
        SkillIndexEntry { name: "s", description: "d" },
    ];
    let idx = format_skill_index(entries);
    let lines = idx.split("\n");
    assert.equal(lines.length(), 2 + entries.length());
    for (let i = 0; i < entries.length(); i += 1) {
        let line = lines.at(2 + i) ?? "";
        let name_len = match (entries.at(i)) {
            null => 0,
            let e: SkillIndexEntry => e.name.length(),
        };
        assert.is_true(line.length() <= 2 + name_len + 2 + 60);
    }
    // The long description was actually truncated, not just asserted away.
    assert.contains(idx, "...");
    assert.is_true(idx.index_of(long_desc) == null);
}

test "issue index renders sorted, truncated, bounded" {
    let entries = [
        IssueIndexEntry {
            id: "bi#80",
            status: "Open",
            kind: "Bug",
            title: "tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt",
        },
        IssueIndexEntry {
            id: "bi#79",
            status: "Doing",
            kind: "Feat",
            title: "Staged issue context",
        },
    ];
    let idx = format_issue_index(entries);
    assert.is_true((idx.index_of("bi#79") ?? 9999) < (idx.index_of("bi#80") ?? -1));
    assert.contains(idx, "- bi#79 [Doing/Feat] Staged issue context");
    // Same data → same bytes; header shape independent of entries.
    assert.equal(format_issue_index(entries), idx);
    let other = format_issue_index([IssueIndexEntry { id: "hub#1", status: "Open", kind: "Feat", title: "x" }]);
    assert.equal(other.slice(0, 13), idx.slice(0, 13));
    // Per-entry cost bound: "- " + id + " [" + status + "/" + kind + "] " +
    // title ≤60 — only the title is unbounded input, and it is capped, so
    // block cost stays linear in entry count.
    let lines = idx.split("\n");
    assert.equal(lines.length(), 2 + entries.length());
    for (let i = 0; i < entries.length(); i += 1) {
        let line = lines.at(2 + i) ?? "";
        let meta = match (entries.at(i)) {
            null => 0,
            let e: IssueIndexEntry => e.id.length() + e.status.length() + e.kind.length(),
        };
        assert.is_true(line.length() <= 2 + meta + 5 + 60);
    }
    assert.contains(idx, "...");
}

test "empty indexes render empty" {
    // An empty registry omits the block entirely — no dangling header.
    assert.equal(format_skill_index([]), "");
    assert.equal(format_issue_index([]), "");
}
