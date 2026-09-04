// bi/baml_src/theme.baml — theme tokens (bi#33).
// BAML owns palettes as data + the wrap rules; the host owns WHEN styling
// applies (TTY only, NO_COLOR respected) by passing a theme name or null.
// Plain (null) output is byte-identical to unstyled text, so pipes, tests,
// and --mode json never see escape codes. Five roles cover all bi#27/bi#28
// rendering: accent (headings, current markers), dim (delimiters, footer),
// good (success), bad (failure), busy (in-progress).

class Theme {
    name: string,
    description: string,
    accent: string,
    dim: string,
    good: string,
    bad: string,
    busy: string,
}

function list_themes() -> Theme[] {
    [
        Theme {
            name: "default",
            description: "Dark-background ANSI palette",
            accent: "[36m",
            dim: "[2m",
            good: "[32m",
            bad: "[31m",
            busy: "[33m",
        },
        Theme {
            name: "light",
            description: "Light-background ANSI palette (darker accents)",
            accent: "[34m",
            dim: "[2m",
            good: "[32m",
            bad: "[31m",
            busy: "[33m",
        },
        Theme {
            name: "none",
            description: "No styling — plain text always",
            accent: "",
            dim: "",
            good: "",
            bad: "",
            busy: "",
        },
    ]
}

function get_theme(name: string) -> Theme? {
    for (let t in list_themes()) {
        if (t.name == name) {
            return t;
        }
    }
    null
}

function role_code(theme: Theme, role: string) -> string {
    match (role) {
        "accent" => theme.accent,
        "dim" => theme.dim,
        "good" => theme.good,
        "bad" => theme.bad,
        "busy" => theme.busy,
        _ => "",
    }
}

// Wrap one segment. Unknown theme or role, or an empty code, yields the
// text unchanged — styling degrades to plain, never to broken escapes.
//
// INVISIBLE-BYTE WARNING (bi#76): the theme codes below start with a raw
// 0x1B byte and style_segment appends a raw 0x1B +"[0m". BAML 0.17.0 has
// no \xHH or \uHHHH string escape, so escapes cannot be typed — they are
// bytes in this file. Do NOT retype them by hand (editors show `^[`);
// the length asserts below fail if the bytes ever become literal text.
function style_segment(text: string, role: string, theme_name: string?) -> string {
    match (theme_name) {
        null => text,
        let name: string => {
            match (get_theme(name)) {
                null => text,
                let t: Theme => {
                    let code = role_code(t, role);
                    if (code == "") {
                        text
                    } else {
                        `${code}${text}[0m`
                    }
                },
            }
        },
    }
}

// Sample block proving every role in one glance (used by /theme).
function theme_preview(name: string?) -> string {
    `${style_segment("Heading", "accent", name)}\n${style_segment("··· fence", "dim", name)}\n${style_segment("✓ done", "good", name)}\n${style_segment("✗ failed", "bad", name)}\n${style_segment("◌ working", "busy", name)}`
}

function format_theme_list(current: string?) -> string {
    let out = "";
    for (let t in list_themes()) {
        let cur = current ?? "";
        let mark = if (cur != "" && cur == t.name) {
            "*"
        } else {
            " "
        };
        out = `${out}  ${mark} ${t.name} — ${t.description}\n`;
    }
    out
}

test "three themes resolve, unknown is null" {
    assert.equal(list_themes().length(), 3);
    match (get_theme("default")) {
        null => assert.is_true(false),
        let t: Theme => assert.equal(t.accent, "[36m"),
    }
    assert.is_true(get_theme("bogus") is null)
}

test "style_segment wraps known roles, passes the rest through" {
    assert.equal(style_segment("hi", "good", "default"), "[32mhi[0m");
    // Length pins REAL escape decoding: 5 + 2 + 4 = 11. Literal
    // backslash text would measure 20 (bi#76 regression).
    assert.equal(style_segment("hi", "good", "default").length(), 11);
    assert.equal(style_segment("hi", "bad", "light"), "[31mhi[0m");
    assert.equal(style_segment("hi", "good", null), "hi");
    assert.equal(style_segment("hi", "good", "bogus"), "hi");
    assert.equal(style_segment("hi", "bogus-role", "default"), "hi");
    assert.equal(style_segment("hi", "good", "none"), "hi")
}

test "theme list marks current" {
    let out = format_theme_list("light");
    assert.contains(out, "* light");
    assert.contains(out, "  default")
}

test "preview shows all five roles" {
    let p = theme_preview("default");
    assert.contains(p, "Heading");
    assert.contains(p, "✓ done");
    assert.contains(p, "◌ working");
    assert.is_true(p.length() > theme_preview(null).length())
}
