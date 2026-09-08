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

    test "status_event_tail word boundaries" {
        // Fits: verbatim, no ellipsis.
        assert.equal(status_event_tail("short text", 60), "short text");
        // Windowed mid-word: drops the partial word, single leading ….
        assert.equal(
            status_event_tail("my honest read: **bi#190** is trivial", 22),
            "…bi#190** is trivial",
        );
        assert.equal(
            status_event_tail("my honest read: **bi#190** is trivial", 20),
            "…is trivial",
        );
        // Orphaned emphasis at the cut is stripped.
        assert.equal(status_event_tail("alpha x **beta gamma", 13), "…beta gamma");
        // Overlong single token: hard cut with ellipsis.
        assert.equal(status_event_tail("abcdefghijklmnop", 8), "…ijklmnop");
        // Newlines flatten so the event stays on the status row.
        assert.equal(status_event_tail("line one\nline two", 60), "line one line two");
        // Degenerate window.
        assert.equal(status_event_tail("anything", 0), "");
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

    test "prompt label, glyph, and editor border shapes (bi#181)" {
        assert.equal(format_prompt_label(0), "bi[0]>");
        assert.equal(format_prompt_label(12), "bi[12]>");
        assert.equal(prompt_glyph(), ">");
        assert.equal(editor_side_border(), "│");
        // Label splices one space after the left corner; dashes fill.
        assert.equal(
            render_editor_top_border("bi[0]>", 20),
            "╭ bi[0]> ──────────╮",
        );
        assert.equal(render_editor_top_border("bi[0]>", 20).length(), 20);
        // Narrow fallback drops the label, never the corners.
        assert.equal(render_editor_top_border("bi[0]>", 10), "╭────────╮");
        assert.equal(render_editor_top_border("bi[0]>", 1), "╭");
        assert.equal(render_editor_bottom_border(10), "╰────────╯");
        assert.equal(render_editor_bottom_border(1), "╰");
    }

    test "welcome frame box, label column, narrow fallback (bi#180)" {
        let info = WelcomeInfo {
            directory: "/tmp/dir",
            session: "a1b2c3d4",
            model: "claude-haiku-4-5",
            version: "0.0.0",
        };
        let frame = render_welcome_frame(info, 60);
        assert.equal(frame.length(), 11);
        assert.is_true((frame.at(0) ?? "").starts_with("╭"));
        assert.is_true((frame.at(10) ?? "").starts_with("╰"));
        assert.is_true((frame.at(2) ?? "").includes("▐█▛█▛█▌"));
        assert.is_true((frame.at(2) ?? "").includes("Welcome to bi!"));
        assert.is_true((frame.at(3) ?? "").includes("/help"));
        // Label column: every value starts at the same cell (14).
        assert.equal((frame.at(5) ?? "").slice(14, 21), "/tmp/di");
        assert.equal((frame.at(6) ?? "").slice(14, 22), "a1b2c3d4");
        assert.equal((frame.at(7) ?? "").slice(14, 29), "claude-haiku-4-");
        assert.equal((frame.at(8) ?? "").slice(14, 19), "0.0.0");
        // Narrow (< 24) drops the box entirely (kimi precedent).
        let narrow = render_welcome_frame(info, 20);
        assert.equal(narrow.length(), 3);
        assert.is_true(!(narrow.at(0) ?? "").includes("╭"));
        assert.is_true((narrow.at(2) ?? "").starts_with("Model: "));
        // Themed render keeps the text, adds SGR bytes only.
        let themed = render_welcome_frame(info, 60, theme = "default");
        assert.is_true((themed.at(2) ?? "").includes("Welcome to bi!"));
        assert.is_true((themed.at(0) ?? "").length() > 60);
    }
}
