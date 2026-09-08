// bi/baml_src/selectors_test.baml — footer row split (bi#184) + tips
// policy (bi#186) pins. Inline selector tests stay in selectors.baml;
// these pin the cross-row contract and the tips data.
//
// Red-check (bi#57): restoring the pre-bi#184 model_line_text body
// (`${provider}/${model} · thinking ${thinking}${ctx}`) fails
// `footer rows never repeat a fact` on the "thinking" absence assert;
// restoring the dedup goes green. Verified 2026-09-07: reverted →
// `is_true assertion failed`, restored → 393 passed.

testset "footer row split (bi#184)" {
    test "row 1 keeps backend, thinking, counters, location" {
        assert.equal(
            footer_text("xai", "grok-4.6", "high", 2, 5, cwd = "~/bi", branch = "main"),
            "xai/grok-4.6 · thinking high · 2 turns · 5 messages · ~/bi · main",
        )
    }

    test "row 2 carries ctx only" {
        assert.equal(model_line_text("anthropic", "claude-haiku-4-5", "medium", 200), "ctx 200k");
        // Stale id: empty row (row 1 already names the backend), never bricks.
        assert.equal(model_line_text("anthropic", "nope-xyz", "medium", 200), "")
    }

    test "footer rows never repeat a fact" {
        let row1 = footer_text("xai", "grok-4.6", "high", 2, 5);
        let row2 = model_line_text("xai", "grok-4.6", "high", 200);
        // Backend + thinking live on row 1 ...
        assert.contains(row1, "xai/grok-4.6");
        assert.contains(row1, "thinking high");
        // ... and nowhere on row 2.
        assert.is_true(row2.index_of("xai") is null);
        assert.is_true(row2.index_of("grok-4.6") is null);
        assert.is_true(row2.index_of("thinking") is null)
    }
}

testset "footer tips (bi#186)" {
    test "corpus is non-empty and teaches bi's surface" {
        let tips = footer_tips();
        assert.is_true(tips.length() >= 4);
        for (let t in tips) {
            assert.is_true(t.length() > 0)
        }
        assert.is_true(tips.includes("shift+enter: newline"));
        assert.is_true(tips.includes("/bais new to file an issue"))
    }

    test "rotation cadence is kimi's 10s, as data" {
        assert.equal(tip_rotate_interval_ms(), 10000)
    }

    test "rotation index wraps over the corpus" {
        let n = footer_tips().length();
        assert.equal(tip_index(0), 0);
        assert.equal(tip_index(n - 1), n - 1);
        assert.equal(tip_index(n), 0);
        assert.equal(tip_index(n + 1), 1);
        assert.equal(tip_index(2 * n + 3), 3);
        assert.equal(tip_index(-1), n - 1)
    }

    test "wide slot pairs two tips, narrow falls back to one" {
        let tips = footer_tips();
        let first = tips.at(0) ?? "";
        let pair = `${first} | ${tips.at(1) ?? ""}`;
        assert.equal(tips_slot_text(0, 200), pair);
        // Exactly the first tip's width: single tip, no pair.
        assert.equal(tips_slot_text(0, first.length()), first);
        // Gone slot: empty, never negative-width garbage.
        assert.equal(tips_slot_text(0, 0), "");
        // The last tick pairs the last tip with the first (wrap).
        let n = tips.length();
        let last_pair = `${tips.at(n - 1) ?? ""} | ${first}`;
        assert.equal(tips_slot_text(n - 1, 200), last_pair)
    }
}
