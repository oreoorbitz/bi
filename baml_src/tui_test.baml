testset "tui" {
    test "tui_state_new" {
        let s = tui_state_new(80, 24);
        assert.equal(s.width, 80);
        assert.equal(s.height, 24);
        assert.is_true(!s.focused);
    }

    test "cursor_marker" {
        let m = cursor_marker();
        assert.is_true(m.length() > 0);
        assert.is_true(m.includes("_pi:c"));
    }

    test "visible_width ignores marker" {
        let m = cursor_marker();
        let line = "hello" + m;
        assert.equal(visible_width(line), 5);
        assert.equal(visible_width("hello"), 5);
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

    test "FocusableTextComponent emits marker when focused" {
        let comp = FocusableTextComponent { text: "hi", focused: true };
        let lines = comp.render(80);
        assert.is_true(lines[0].includes(cursor_marker()));
        let comp2 = FocusableTextComponent { text: "hi", focused: false };
        let lines2 = comp2.render(80);
        assert.is_true(!lines2[0].includes(cursor_marker()));
    }
}
