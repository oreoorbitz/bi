testset "keybindings file format" {
    test "table covers the TUI surface" {
        assert.equal(keybinding_definitions().length(), 48);
        assert.is_true(keybinding_known("tui.select.up"));
        assert.is_true(keybinding_known("tui.select.confirm"));
        assert.is_true(keybinding_known("tui.select.cancel"));
        assert.is_true(keybinding_known("tui.input.submit"));
        assert.is_true(keybinding_known("tui.editor.undo"));
        assert.is_true(!keybinding_known("cycle"));
        assert.is_true(!keybinding_known("app.interrupt"))
    }

    test "bi-owned ids validate" {
        assert.is_true(keybinding_known("bi.model.cycleForward"));
        let v = validate_keybinding_entries([KeybindingEntry { id: "bi.model.cycleForward", keys: ["ctrl+n"] }]);
        assert.equal(v.errors.length(), 0);
        assert.equal(v.valid.length(), 1);
        assert.equal(v.valid.at(0)?.id ?? "", "bi.model.cycleForward")
    }

    test "key names accept the KeyId grammar" {
        assert.is_true(key_id_valid("up"));
        assert.is_true(key_id_valid("enter"));
        assert.is_true(key_id_valid("escape"));
        assert.is_true(key_id_valid("pageUp"));
        assert.is_true(key_id_valid("PAGEUP"));
        assert.is_true(key_id_valid("ctrl+c"));
        assert.is_true(key_id_valid("Ctrl+Shift+Up"));
        assert.is_true(key_id_valid("ctrl+alt+]"));
        assert.is_true(key_id_valid("ctrl+-"));
        assert.is_true(key_id_valid("shift+enter"))
    }

    test "key names reject garbage" {
        assert.is_true(!key_id_valid(""));
        assert.is_true(!key_id_valid("ctrl+"));
        assert.is_true(!key_id_valid("+c"));
        assert.is_true(!key_id_valid("bogus+c"));
        assert.is_true(!key_id_valid("ctrl+bogus"));
        assert.is_true(!key_id_valid("ctrl+ctrl+c"));
        assert.is_true(!key_id_valid("ctrl+shift"));
        assert.is_true(!key_id_valid("f13"))
    }

    test "valid entries pass through" {
        let v = validate_keybinding_entries(
            [
                KeybindingEntry { id: "tui.select.up", keys: ["ctrl+p"] },
                KeybindingEntry { id: "tui.select.cancel", keys: ["escape", "ctrl+g"] },
            ],
        );
        assert.equal(v.errors.length(), 0);
        assert.equal(v.valid.length(), 2);
        assert.equal(v.valid.at(0)?.id ?? "", "tui.select.up")
    }

    test "unknown ids fail loudly" {
        let v = validate_keybinding_entries([KeybindingEntry { id: "cycle", keys: ["ctrl+p"] }]);
        assert.equal(v.valid.length(), 0);
        assert.equal(v.errors.length(), 1);
        assert.equal(v.errors.at(0)?.id ?? "", "cycle");
        assert.contains(v.errors.at(0)?.reason ?? "", "unknown keybinding id")
    }

    test "bad key names fail loudly" {
        let v = validate_keybinding_entries([KeybindingEntry { id: "tui.select.up", keys: ["ctrl+p", "bogus"] }]);
        assert.equal(v.valid.length(), 0);
        assert.equal(v.errors.length(), 1);
        assert.contains(v.errors.at(0)?.reason ?? "", "bogus")
    }

    test "empty key list is a legal unbind" {
        let v = validate_keybinding_entries([KeybindingEntry { id: "tui.editor.yankPop", keys: [] }]);
        assert.equal(v.errors.length(), 0);
        assert.equal(v.valid.length(), 1)
    }

    test "rows shape overrides over defaults" {
        let rows = keybinding_rows([KeybindingEntry { id: "tui.select.up", keys: ["ctrl+p"] }]);
        assert.equal(rows.length(), 48);
        let hit = rows
            .filter((r) -> {
                r.id == "tui.select.up"
            })
            .at(0);
        assert.equal(hit?.current_keys ?? [""], ["ctrl+p"]);
        assert.is_true(hit?.overridden ?? false);
        let plain = rows
            .filter((r) -> {
                r.id == "tui.select.down"
            })
            .at(0);
        assert.equal(plain?.current_keys ?? [""], ["down"]);
        assert.is_true(!(plain?.overridden ?? true));
        let out = format_keybinding_rows(
            rows.filter((r) -> {
                r.id == "tui.select.up"
            }),
        );
        assert.contains(out, "tui.select.up");
        assert.contains(out, "ctrl+p");
        assert.contains(out, "*")
    }
}
