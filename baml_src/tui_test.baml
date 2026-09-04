testset "tui" {
    test "tui_state_new" {
        let s = tui_state_new(80, 24);
        assert.equal(s.width, 80);
        assert.equal(s.height, 24);
        assert.is_true(!s.focused);
    }

    test "cursor_marker" {
        let m = cursor_marker();
        assert.is_true(m.includes("_pi:c"));
        // ESC(1) + "_pi:c"(5) + BEL(1) = 7. Literal backslash text
        // would measure 12 (bi#76 regression).
        assert.equal(m.length(), 7);
    }

    test "visible_width ignores marker" {
        let m = cursor_marker();
        let line = "hello" + m;
        assert.equal(visible_width(line), 5);
        assert.equal(visible_width("hello"), 5);
    }

    test "ready frame caps width and keeps rows" {
        let rows = [
            ReadyRow { id: "bi#01", title: "Short" },
            ReadyRow {
                id: "bi#02",
                title: "A much longer title that will not fit in twelve columns",
            },
        ];
        let frame = render_ready_frame(rows, 12);
        assert.equal(frame.length(), 3);
        assert.is_true((frame.at(0) ?? "").length() <= 13);
        assert.equal(frame.at(1) ?? "", "bi#01  Short");
        assert.is_true((frame.at(2) ?? "").starts_with("bi#02"));
        let wide = render_ready_frame(rows, 80);
        assert.equal(wide.at(0) ?? "", "bi — ready BAIS");
        assert.equal(render_ready_frame([], 80).length(), 1)
    }

    test "diff_lines" {
        let a = diff_lines(["a", "b", "c"], ["a", "x", "c"]);
        assert.equal(a, ["1"]);
        let b = diff_lines(["a"], ["a", "b"]);
        assert.equal(b, ["1"]);
        let c = diff_lines(["a"], ["a"]);
        assert.equal(c.length(), 0);
    }

    test "TextComponent render narrow" {
        let comp = TextComponent { text: "hello world" };
        let lines = comp.render(5);
        assert.equal(lines, ["hello", " worl", "d"]);
    }

    test "TextComponent render wide" {
        let comp = TextComponent { text: "hi" };
        let lines = comp.render(80);
        assert.equal(lines, ["hi"]);
    }

    test "format_elapsed shapes" {
        assert.equal(format_elapsed(0), "0ms");
        assert.equal(format_elapsed(999), "999ms");
        assert.equal(format_elapsed(1000), "1.0s");
        assert.equal(format_elapsed(4200), "4.2s");
        assert.equal(format_elapsed(59999), "59.9s");
        assert.equal(format_elapsed(60000), "1m00s");
        assert.equal(format_elapsed(184000), "3m04s");
    }

    test "format_status line shape" {
        assert.equal(
            format_status("⠋", "thinking", 4200, "loop:Thinking"),
            "⠋ thinking · 4.2s · loop:Thinking",
        );
        assert.equal(format_status("⠋", "thinking", 300, ""), "⠋ thinking · 300ms · …");
    }

    test "format_turn_summary shapes" {
        assert.equal(
            format_turn_summary(false, "", 3, 6, 6100),
            "✓ done · 3 turns · 6 messages · 6.1s",
        );
        assert.equal(
            format_turn_summary(false, "", 1, 1, 500),
            "✓ done · 1 turn · 1 message · 500ms",
        );
        assert.equal(
            format_turn_summary(true, "TurnFailure api", 2, 3, 60000),
            "✗ TurnFailure api · 2 turns · 3 messages · 1m00s",
        );
    }

    test "turn summary and error take theme roles, divider spans width" {
        // Unstyled default keeps the exact legacy shapes (above).
        let plain = format_turn_summary(false, "", 1, 1, 500);
        let good = format_turn_summary(false, "", 1, 1, 500, theme = "default");
        assert.contains(good, "✓ done");
        // One SGR open (5 bytes) + one reset (4 bytes), no other change.
        assert.equal(good.length(), plain.length() + 9);
        let bad = format_turn_summary(true, "TurnFailure api", 1, 1, 500, theme = "default");
        assert.contains(bad, "✗ TurnFailure api");
        assert.equal(
            bad.length(),
            format_turn_summary(true, "TurnFailure api", 1, 1, 500).length() + 9,
        );
        assert.contains(
            format_turn_error("TurnFailure boom", theme = "default"),
            "TurnFailure boom",
        );
        assert.equal(format_turn_error("TurnFailure boom"), "TurnFailure boom");
        assert.equal(render_divider(4, theme = "none"), "────");
        assert.equal(render_divider(0, theme = "none"), "");
        assert.equal(render_divider(-3), "");
        // Dim role adds its 8-byte SGR envelope (4 open + 4 reset)
        // around the rule, however BAML counts the ─ width.
        assert.equal(
            render_divider(4, theme = "default").length(),
            render_divider(4, theme = "none").length() + 8,
        );
    }

    test "select frame highlights cursor row, keeps numbers" {
        let rows = ["1  grok-4.6", "2  claude-haiku-4-5", "3  muse-spark"];
        let frame = render_select_frame(rows, 1, 80);
        assert.equal(frame.length(), 3);
        assert.equal(frame.at(0) ?? "", "  1  grok-4.6");
        assert.equal(frame.at(1) ?? "", "> 2  claude-haiku-4-5");
        assert.equal(frame.at(2) ?? "", "  3  muse-spark");
        // Cursor is display-only: row text (and its number) is unchanged.
        assert.contains(frame.at(1) ?? "", "2  claude-haiku-4-5");
    }

    test "select frame clamps cursor and caps width" {
        let rows = ["1  abcdef", "2  gh"];
        let hi = render_select_frame(rows, 99, 80);
        assert.equal(hi.at(1) ?? "", "> 2  gh");
        assert.equal(hi.at(0) ?? "", "  1  abcdef");
        let lo = render_select_frame(rows, -5, 80);
        assert.equal(lo.at(0) ?? "", "> 1  abcdef");
        let narrow = render_select_frame(rows, 0, 5);
        assert.equal(narrow.at(0) ?? "", "> 1  …");
        assert.equal(narrow.at(1) ?? "", "  2  …");
        assert.equal(render_select_frame([], 0, 80).length(), 0);
    }

    test "FocusableTextComponent emits marker when focused" {
        let comp = FocusableTextComponent { text: "hi", focused: true };
        let lines = comp.render(80);
        assert.is_true(lines[0].includes(cursor_marker()));
        let comp2 = FocusableTextComponent { text: "hi", focused: false };
        let lines2 = comp2.render(80);
        assert.is_true(!lines2[0].includes(cursor_marker()));
    }
}
