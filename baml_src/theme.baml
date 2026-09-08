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
    brand: string,
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
            brand: "[38;2;168;85;247m",
        },
        Theme {
            name: "light",
            description: "Light-background ANSI palette (darker accents)",
            accent: "[34m",
            dim: "[2m",
            good: "[32m",
            bad: "[31m",
            busy: "[33m",
            brand: "[38;2;168;85;247m",
        },
        Theme {
            name: "none",
            description: "No styling — plain text always",
            accent: "",
            dim: "",
            good: "",
            bad: "",
            busy: "",
            brand: "",
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
        "brand" => theme.brand,
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
// brand is BAML's marketing purple (#A855F7, truecolor) — Bi's brand
// line color; MIT on both sides, so no licensing friction.
function theme_preview(name: string?) -> string {
    `${style_segment("Heading", "accent", name)}\n${style_segment("··· fence", "dim", name)}\n${style_segment("✓ done", "good", name)}\n${style_segment("✗ failed", "bad", name)}\n${style_segment("◌ working", "busy", name)}\n${style_segment("◆ brand", "brand", name)}`
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

test "preview shows all six roles" {
    let p = theme_preview("default");
    assert.contains(p, "Heading");
    assert.contains(p, "✓ done");
    assert.contains(p, "◌ working");
    assert.contains(p, "◆ brand");
    assert.is_true(p.length() > theme_preview(null).length())
}

test "brand wraps in BAML purple, degrades to plain" {
    // Truecolor code is 18 bytes: 18 + 2 + 4 = 24. Same bi#76
    // length-pin trick — no raw bytes typed in this test.
    assert.equal(style_segment("hi", "brand", "default").length(), 24);
    assert.equal(style_segment("hi", "brand", "light").length(), 24);
    assert.equal(style_segment("hi", "brand", "none"), "hi");
    assert.equal(style_segment("hi", "brand", null), "hi");
    assert.equal(style_segment("hi", "brand", "bogus"), "hi")
}

// Custom theme files (bi#105). Pi themes are JSON files validated
// against theme-schema.json (name + colors, hex/var/256-int values,
// "/" reserved for auto light/dark); bi's port keeps the same shape
// reduced to bi's six roles. The host owns FS (read + JSON.parse);
// BAML owns the schema: names + per-role specs with ROW-LEVEL refusal
// reasons (empty = valid). A role spec is "" (terminal default) or a
// #RRGGBB hex color — pure-string rules, so no raw ESC bytes are
// needed here; the host converts valid specs to ANSI.
function is_hex_digit(ch: string) -> bool {
    ch == "0"
        || ch == "1"
        || ch == "2"
        || ch == "3"
        || ch == "4"
        || ch == "5"
        || ch == "6"
        || ch == "7"
        || ch == "8"
        || ch == "9"
        || ch == "a"
        || ch == "b"
        || ch == "c"
        || ch == "d"
        || ch == "e"
        || ch == "f"
        || ch == "A"
        || ch == "B"
        || ch == "C"
        || ch == "D"
        || ch == "E"
        || ch == "F"
}

function is_hex_color(spec: string) -> bool {
    if (spec.length() != 7) {
        false
    } else if (spec.slice(0, 1) != "#") {
        false
    } else {
        let ok = true;
        for (let ch in spec.slice(1, spec.length()).chars()) {
            if (!is_hex_digit(ch)) {
                ok = false
            }
        }
        ok
    }
}

function validate_theme_role(role: string, spec: string) -> string? {
    if (spec == "") {
        null
    } else if (is_hex_color(spec)) {
        null
    } else {
        `${role}: expected empty or a #RRGGBB hex color, got "${spec}"`
    }
}

// Row-level schema check for one custom theme file's fields. Returns
// one refusal reason per bad row (name + each role); empty means the
// file validates. Shadowing a builtin name is refused (pi lists
// builtins first and skips dupes, so a shadow could never resolve).
function validate_theme_file(
    name: string,
    description: string,
    accent: string,
    dim: string,
    good: string,
    bad: string,
    busy: string,
    brand: string,
) -> string[] {
    let reasons: string[] = [];
    if (name.length() == 0) {
        reasons.push("name: missing (custom theme files need a name)")
    } else if (!(name.index_of("/") is null)) {
        reasons.push(`name: "${name}" must not contain "/" (reserved for auto light/dark settings)`)
    } else if (name == "default" || name == "light" || name == "none") {
        reasons.push(`name: "${name}" shadows a built-in theme`)
    }
    if (description.length() == 0) {
        reasons.push("description: missing (one line saying what the theme is for)")
    }
    for (let role in ["accent", "dim", "good", "bad", "busy", "brand"]) {
        let spec = if (role == "accent") {
            accent
        } else if (role == "dim") {
            dim
        } else if (role == "good") {
            good
        } else if (role == "bad") {
            bad
        } else if (role == "busy") {
            busy
        } else {
            brand
        };
        match (validate_theme_role(role, spec)) {
            null => {},
            let reason: string => {
                reasons.push(reason)
            },
        }
    }
    reasons
}

// Wrap with an explicit ANSI code (host-converted from a validated
// hex spec). The reset suffix is sliced off a style_segment probe —
// style_segment always appends the same 4-byte reset, so the last 4
// bytes of any wrapped empty string ARE the reset, with no raw ESC
// bytes typed here (same bi#76 constraint as above).
function style_with_code(text: string, code: string) -> string {
    if (code == "") {
        text
    } else {
        let probe = style_segment("", "good", "default");
        let reset = probe.slice(probe.length() - 4, probe.length());
        `${code}${text}${reset}`
    }
}

// Same six sample lines as theme_preview, but over explicit codes so
// a custom theme previews BEFORE it commits (nothing is registered).
function preview_custom_theme(
    accent: string,
    dim: string,
    good: string,
    bad: string,
    busy: string,
    brand: string,
) -> string {
    `${style_with_code("Heading", accent)}\n${style_with_code("··· fence", dim)}\n${style_with_code("✓ done", good)}\n${style_with_code("✗ failed", bad)}\n${style_with_code("◌ working", busy)}\n${style_with_code("◆ brand", brand)}`
}

// Extra rows for the merged list (builtins via format_theme_list,
// customs here): same `  */  name — description` shape so pipes see
// one uniform listing.
function format_custom_theme_rows(
    names: string[],
    descriptions: string[],
    current: string,
) -> string {
    let out = "";
    let i = 0;
    for (let name in names) {
        let desc = descriptions.at(i) ?? "";
        let mark = if (current != "" && current == name) {
            "*"
        } else {
            " "
        };
        out = `${out}  ${mark} ${name} — ${desc}\n`;
        i = i + 1
    }
    out
}

test "hex specs accept #RRGGBB and empty only" {
    assert.is_true(is_hex_color("#268bd2"));
    assert.is_true(is_hex_color("#A855F7"));
    assert.is_true(!is_hex_color(""));
    assert.is_true(!is_hex_color("268bd2"));
    assert.is_true(!is_hex_color("#268bd"));
    assert.is_true(!is_hex_color("#268bd2ff"));
    assert.is_true(!is_hex_color("#268bg2"));
    assert.is_true(!is_hex_color("cyan"))
}

test "a good custom file validates with no reasons" {
    assert.equal(
        validate_theme_file(
            "solar",
            "Warm low-contrast custom",
            "#268bd2",
            "#93a1a1",
            "#859900",
            "#dc322f",
            "#b58900",
            "#6c71c4",
        ),
        [],
    );
    // Empty specs (terminal defaults) are valid too.
    assert.equal(validate_theme_file("plain-ish", "All defaults", "", "", "", "", "", ""), [])
}

test "malformed files refuse with row-level reasons" {
    // Missing name + missing description + two bad roles = 4 rows.
    let reasons = validate_theme_file("", "", "#268bd2", "dim", "", "red", "", "");
    assert.equal(reasons.length(), 4);
    assert.contains(reasons.at(0) ?? "", "name: missing");
    assert.contains(reasons.at(1) ?? "", "description: missing");
    assert.contains(reasons.at(2) ?? "", "dim:");
    assert.contains(reasons.at(3) ?? "", "bad:");
    // "/" names (pi's auto-setting reserve) and builtin shadows refuse.
    assert.equal(validate_theme_file("a/b", "x", "", "", "", "", "", "").length(), 1);
    assert.contains(
        validate_theme_file("a/b", "x", "", "", "", "", "", "").at(0) ?? "",
        "must not contain",
    );
    assert.contains(
        validate_theme_file("default", "x", "", "", "", "", "", "").at(0) ?? "",
        "shadows a built-in",
    )
}

test "custom preview matches builtin preview over the same codes" {
    // role_code reads the real palette out of the registry, so this
    // pins preview_custom_theme to theme_preview with zero raw bytes.
    match (get_theme("default")) {
        null => assert.is_true(false),
        let t: Theme => {
            let p = preview_custom_theme(
                role_code(t, "accent"),
                role_code(t, "dim"),
                role_code(t, "good"),
                role_code(t, "bad"),
                role_code(t, "busy"),
                role_code(t, "brand"),
            );
            assert.equal(p, theme_preview("default"));
            assert.is_true(p.length() > preview_custom_theme("", "", "", "", "", "").length())
        },
    }
}

test "style_with_code wraps like style_segment" {
    match (get_theme("default")) {
        null => assert.is_true(false),
        let t: Theme => {
            // Same 5 + 2 + 4 = 11 length pin as style_segment (bi#76).
            assert.equal(style_with_code("hi", role_code(t, "good")).length(), 11);
            assert.equal(
                style_with_code("hi", role_code(t, "good")),
                style_segment("hi", "good", "default"),
            );
            assert.equal(style_with_code("hi", ""), "hi")
        },
    }
}

test "custom rows mark current like the builtin list" {
    let out = format_custom_theme_rows(["solar", "ink"], ["Warm", "Dark"], "ink");
    assert.contains(out, "  solar — Warm");
    assert.contains(out, "* ink — Dark");
    assert.equal(format_custom_theme_rows([], [], "x"), "")
}

// ---------------------------------------------------------------------------
// bi#185: chrome palette tokens — hex-tokens-only (kimi colors.ts:17-134
// mirror). BAML owns the token schema + defaults; the host
// (theme-files.ts) owns override loading/validation and maps token →
// ANSI at render time (no cached chalk). Dark-only for now; the shape
// allows a light palette later.
class ChromePalette {
    name: string,
    description: string,
    text: string,
    text_dim: string,
    text_muted: string,
    primary: string,
    border: string,
}

function chrome_palettes() -> ChromePalette[] {
    [
        ChromePalette {
            name: "dark",
            description: "Dark-background chrome palette (bi flag theme: pink accent, purple dim, deep-blue border)",
            text: "#E0E0E0",
            text_dim: "#9B4F96",
            text_muted: "#6B6B6B",
            primary: "#D60270",
            border: "#0038A8",
        },
    ]
}

function chrome_palette(name: string) -> ChromePalette? {
    for (let p in chrome_palettes()) {
        if (p.name == name) {
            return p;
        }
    }
    null
}

function chrome_token_names() -> string[] {
    ["text", "text_dim", "text_muted", "primary", "border"]
}

// Semantic LEVELS → token names: BAML shapes take levels, never colors,
// so baml test pins level usage while escape bytes stay in the host and
// pty drills. Unknown levels degrade to "text" (the plainest token).
function chrome_token_for_level(level: string) -> string {
    match (level) {
        "title" => "text",
        "label" => "text",
        "dim" => "text_dim",
        "hint" => "text_muted",
        "muted" => "text_muted",
        "accent" => "primary",
        "border" => "border",
        _ => "text",
    }
}

// Hex-tokens-only: every token must be a #RRGGBB color — no empty, no
// named colors. One refusal reason per bad token, naming it (bi#55);
// empty means the set validates.
function validate_chrome_tokens(
    text: string,
    text_dim: string,
    text_muted: string,
    primary: string,
    border: string,
) -> string[] {
    let reasons: string[] = [];
    for (let token in chrome_token_names()) {
        let spec = if (token == "text") {
            text
        } else if (token == "text_dim") {
            text_dim
        } else if (token == "text_muted") {
            text_muted
        } else if (token == "primary") {
            primary
        } else {
            border
        };
        if (!is_hex_color(spec)) {
            reasons.push(`${token}: expected a #RRGGBB hex color, got "${spec}"`)
        }
    }
    reasons
}
