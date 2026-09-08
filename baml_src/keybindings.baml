// bi/baml_src/keybindings.baml — user-editable keybindings file (bi#91).
//
// Re-scope note (bi#69 reconcile): there is no homegrown key layer — key
// parsing lives in pi-tui (`matchesKey` idiom) and `src/prompt.ts` consumes
// it. This module owns the FILE FORMAT only: which binding ids exist (the
// `TUI_KEYBINDINGS` surface, vendored below, plus bi-owned `bi.*` ids like
// `bi.model.cycleForward` registered alongside it in the manager), which
// key names are legal (the `KeyId` grammar: modifiers + base key), and how
// the manager lists them. The host
// (`src/keybindings.ts`) owns file IO, the `KeybindingsManager` wiring, and
// the picker UI. Unknown ids and bad key names fail LOUDLY here — pi-tui's
// own `rebuild()` silently skips unknown ids and `parseKeyId` silently drops
// unknown modifiers, so a typo would otherwise read as "my remap was
// ignored" with no signal.

class KeybindingDef {
    id: string,
    description: string,
    default_keys: string[],
}

class KeybindingEntry {
    id: string,
    keys: string[],
}

class ValidBinding {
    id: string,
    keys: string[],
}

class BindingError {
    id: string,
    reason: string,
}

class KeybindingValidation {
    valid: ValidBinding[],
    errors: BindingError[],
}

class KeybindingRow {
    id: string,
    description: string,
    default_keys: string[],
    current_keys: string[],
    overridden: bool,
}

// Vendored `TUI_KEYBINDINGS` surface (defaults + descriptions verbatim from
// `@earendil-works/pi-tui@0.84.3`) plus bi-owned `bi.*` ids (pi's
// `app.model.cycleForward` default + description verbatim). The host
// registers both halves in one manager (`BI_KEYBINDINGS` in
// `src/keybindings.ts`). `bi/scripts/keybindings.mjs` asserts this table
// stays in row-count parity with library + bi-owned.
function keybinding_definitions() -> KeybindingDef[] {
    [
        KeybindingDef {
            id: "bi.model.cycleForward",
            description: "Cycle to next model",
            default_keys: ["ctrl+p"],
        },
        KeybindingDef {
            id: "tui.editor.cursorUp",
            description: "Move cursor up",
            default_keys: ["up"],
        },
        KeybindingDef {
            id: "tui.editor.cursorDown",
            description: "Move cursor down",
            default_keys: ["down"],
        },
        KeybindingDef {
            id: "tui.editor.historyPrevious",
            description: "Select previous prompt history entry",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.editor.historyNext",
            description: "Select next prompt history entry",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.editor.cursorLeft",
            description: "Move cursor left",
            default_keys: ["left", "ctrl+b"],
        },
        KeybindingDef {
            id: "tui.editor.cursorRight",
            description: "Move cursor right",
            default_keys: ["right", "ctrl+f"],
        },
        KeybindingDef {
            id: "tui.editor.cursorWordLeft",
            description: "Move cursor word left",
            default_keys: ["alt+left", "ctrl+left", "alt+b"],
        },
        KeybindingDef {
            id: "tui.editor.cursorWordRight",
            description: "Move cursor word right",
            default_keys: ["alt+right", "ctrl+right", "alt+f"],
        },
        KeybindingDef {
            id: "tui.editor.cursorLineStart",
            description: "Move to line start",
            default_keys: ["home", "ctrl+home", "ctrl+a"],
        },
        KeybindingDef {
            id: "tui.editor.cursorLineEnd",
            description: "Move to line end",
            default_keys: ["end", "ctrl+end", "ctrl+e"],
        },
        KeybindingDef {
            id: "tui.editor.jumpForward",
            description: "Jump forward to character",
            default_keys: ["ctrl+]"],
        },
        KeybindingDef {
            id: "tui.editor.jumpBackward",
            description: "Jump backward to character",
            default_keys: ["ctrl+alt+]"],
        },
        KeybindingDef {
            id: "tui.editor.pageUp",
            description: "Page up",
            default_keys: ["pageUp", "ctrl+pageUp"],
        },
        KeybindingDef {
            id: "tui.editor.pageDown",
            description: "Page down",
            default_keys: ["pageDown", "ctrl+pageDown"],
        },
        KeybindingDef {
            id: "tui.editor.deleteCharBackward",
            description: "Delete character backward",
            default_keys: ["backspace"],
        },
        KeybindingDef {
            id: "tui.editor.deleteCharForward",
            description: "Delete character forward",
            default_keys: ["delete", "ctrl+d"],
        },
        KeybindingDef {
            id: "tui.editor.deleteWordBackward",
            description: "Delete word backward",
            default_keys: ["ctrl+w", "alt+backspace"],
        },
        KeybindingDef {
            id: "tui.editor.deleteWordForward",
            description: "Delete word forward",
            default_keys: ["alt+d", "alt+delete"],
        },
        KeybindingDef {
            id: "tui.editor.deleteToLineStart",
            description: "Delete to line start",
            default_keys: ["ctrl+u"],
        },
        KeybindingDef {
            id: "tui.editor.deleteToLineEnd",
            description: "Delete to line end",
            default_keys: ["ctrl+k"],
        },
        KeybindingDef { id: "tui.editor.yank", description: "Yank", default_keys: ["ctrl+y"] },
        KeybindingDef { id: "tui.editor.yankPop", description: "Yank pop", default_keys: ["alt+y"] },
        KeybindingDef { id: "tui.editor.undo", description: "Undo", default_keys: ["ctrl+-"] },
        KeybindingDef {
            id: "tui.input.newLine",
            description: "Insert newline",
            default_keys: ["shift+enter", "ctrl+j"],
        },
        KeybindingDef {
            id: "tui.input.submit",
            description: "Submit input",
            default_keys: ["enter"],
        },
        KeybindingDef {
            id: "tui.input.tab",
            description: "Tab / autocomplete",
            default_keys: ["tab"],
        },
        KeybindingDef {
            id: "tui.input.copy",
            description: "Copy selection",
            default_keys: ["ctrl+c"],
        },
        KeybindingDef {
            id: "tui.select.up",
            description: "Move selection up",
            default_keys: ["up"],
        },
        KeybindingDef {
            id: "tui.select.down",
            description: "Move selection down",
            default_keys: ["down"],
        },
        KeybindingDef {
            id: "tui.select.pageUp",
            description: "Selection page up",
            default_keys: ["pageUp"],
        },
        KeybindingDef {
            id: "tui.select.pageDown",
            description: "Selection page down",
            default_keys: ["pageDown"],
        },
        KeybindingDef {
            id: "tui.select.confirm",
            description: "Confirm selection",
            default_keys: ["enter"],
        },
        KeybindingDef {
            id: "tui.select.cancel",
            description: "Cancel selection",
            default_keys: ["escape", "ctrl+c"],
        },
        KeybindingDef {
            id: "tui.altScreen.pageUp",
            description: "Scroll viewport up one page",
            default_keys: ["pageUp"],
        },
        KeybindingDef {
            id: "tui.altScreen.pageDown",
            description: "Scroll viewport down one page",
            default_keys: ["pageDown"],
        },
        KeybindingDef {
            id: "tui.altScreen.halfPageUp",
            description: "Scroll viewport up half a page",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.altScreen.halfPageDown",
            description: "Scroll viewport down half a page",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.altScreen.lineUp",
            description: "Scroll viewport up one line",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.altScreen.lineDown",
            description: "Scroll viewport down one line",
            default_keys: [],
        },
        KeybindingDef {
            id: "tui.altScreen.previousPrompt",
            description: "Jump to previous semantic prompt",
            default_keys: ["ctrl+shift+up", "ctrl+up"],
        },
        KeybindingDef {
            id: "tui.altScreen.nextPrompt",
            description: "Jump to next semantic prompt",
            default_keys: ["ctrl+shift+down", "ctrl+down"],
        },
        KeybindingDef {
            id: "tui.altScreen.search",
            description: "Search the primary scroll view",
            default_keys: ["ctrl+shift+f"],
        },
        KeybindingDef {
            id: "tui.altScreen.searchNext",
            description: "Select the next search match",
            default_keys: ["enter", "ctrl+g"],
        },
        KeybindingDef {
            id: "tui.altScreen.searchPrevious",
            description: "Select the previous search match",
            default_keys: ["shift+enter", "ctrl+shift+g"],
        },
        KeybindingDef {
            id: "tui.altScreen.searchClose",
            description: "Close transcript search",
            default_keys: ["escape"],
        },
        KeybindingDef {
            id: "tui.altScreen.top",
            description: "Scroll viewport to top",
            default_keys: ["home"],
        },
        KeybindingDef {
            id: "tui.altScreen.bottom",
            description: "Scroll viewport to bottom",
            default_keys: ["end"],
        },
    ]
}

function keybinding_known(id: string) -> bool {
    keybinding_definitions()
        .map((d) -> {
            d.id
        })
        .includes(id)
}

// Base-key allowlist: the `KeyId` base surface lowercased (pi-tui
// `parseKeyId` lowercases before matching, so validation does too).
function _base_keys() -> string[] {
    [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "`",
        "-",
        "=",
        "[",
        "]",
        "\\",
        ";",
        "'",
        ",",
        ".",
        "/",
        "!",
        "@",
        "#",
        "$",
        "%",
        "^",
        "&",
        "*",
        "(",
        ")",
        "_",
        "|",
        "~",
        "{",
        "}",
        ":",
        "<",
        ">",
        "?",
        "escape",
        "esc",
        "enter",
        "return",
        "tab",
        "space",
        "backspace",
        "delete",
        "insert",
        "clear",
        "home",
        "end",
        "pageup",
        "pagedown",
        "up",
        "down",
        "left",
        "right",
        "f1",
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
        "f7",
        "f8",
        "f9",
        "f10",
        "f11",
        "f12",
    ]
}

function _modifiers() -> string[] {
    ["ctrl", "shift", "alt", "super"]
}

// Strict `KeyId` grammar: `mod+...+base`, every leading segment a distinct
// known modifier, the final segment a known base key. STRICTER than pi-tui's
// `parseKeyId` on purpose — the library checks modifiers with `includes`,
// so `bogus+c` would silently degrade to plain `c`; here it is an error.
function key_id_valid(key: string) -> bool {
    //# Split into segments; the library lowercases, so do the same.
    let parts = key.to_lower_case().split("+");
    let base = parts.at(parts.length() - 1) ?? "";
    if (!_base_keys().includes(base)) {
        return false;
    }
    let mods = parts.slice(0, parts.length() - 1);
    let seen: string[] = [];
    for (let m in mods) {
        if (!_modifiers().includes(m)) {
            return false;
        }
        if (seen.includes(m)) {
            return false;
        }
        seen.push(m)
    }
    true
}

// Validate one file's entries: unknown ids and bad key names become loud
// `BindingError`s (the host prints them on load); empty key lists are a
// legal unbind (pi's `normalizeKeys` maps them to "no keys").
function validate_keybinding_entries(entries: KeybindingEntry[]) -> KeybindingValidation {
    //# Partition entries into valid bindings vs loud errors.
    let valid: ValidBinding[] = [];
    let errors: BindingError[] = [];
    for (let e in entries) {
        if (!keybinding_known(e.id)) {
            errors.push(
                BindingError {
                    id: e.id,
                    reason: "unknown keybinding id (see `bi keybindings list`)",
                },
            )
        } else {
            let bad = e.keys.filter((k) -> {
                !key_id_valid(k)
            });
            if (bad.length() > 0) {
                errors.push(
                    BindingError { id: e.id, reason: `invalid key name ${bad.at(0) ?? ""}` },
                )
            } else {
                valid.push(ValidBinding { id: e.id, keys: e.keys })
            }
        }
    }
    KeybindingValidation { valid: valid, errors: errors }
}

// Manager list shaping: one row per known binding — description, library
// defaults, and the current keys (override wins, empty override unbinds).
function keybinding_rows(overrides: KeybindingEntry[]) -> KeybindingRow[] {
    keybinding_definitions().map((d) -> {
        let hit = overrides
            .filter((o) -> {
                o.id == d.id
            })
            .at(0);
        let current = hit?.keys ?? d.default_keys;
        let is_over = !(hit is null);
        KeybindingRow {
            id: d.id,
            description: d.description,
            default_keys: d.default_keys,
            current_keys: current,
            overridden: is_over,
        }
    })
}

// One text line per row for `bi keybindings list`: id, current keys (or
// `(unbound)`), and the default for reference. `*` marks an override.
function format_keybinding_rows(rows: KeybindingRow[]) -> string {
    rows
        .map((r) -> {
            let cur = if (r.current_keys.length() == 0) {
                "(unbound)"
            } else {
                r.current_keys.join(" ")
            };
            let def = if (r.default_keys.length() == 0) {
                "(none)"
            } else {
                r.default_keys.join(" ")
            };
            let mark = if (r.overridden) {
                "*"
            } else {
                " "
            };
            `${mark} ${r.id}  ${cur}  (default: ${def}) — ${r.description}`
        })
        .join("\n")
}
