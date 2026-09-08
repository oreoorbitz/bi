// bi/baml_src/render.baml — message shaping policy (bi#27).
// BAML owns markdown→terminal-text transforms + tool status lines; the
// host prints the shaped lines (ANSI/color arrives with bi#33 themes).
// Fenced code in known languages gets lexical highlighting (keywords,
// strings, numbers, comments); unknown/plain fences pass through byte-
// clean so pipes and narrow terminals never see noise.

function find_from(cs: string[], target: string, from: int) -> int? {
    let i = from;
    let found: int? = null;
    while (i < cs.length()) {
        if (cs.at(i) == target) {
            found = i;
            break;
        }
        i = i + 1
    }
    found
}

// Inline spans on one prose line: `**b**`/`__b__` strip markers, keep
// text; [text](url) becomes "text (url)"; ![alt](url) becomes
// "[image: alt]". Unmatched markers pass through literally — never eat
// user text. Single * and _ emphasis is left alone.
function render_inline(text: string) -> string {
    let cs = text.chars();
    let out = "";
    let i = 0;
    while (i < cs.length()) {
        let c = cs.at(i) ?? "";
        if (c == "!" && i + 1 < cs.length() && cs.at(i + 1) == "[") {
            match (find_from(cs, "]", i + 2)) {
                null => {
                    out = `${out}${c}`;
                    i = i + 1
                },
                let close: int => {
                    if (close + 1 < cs.length() && cs.at(close + 1) == "(") {
                        match (find_from(cs, ")", close + 2)) {
                            null => {
                                out = `${out}${c}`;
                                i = i + 1
                            },
                            let end: int => {
                                let alt = text.slice(i + 2, close);
                                out = `${out}[image: ${alt}]`;
                                i = end + 1
                            },
                        }
                    } else {
                        out = `${out}${c}`;
                        i = i + 1
                    }
                },
            }
        } else if (c == "[") {
            match (find_from(cs, "]", i + 1)) {
                null => {
                    out = `${out}${c}`;
                    i = i + 1
                },
                let close: int => {
                    if (close + 1 < cs.length() && cs.at(close + 1) == "(") {
                        match (find_from(cs, ")", close + 2)) {
                            null => {
                                out = `${out}${c}`;
                                i = i + 1
                            },
                            let end: int => {
                                let label = text.slice(i + 1, close);
                                let url = text.slice(close + 2, end);
                                out = `${out}${label} (${url})`;
                                i = end + 1
                            },
                        }
                    } else {
                        out = `${out}${c}`;
                        i = i + 1
                    }
                },
            }
        } else if (
            (c == "*" && i + 1 < cs.length() && cs.at(i + 1) == "*")
                || (c == "_" && i + 1 < cs.length() && cs.at(i + 1) == "_")
        ) {
            i = i + 2
        } else {
            out = `${out}${c}`;
            i = i + 1
        }
    }
    out
}

function count_hashes(line: string) -> int {
    let cs = line.chars();
    let n = 0;
    while (n < cs.length() && cs.at(n) == "#") {
        n = n + 1
    }
    n
}

// One prose line: headings lose their markers, rules become ···,
// everything else goes through inline spans.
function render_prose_line(line: string, theme: string? = null) -> string {
    let trimmed = line.trim();
    if (trimmed == "---" || trimmed == "***" || trimmed == "___" || trimmed == "- - -") {
        style_segment("···", "dim", theme)
    } else {
        let hashes = count_hashes(line);
        if (
            hashes >= 1
                && hashes <= 6
                && hashes < line.length()
                && line.slice(hashes, hashes + 1) == " "
        ) {
            style_segment(render_inline(line.slice(hashes + 1, line.length())), "accent", theme)
        } else {
            render_inline(line)
        }
    }
}

// Full message: code fences render with ··· delimiters (lang kept on
// the opener) and lexical highlighting inside known-language fences;
// unknown/plain fence bodies pass through byte-clean. Prose lines
// render. Trailing-newline shape preserved.
function render_markdown_text(text: string, theme: string? = null) -> string {
    let lines = text.split("\n");
    let out = "";
    let in_fence = false;
    let fence_lang: string? = null;
    let in_block = false;
    for (let line in lines) {
        let rendered = if (line.slice(0, 3) == "```") {
            in_fence = !in_fence;
            if (in_fence) {
                fence_lang = canonical_lang(line.slice(3, line.length()).trim());
                in_block = false
            } else {
                fence_lang = null;
                in_block = false
            };
            let lang = line.slice(3, line.length()).trim();
            if (lang.length() > 0 && in_fence && is_mermaid_fence(lang)) {
                style_segment("··· mermaid (diagram not rendered on this terminal)", "dim", theme)
            } else if (lang.length() > 0 && in_fence) {
                style_segment(`··· ${lang}`, "dim", theme)
            } else {
                style_segment("···", "dim", theme)
            }
        } else if (in_fence) {
            match (fence_lang) {
                null => line,
                let lang: string => {
                    let hl = highlight_code_line(line, lang, theme, in_block);
                    in_block = hl.in_block;
                    hl.text
                },
            }
        } else {
            render_prose_line(line, theme = theme)
        };
        out = `${out}${rendered}\n`;
    }
    if (text.length() > 0 && text.slice(text.length() - 1, text.length()) != "\n") {
        out.slice(0, out.length() - 1)
    } else {
        out
    }
}

// SGR text attributes for the TTY markdown theme fns (bi#165). BAML
// 0.17.0 has no \xHH string escapes (bi#76), so the ESC byte and the
// reset suffix are both sliced off a style_segment probe — byte 0 of
// any wrapped string is ESC and style_segment always appends the same
// 4-byte reset. Attr codes are SGR parameters (theme-independent);
// the theme only gates WHEN styling applies, same contract as
// style_segment: null/unknown/none degrade to plain text.
function text_attr(text: string, attr: string, theme_name: string?) -> string {
    match (theme_name) {
        null => text,
        let name: string => {
            if (name == "none" || get_theme(name) is null) {
                text
            } else {
                let probe = style_segment("", "good", "default");
                let esc = probe.slice(0, 1);
                let reset = probe.slice(probe.length() - 4, probe.length());
                let code = if (attr == "bold") {
                    `${esc}[1m`
                } else if (attr == "italic") {
                    `${esc}[3m`
                } else if (attr == "underline") {
                    `${esc}[4m`
                } else if (attr == "strikethrough") {
                    `${esc}[9m`
                } else {
                    ""
                };
                if (code == "") {
                    text
                } else {
                    `${code}${text}${reset}`
                }
            }
        },
    }
}

// Syntax highlight (bi#27 slice 1): generic lexical pass over fenced
// code lines in known languages — keywords (accent), strings (good),
// numbers (busy), comments (dim). Per-line state only: block comments
// thread through in_block, but multiline strings do not (documented
// limit). Unknown/plain fences never reach here — the caller passes
// those through untouched. Theme null/none degrades to byte-identical
// plain text via style_segment passthrough.
function canonical_lang(lang: string) -> string? {
    if (lang == "ts" || lang == "typescript" || lang == "js" || lang == "javascript") {
        "typescript"
    } else if (lang == "py" || lang == "python") {
        "python"
    } else if (lang == "sh" || lang == "shell" || lang == "bash") {
        "bash"
    } else if (lang == "json") {
        "json"
    } else if (lang == "toml") {
        "toml"
    } else if (lang == "baml") {
        "baml"
    } else {
        null
    }
}

function highlight_keywords(lang: string) -> string[] {
    if (lang == "typescript") {
        [
            "const",
            "let",
            "var",
            "function",
            "return",
            "if",
            "else",
            "for",
            "while",
            "class",
            "new",
            "import",
            "from",
            "export",
            "extends",
            "interface",
            "type",
            "enum",
            "null",
            "true",
            "false",
            "undefined",
            "this",
            "typeof",
            "instanceof",
            "async",
            "await",
            "try",
            "catch",
            "throw",
            "switch",
            "case",
            "break",
            "continue",
            "do",
            "of",
            "in",
        ]
    } else if (lang == "python") {
        [
            "def",
            "return",
            "if",
            "else",
            "elif",
            "for",
            "while",
            "class",
            "import",
            "from",
            "as",
            "pass",
            "None",
            "True",
            "False",
            "and",
            "or",
            "not",
            "in",
            "is",
            "lambda",
            "try",
            "except",
            "raise",
            "with",
            "yield",
            "del",
            "assert",
        ]
    } else if (lang == "bash") {
        [
            "if",
            "then",
            "else",
            "elif",
            "fi",
            "for",
            "while",
            "do",
            "done",
            "in",
            "case",
            "esac",
            "function",
            "return",
            "exit",
            "echo",
            "export",
            "local",
            "set",
            "true",
            "false",
        ]
    } else if (lang == "toml") {
        ["true", "false"]
    } else if (lang == "baml") {
        [
            "function",
            "test",
            "class",
            "let",
            "match",
            "if",
            "else",
            "for",
            "in",
            "true",
            "false",
            "null",
        ]
    } else {
        []
    }
}

function line_comment_markers(lang: string) -> string[] {
    if (lang == "typescript" || lang == "baml") {
        ["//"]
    } else if (lang == "python" || lang == "bash" || lang == "toml") {
        ["#"]
    } else {
        []
    }
}

function has_string(items: string[], target: string) -> bool {
    let found = false;
    for (let s in items) {
        if (s == target) {
            found = true
        }
    }
    found
}

function is_word_char(c: string) -> bool {
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$".index_of(c) != null
}

function is_digit(c: string) -> bool {
    "0123456789".index_of(c) != null
}

class HighlightedLine {
    text: string,
    in_block: bool,
}

function highlight_code_line(
    line: string,
    lang: string,
    theme: string?,
    in_block: bool,
) -> HighlightedLine {
    // Defense in depth: only canonical languages highlight, so a direct
    // caller with a stray label can never sprinkle escapes. The markdown
    // walker already filters, but the contract holds here too.
    if (canonical_lang(lang) == null) {
        HighlightedLine { text: line, in_block: false }
    } else {
        highlight_known_line(line, lang, theme, in_block)
    }
}

function highlight_known_line(
    line: string,
    lang: string,
    theme: string?,
    in_block: bool,
) -> HighlightedLine {
    let cs = line.chars();
    let out = "";
    let i = 0;
    let block = in_block;
    let keywords = highlight_keywords(lang);
    let markers = line_comment_markers(lang);
    let block_ok = lang == "typescript";
    // Block-comment interior accumulates unstyled and flushes dim on
    // close (or line end). The /* opener emits raw so a closer on a
    // later line never duplicates or drops source chars.
    let buf = "";
    while (i < cs.length()) {
        let c = cs.at(i) ?? "";
        if (block) {
            if (c == "*" && i + 1 < cs.length() && cs.at(i + 1) == "/") {
                out = `${out}${style_segment(`${buf}*/`, "dim", theme)}`;
                buf = "";
                i = i + 2;
                block = false
            } else {
                buf = `${buf}${c}`;
                i = i + 1
            }
        } else if (block_ok && c == "/" && i + 1 < cs.length() && cs.at(i + 1) == "*") {
            out = `${out}/*`;
            i = i + 2;
            block = true
        } else if (c == "\"" || c == "'" || c == "`") {
            let j = i + 1;
            while (j < cs.length() && cs.at(j) != c) {
                if (cs.at(j) == "\\") {
                    j = j + 1
                }
                j = j + 1
            }
            ;
            let end = if (j < cs.length()) {
                j + 1
            } else {
                j
            };
            out = `${out}${style_segment(line.slice(i, end), "good", theme)}`;
            i = end
        } else if (is_digit(c)) {
            let j = i + 1;
            while (j < cs.length() && (is_digit(cs.at(j) ?? "") || cs.at(j) == ".")) {
                j = j + 1
            }
            ;
            out = `${out}${style_segment(line.slice(i, j), "busy", theme)}`;
            i = j
        } else if (is_word_char(c)) {
            let j = i + 1;
            while (j < cs.length() && is_word_char(cs.at(j) ?? "")) {
                j = j + 1
            }
            ;
            let word = line.slice(i, j);
            let kw = false;
            for (let k in keywords) {
                if (k == word) {
                    kw = true
                }
            }
            ;
            if (kw) {
                out = `${out}${style_segment(word, "accent", theme)}`
            } else {
                out = `${out}${word}`
            }
            i = j
        } else if (c == "/" && has_string(markers, "//") && i + 1 < cs.length() && cs.at(i + 1) == "/") {
            out = `${out}${style_segment(line.slice(i, line.length()), "dim", theme)}`;
            i = cs.length()
        } else if (c == "#" && has_string(markers, "#")) {
            out = `${out}${style_segment(line.slice(i, line.length()), "dim", theme)}`;
            i = cs.length()
        } else {
            out = `${out}${c}`;
            i = i + 1
        }
    }
    if (block && buf.length() > 0) {
        out = `${out}${style_segment(buf, "dim", theme)}`
    }
    HighlightedLine { text: out, in_block: block }
}

function truncate_chars(text: string, max: int) -> string {
    if (text.length() <= max) {
        text
    } else {
        `${text.slice(0, max)}…`
    }
}

function first_line(text: string) -> string {
    match (text.index_of("\n")) {
        null => text,
        let i: int => text.slice(0, i),
    }
}

// Tool execution status (pi's tool-execution renderer, line-based):
// start names the call with truncated args, done names the outcome.
// Failures show the first output line (errors need visibility);
// successes show only a char count (the body already went to the model).
function format_tool_start(name: string, args_json: string, theme: string? = null) -> string {
    style_segment(`◌ ${name} — ${truncate_chars(args_json, 100)}`, "busy", theme)
}

function format_tool_done(
    name: string,
    output: string,
    failed: bool,
    theme: string? = null,
) -> string {
    if (failed) {
        style_segment(`✗ ${name} — ${truncate_chars(first_line(output), 120)}`, "bad", theme)
    } else {
        style_segment(`✓ ${name} · ${output.length()} chars`, "good", theme)
    }
}

test "headings rules and fences shape" {
    assert.equal(render_prose_line("## Hello"), "Hello");
    assert.equal(render_prose_line("# A"), "A");
    assert.equal(render_prose_line("####### nope"), "####### nope");
    assert.equal(render_prose_line("---"), "···");
    assert.equal(render_prose_line("  ***  "), "···");
    let fenced = render_markdown_text("before\n```python\nx = 1\n```\nafter");
    assert.contains(fenced, "before");
    assert.contains(fenced, "··· python");
    assert.contains(fenced, "x = 1");
    assert.contains(fenced, "after");
    assert.is_true(!fenced.includes("```"))
}

test "code fences highlight known langs, pass the rest through" {
    // Unthemed output is byte-identical to the old passthrough.
    assert.equal(
        render_markdown_text("```ts\nconst x = 1 // hi\n```", theme = null),
        "··· ts\nconst x = 1 // hi\n···",
    );
    assert.equal(
        render_markdown_text("```zzz\nconst x = 1\n```", theme = null),
        "··· zzz\nconst x = 1\n···",
    );
    // Themed output styles each lexical class (length grows by SGR
    // envelopes); the source chars all survive.
    let hi = render_markdown_text("```ts\nconst x = 1 // hi\n```", theme = "default");
    assert.contains(hi, "const");
    assert.contains(hi, "x = ");
    assert.is_true(hi.length() > "··· ts\nconst x = 1 // hi\n···".length() + 9);
    assert.is_true(!hi.includes("```"));
    // Python comments use #, TS # is a private field, not a comment.
    let py = highlight_code_line("x = 1 # c", "python", "default", false);
    assert.contains(py.text, "# c");
    assert.is_true(py.text.length() > "x = 1 # c".length());
    let ts = highlight_code_line("#c", "typescript", "default", false);
    assert.equal(ts.text, "#c");
    // Strings swallow comment markers and escapes; keywords need
    // boundaries (constant ≠ const + ant).
    let st = highlight_code_line("const s = \"a // b\" // c", "typescript", "default", false);
    assert.contains(st.text, "\"a // b\"");
    let w = highlight_code_line("constant = 1", "typescript", "default", false);
    assert.contains(w.text, "constant");
    // Only the number takes a 9-byte SGR envelope — "const" inside
    // "constant" stays unstyled (no second envelope).
    assert.equal(w.text.length(), "constant = 1".length() + 9);
    // Block comments thread across lines; unknown langs stay raw.
    let b1 = highlight_code_line("/* open", "typescript", "default", false);
    assert.is_true(b1.in_block);
    let b2 = highlight_code_line("still shut */ done", "typescript", "default", true);
    assert.is_true(!b2.in_block);
    assert.contains(b2.text, "done");
    let unk = highlight_code_line("const x = 1", "zzz", "default", false);
    assert.equal(unk.text, "const x = 1");
    assert.is_true(!unk.in_block);
}

test "inline spans strip pair markers and expand links" {
    assert.equal(render_inline("a **bold** word"), "a bold word");
    assert.equal(render_inline("__both__"), "both");
    assert.equal(render_inline("a *star* kept"), "a *star* kept");
    assert.equal(render_inline("see [docs](https://x.ai/y)"), "see docs (https://x.ai/y)");
    assert.equal(render_inline("look ![cat](c.png)"), "look [image: cat]");
    assert.equal(render_inline("unmatched [bracket"), "unmatched [bracket");
    assert.equal(render_inline("loose ** mark"), "loose  mark")
}

test "themed segments wrap, plain stays byte-clean" {
    assert.equal(render_prose_line("## Hi", theme = null), "Hi");
    assert.contains(render_prose_line("## Hi", theme = "default"), "Hi");
    assert.is_true(render_prose_line("## Hi", theme = "default").length() > "Hi".length());
    assert.equal(format_tool_start("bash", "{}", theme = "none"), "◌ bash — {}");
    assert.equal(format_tool_done("bash", "ok", false, theme = null), "✓ bash · 2 chars");
    assert.is_true(
        format_tool_done("bash", "ok", false, theme = "default").length()
            > "✓ bash · 2 chars".length(),
    );
    assert.is_true(!render_markdown_text("# T\n```py\nx\n```", theme = "default").includes("```"))
}

test "text_attr wraps SGR attrs, degrades to plain" {
    // Bold wraps "hi" (2) in a 4-char SGR open + 4-byte reset = 10,
    // with no raw bytes typed here (same bi#76 length-pin trick as
    // style_segment).
    assert.equal(text_attr("hi", "bold", "default").length(), 10);
    assert.contains(text_attr("hi", "bold", "default"), "[1m");
    assert.contains(text_attr("hi", "italic", "default"), "[3m");
    assert.contains(text_attr("hi", "underline", "default"), "[4m");
    assert.contains(text_attr("hi", "strikethrough", "default"), "[9m");
    // The reset suffix matches style_segment's probe-derived reset.
    let probe = style_segment("", "good", "default");
    let reset = probe.slice(probe.length() - 4, probe.length());
    assert.equal(text_attr("hi", "bold", "default").slice(6, 10), reset);
    assert.equal(text_attr("hi", "bold", null), "hi");
    assert.equal(text_attr("hi", "bold", "none"), "hi");
    assert.equal(text_attr("hi", "bold", "bogus"), "hi");
    assert.equal(text_attr("hi", "bogus-attr", "default"), "hi")
}

test "tool status lines name call and outcome" {
    assert.equal(
        format_tool_start("bash", "{\"cmd\":\"ls -la /tmp\"}"),
        "◌ bash — {\"cmd\":\"ls -la /tmp\"}",
    );
    assert.equal(format_tool_done("bash", "a\nb\n", false), "✓ bash · 4 chars");
    assert.equal(format_tool_done("bash", "exit 1\ntraceback here", true), "✗ bash — exit 1");
    assert.equal(truncate_chars("abcdef", 3), "abc…");
    assert.equal(first_line("one\ntwo"), "one")
}

// ── bi#71: unified diffs for edit/write tool results in the transcript ──
// pi renders edit tool results as diffs; bi showed raw output. BAML owns
// the whole shaping policy here (pure, baml-testable); the host only
// passes bytes through and prints view.lines iff view.diffable.
//
// Payload contract (host owns bytes): after an edit/write tool runs, the
// host passes the {path, before, after} envelope fields (null when absent,
// or when a side is binary — NUL detection is byte work, host-side, so
// BAML never sees binary). render_tool_diff decides diffable;
// unified_diff shapes. Non-diffable payloads (other tools, failures,
// unknown sides) yield diffable=false and NO lines — the transcript keeps
// today's start/done lines byte-identical (raw fallback = unchanged
// output). New-file writes pass before="" (empty, present) and render as
// an all-add hunk; before=null means unknown, not empty.
//
// Cost: unified_diff runs an LCS table, so sides are capped at
// tool_diff_line_cap() lines (300x300 cells). render_tool_diff enforces
// the cap — oversized sides take the omitted-diff arm (note + after-image
// head), never the LCS table.

class ToolDiffView {
    diffable: bool,
    lines: string[],
}

function tool_diff_line_cap() -> int {
    300
}

function tool_diff_context() -> int {
    3
}

// Split text into lines, dropping the single trailing "" a final "\n"
// leaves behind. "" -> [] (a new/emptied file side, still diffable).
function split_diff_lines(text: string) -> string[] {
    let parts = text.split("\n");
    let end = parts.length();
    if (end > 0 && (parts.at(end - 1) ?? "") == "") {
        end = end - 1
    }
    let out: string[] = [];
    let i = 0;
    while (i < end) {
        out.push(parts.at(i) ?? "");
        i = i + 1
    }
    out
}

// One hunk range in git style: ",1" elided, empty ranges as start,0
// (start = line before the hunk for a pure add/delete).
function hunk_range(start: int, count: int) -> string {
    if (count == 1) {
        `${start}`
    } else {
        `${start},${count}`
    }
}

// LCS table, flat (n+1)*(m+1) row-major. Sides arrive capped (see header).
function lcs_table(a: string[], b: string[]) -> int[] {
    let n = a.length();
    let m = b.length();
    let w = m + 1;
    let t: int[] = [];
    let k = 0;
    while (k < (n + 1) * w) {
        t.push(0);
        k = k + 1
    }
    let i = 1;
    while (i <= n) {
        let j = 1;
        while (j <= m) {
            if ((a.at(i - 1) ?? "") == (b.at(j - 1) ?? "")) {
                t[i * w + j] = (t.at((i - 1) * w + (j - 1)) ?? 0) + 1
            } else {
                let up = t.at((i - 1) * w + j) ?? 0;
                let left = t.at(i * w + (j - 1)) ?? 0;
                if (up >= left) {
                    t[i * w + j] = up
                } else {
                    t[i * w + j] = left
                }
            }
            j = j + 1
        }
        i = i + 1
    }
    t
}

class DiffOps {
    kinds: string[],
    old_idx: int[],
    new_idx: int[],
}

// Minimal edit script as parallel arrays ("=" | "-" | "+"; 0-based line
// indices, -1 for the absent side). Backtrack order is consistent with
// lcs_table's up-on-tie fill so the script stays minimal.
function diff_ops(a: string[], b: string[]) -> DiffOps {
    let n = a.length();
    let m = b.length();
    let w = m + 1;
    let t = lcs_table(a, b);
    let kinds: string[] = [];
    let oi: int[] = [];
    let ni: int[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && (a.at(i - 1) ?? "") == (b.at(j - 1) ?? "")) {
            kinds.push("=");
            oi.push(i - 1);
            ni.push(j - 1);
            i = i - 1;
            j = j - 1
        } else if (j > 0 && (i == 0 || (t.at(i * w + (j - 1)) ?? 0) >= (t.at((i - 1) * w + j) ?? 0))) {
            kinds.push("+");
            oi.push(-1);
            ni.push(j - 1);
            j = j - 1
        } else {
            kinds.push("-");
            oi.push(i - 1);
            ni.push(-1);
            i = i - 1
        }
    }
    // Backtrack yields reverse order; re-read back-to-front into forward order.
    let fk: string[] = [];
    let fo: int[] = [];
    let fn: int[] = [];
    let r = kinds.length() - 1;
    while (r >= 0) {
        fk.push(kinds.at(r) ?? "=");
        fo.push(oi.at(r) ?? -1);
        fn.push(ni.at(r) ?? -1);
        r = r - 1
    }
    DiffOps { kinds: fk, old_idx: fo, new_idx: fn }
}

// Git-style unified diff: ---/+++ headers, @@ -s,c +s,c @@ hunks with
// tool_diff_context() context lines; change blocks separated by more than
// twice the context split into hunks. Identical sides are diffable with a
// one-line note (a no-op edit still reads as a no-op inline).
function unified_diff(path: string, before: string, after: string) -> string[] {
    let a = split_diff_lines(before);
    let b = split_diff_lines(after);
    let ops = diff_ops(a, b);
    let total = ops.kinds.length();
    let changes: int[] = [];
    let k = 0;
    while (k < total) {
        if ((ops.kinds.at(k) ?? "=") != "=") {
            changes.push(k)
        }
        k = k + 1
    }
    if (changes.length() == 0) {
        return [`(no changes: ${path})`];
    }
    let ctx = tool_diff_context();
    let out = [`--- a/${path}`, `+++ b/${path}`];
    // Hunk windows over op indices; a gap of > 2*ctx context ops splits.
    let g = 0;
    let grp_first = changes.at(0) ?? 0;
    while (g < changes.length()) {
        let grp_last = changes.at(g) ?? 0;
        let next = g + 1;
        if (next < changes.length() && ((changes.at(next) ?? 0) - grp_last - 1) <= 2 * ctx) {
            g = next;
            continue;
        }
        let ws = grp_first - ctx;
        if (ws < 0) {
            ws = 0
        }
        let we = grp_last + ctx;
        if (we > total - 1) {
            we = total - 1
        }
        // Old/new ranges: consumed-before counts anchor pure-add/delete hunks.
        let old_before = 0;
        let old_count = 0;
        let new_before = 0;
        let new_count = 0;
        let q = 0;
        while (q < ws) {
            if ((ops.old_idx.at(q) ?? -1) != -1) {
                old_before = old_before + 1
            }
            if ((ops.new_idx.at(q) ?? -1) != -1) {
                new_before = new_before + 1
            }
            q = q + 1
        }
        q = ws;
        while (q <= we) {
            if ((ops.old_idx.at(q) ?? -1) != -1) {
                old_count = old_count + 1
            }
            if ((ops.new_idx.at(q) ?? -1) != -1) {
                new_count = new_count + 1
            }
            q = q + 1
        }
        let old_start = if (old_count == 0) {
            old_before
        } else {
            old_before + 1
        };
        let new_start = if (new_count == 0) {
            new_before
        } else {
            new_before + 1
        };
        out.push(`@@ -${hunk_range(old_start, old_count)} +${hunk_range(new_start, new_count)} @@`);
        q = ws;
        while (q <= we) {
            let kind = ops.kinds.at(q) ?? "=";
            if (kind == "-") {
                out.push(`-${a.at(ops.old_idx.at(q) ?? 0) ?? ""}`)
            } else if (kind == "+") {
                out.push(`+${b.at(ops.new_idx.at(q) ?? 0) ?? ""}`)
            } else {
                out.push(` ${a.at(ops.old_idx.at(q) ?? 0) ?? ""}`)
            }
            q = q + 1
        }
        g = next;
        if (next < changes.length()) {
            grp_first = changes.at(next) ?? 0
        }
    }
    out
}

// The transcript policy: edit/write with all three envelope sides present
// render as a diff; everything else (other tools, failures, unknown sides)
// is not diffable and yields no lines, so the host prints nothing extra.
function render_tool_diff(
    name: string,
    path: string?,
    before: string?,
    after: string?,
) -> ToolDiffView {
    let off = ToolDiffView { diffable: false, lines: [] };
    if (name != "edit" && name != "write") {
        off
    } else if (path is null || before is null || after is null) {
        off
    } else {
        let p = path ?? "";
        let bb = before ?? "";
        let ab = after ?? "";
        let a = split_diff_lines(bb);
        let b = split_diff_lines(ab);
        let cap = tool_diff_line_cap();
        if (a.length() > cap || b.length() > cap) {
            let head = [`--- a/${p}`, `+++ b/${p}`, `(diff omitted: ${a.length()} → ${b.length()} lines)`];
            let shown = 0;
            let k = 0;
            while (k < b.length() && shown < 100) {
                head.push(`+${b.at(k) ?? ""}`);
                shown = shown + 1;
                k = k + 1
            }
            if (k < b.length()) {
                head.push(`(… ${b.length() - k} more lines)`)
            }
            ToolDiffView { diffable: true, lines: head }
        } else {
            ToolDiffView { diffable: true, lines: unified_diff(p, bb, ab) }
        }
    }
}

test "unified_diff single-line change" {
    let d = unified_diff("f.txt", "a\nb\nc\n", "a\nB\nc\n");
    assert.equal(d, ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"])
}

test "unified_diff new file is all-add" {
    let d = unified_diff("new.txt", "", "x\ny\n");
    assert.equal(d, ["--- a/new.txt", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+x", "+y"])
}

test "unified_diff deleted file is all-remove" {
    let d = unified_diff("gone.txt", "x\ny\n", "");
    assert.equal(d, ["--- a/gone.txt", "+++ b/gone.txt", "@@ -1,2 +0,0 @@", "-x", "-y"])
}

test "unified_diff identical sides note no changes" {
    assert.equal(unified_diff("same.txt", "x\n", "x\n"), ["(no changes: same.txt)"])
}

test "unified_diff splits hunks past the context gap" {
    let before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n";
    let after = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nL11\nl12\n";
    let d = unified_diff("m.txt", before, after);
    assert.equal(
        d,
        [
            "--- a/m.txt",
            "+++ b/m.txt",
            "@@ -1,5 +1,5 @@",
            " l1",
            "-l2",
            "+L2",
            " l3",
            " l4",
            " l5",
            "@@ -8,5 +8,5 @@",
            " l8",
            " l9",
            " l10",
            "-l11",
            "+L11",
            " l12",
        ],
    )
}

test "unified_diff merges changes within the context gap" {
    let d = unified_diff(
        "m.txt",
        "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n",
        "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\n",
    );
    assert.equal(d.at(2) ?? "", "@@ -1,10 +1,10 @@");
    assert.equal(d.length(), 15)
}

test "render_tool_diff gates name and envelope sides" {
    assert.is_true(!render_tool_diff("bash", "f", "a\n", "b\n").diffable);
    assert.is_true(!render_tool_diff("read", "f", "a\n", "b\n").diffable);
    assert.is_true(!render_tool_diff("edit", null, "a\n", "b\n").diffable);
    assert.is_true(!render_tool_diff("edit", "f", null, "b\n").diffable);
    assert.is_true(!render_tool_diff("edit", "f", "a\n", null).diffable);
    assert.is_true(!render_tool_diff("write", "f", "a\n", null).diffable);
    assert.equal(render_tool_diff("bash", "f", "a\n", "b\n").lines.length(), 0);
    let v = render_tool_diff("edit", "f", "a\n", "b\n");
    assert.is_true(v.diffable);
    assert.equal(v.lines, ["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b"]);
    let w = render_tool_diff("write", "n.txt", "", "x\n");
    assert.is_true(w.diffable);
    assert.equal(w.lines.at(2) ?? "", "@@ -0,0 +1 @@");
    let same = render_tool_diff("edit", "s.txt", "x\n", "x\n");
    assert.is_true(same.diffable);
    assert.equal(same.lines, ["(no changes: s.txt)"])
}

test "render_tool_diff omits oversized sides without the LCS table" {
    let after = "";
    let k = 0;
    while (k < 310) {
        after = `${after}line${k.to_string()}\n`;
        k = k + 1
    }
    let v = render_tool_diff("edit", "big.txt", "seed\n", after);
    assert.is_true(v.diffable);
    assert.equal(v.lines.at(0) ?? "", "--- a/big.txt");
    assert.equal(v.lines.at(2) ?? "", "(diff omitted: 1 → 310 lines)");
    assert.equal(v.lines.at(3) ?? "", "+line0");
    assert.equal(v.lines.length(), 104);
    assert.equal(v.lines.at(103) ?? "", "(… 210 more lines)")
}

// ── bi#27 remainder: summary blocks, skill blocks, mermaid, working-state, images ──
// pi renders branch/compaction/skill transcript blocks collapsed (one line +
// expand hint) or expanded (header + markdown body). BAML owns the shaped
// text; the host prints collapsed lines with console.log and expanded bodies
// through the markdown path (see src/summary-blocks.ts). The expand hint is
// host keybinding text, so it arrives as a parameter — BAML never invents it.
// Theme null/none (pipes) stays byte-clean via style_segment passthrough.

// Branch block (bi#88): names the parent id, kept message count, and new id
// in both arms — the transcript records the branch point either way.
function format_branch_block(
    summary: string,
    from_id: string,
    new_id: string,
    kept_messages: int,
    expanded: bool,
    expand_hint: string,
    theme: string? = null,
) -> string {
    let head = `[branch] ${new_id} from ${from_id} · ${kept_messages} messages`;
    if (expanded) {
        `${style_segment(head, "accent", theme)}\n**Branch Summary**\n\n${summary}`
    } else {
        `${style_segment(head, "accent", theme)} (${expand_hint} to expand)`
    }
}

// Compaction block (bi#97): folded-turn count, token range, and reclaimed
// tokens in both arms — the transcript shows a compaction happened and what
// it kept. Reclaimed clamps at zero: estimate noise can leave the post-cut
// total above the pre-cut one, and a negative "reclaimed" would lie.
function format_compaction_block(
    summary: string,
    tokens_before: int,
    tokens_after: int,
    folded_turns: int,
    expanded: bool,
    expand_hint: string,
    theme: string? = null,
) -> string {
    let raw = tokens_before - tokens_after;
    let reclaimed = if (raw < 0) {
        0
    } else {
        raw
    };
    let head = `[compaction] compacted ${tokens_before}→${tokens_after} tokens · ${folded_turns} turns folded · ${reclaimed} reclaimed`;
    if (expanded) {
        `${style_segment(head, "accent", theme)}\n**Compacted ${tokens_before}→${tokens_after} tokens (${reclaimed} reclaimed)**\n\n${summary}`
    } else {
        `${style_segment(head, "accent", theme)} (${expand_hint} to expand)`
    }
}

class SkillBlock {
    name: string,
    location: string,
    content: string,
    user_message: string?,
}

// pi's skill envelope exactly: `<skill name=".." location="..">\n..\n</skill>`
// with an optional trailing `\n\n<user message>`. Anything else is not a
// skill block (null) — the transcript prints such text as plain markdown.
function parse_skill_block(text: string) -> SkillBlock? {
    let open = "<skill name=\"";
    if (!text.starts_with(open)) {
        null
    } else {
        let r1 = text.slice(open.length(), text.length());
        match (r1.index_of("\" location=\"")) {
            null => null,
            let q1: int => {
                let name = r1.slice(0, q1);
                let r2 = r1.slice(q1 + "\" location=\"".length(), r1.length());
                match (r2.index_of("\">\n")) {
                    null => null,
                    let q2: int => {
                        let location = r2.slice(0, q2);
                        let r3 = r2.slice(q2 + "\">\n".length(), r2.length());
                        match (r3.index_of("\n</skill>")) {
                            null => null,
                            let q3: int => {
                                let content = r3.slice(0, q3);
                                let tail = r3.slice(q3 + "\n</skill>".length(), r3.length());
                                if (name == "" || location == "") {
                                    null
                                } else if (tail == "") {
                                    SkillBlock {
                                        name: name,
                                        location: location,
                                        content: content,
                                        user_message: null,
                                    }
                                } else if (tail.starts_with("\n\n")) {
                                    let msg = tail.slice(2, tail.length()).trim();
                                    if (msg == "") {
                                        SkillBlock {
                                            name: name,
                                            location: location,
                                            content: content,
                                            user_message: null,
                                        }
                                    } else {
                                        SkillBlock {
                                            name: name,
                                            location: location,
                                            content: content,
                                            user_message: msg,
                                        }
                                    }
                                } else {
                                    null
                                }
                            },
                        }
                    },
                }
            },
        }
    }
}

// Skill block (bi#98): collapsed names the skill, expanded adds its content;
// a trailing user message rides along verbatim in both arms when present.
function format_skill_block(
    name: string,
    content: string,
    user_message: string?,
    expanded: bool,
    expand_hint: string,
    theme: string? = null,
) -> string {
    let head = `[skill] ${name}`;
    let tail = match (user_message) {
        null => "",
        let m: string => `\n${m}`,
    };
    if (expanded) {
        `${style_segment(head, "accent", theme)}\n**${name}**\n\n${content}${tail}`
    } else {
        `${style_segment(head, "accent", theme)} (${expand_hint} to expand)${tail}`
    }
}

// First whitespace-delimited token of a fence info string ("mermaid graph"
// -> "mermaid"). pi lowercases; BAML 0.17.0 has no case conversion, so the
// three casings authors actually write compare explicitly below.
function fence_first_token(lang: string) -> string {
    let t = lang.trim();
    match (t.index_of(" ")) {
        null => t,
        let i: int => t.slice(0, i),
    }
}

function is_mermaid_fence(lang: string) -> bool {
    let tok = fence_first_token(lang);
    // Tabs separate info words too; a tab inside the token disqualifies the
    // fence rather than silently matching a prefix.
    match (tok.index_of("\t")) {
        null => tok == "mermaid" || tok == "Mermaid" || tok == "MERMAID",
        let tab: int => false,
    }
}

// Mermaid degrade (bi#99): no diagram renderer is vendored, so mermaid fences
// degrade to labeled raw text — the opener names the gap, the body stays
// byte-clean. width caps raw rows (truncate_chars + …); width <= 0 skips the
// cap. Non-mermaid fences never reach here — the markdown walker filters.
function shape_mermaid_block(code: string, width: int, theme: string? = null) -> string[] {
    let opener = style_segment("··· mermaid (diagram not rendered on this terminal)", "dim", theme);
    let closer = style_segment("···", "dim", theme);
    let out = [opener];
    for (let line in split_diff_lines(code)) {
        if (width > 0 && line.length() > width) {
            out.push(truncate_chars(line, width))
        } else {
            out.push(line)
        }
    }
    out.push(closer);
    out
}

// Working-state labels (bi#96): BAML owns the text, the host owns the tick.
// The cancel hint is host keybinding text (null omits it). kind "working"
// carries the caller's own label through; unknown kinds pass through as the
// raw kind — never an invented label, never empty.
function format_status_label(
    kind: string,
    label: string,
    attempt: int,
    max_attempts: int,
    delay_secs: int,
    reason: string,
    cancel_hint: string? = null,
) -> string {
    let hint = match (cancel_hint) {
        null => "",
        let h: string => ` (${h} to cancel)`,
    };
    if (kind == "working") {
        `${label}${hint}`
    } else if (kind == "retry") {
        `Retrying (${attempt}/${max_attempts}) in ${delay_secs}s...${hint}`
    } else if (kind == "compaction") {
        if (reason == "manual") {
            `Compacting context...${hint}`
        } else if (reason == "overflow") {
            `Context overflow detected, auto-compacting...${hint}`
        } else {
            `Auto-compacting...${hint}`
        }
    } else if (kind == "branchSummary") {
        `Summarizing branch...${hint}`
    } else {
        `${kind}${hint}`
    }
}

// Transcript image fallback (bi#70, display leg only): when the terminal has
// no graphics protocol (or stdout is a pipe) the transcript shows this dim
// placeholder instead of raw bytes. Protocol detection + emission are byte
// work in src/image-display.ts; the clipboard input path stays bi#32's.
function format_image_placeholder(label: string, theme: string? = null) -> string {
    style_segment(`[image: ${label}]`, "dim", theme)
}

test "branch block names parent, kept count, and new id" {
    let shut = format_branch_block("kept the plan", "s1", "s2", 12, false, "enter", theme = null);
    assert.equal(shut, "[branch] s2 from s1 · 12 messages (enter to expand)");
    let open = format_branch_block("kept the plan", "s1", "s2", 12, true, "enter", theme = null);
    assert.equal(open, "[branch] s2 from s1 · 12 messages\n**Branch Summary**\n\nkept the plan");
    assert.contains(
        format_branch_block("s", "a", "b", 1, true, "enter", theme = "default"),
        "Branch Summary",
    )
}

test "compaction block carries tokens, folded turns, and reclaimed" {
    let shut = format_compaction_block("did stuff", 48000, 12000, 7, false, "enter", theme = null);
    assert.equal(
        shut,
        "[compaction] compacted 48000→12000 tokens · 7 turns folded · 36000 reclaimed (enter to expand)",
    );
    let open = format_compaction_block("did stuff", 48000, 12000, 7, true, "enter", theme = null);
    assert.equal(
        open,
        "[compaction] compacted 48000→12000 tokens · 7 turns folded · 36000 reclaimed\n**Compacted 48000→12000 tokens (36000 reclaimed)**\n\ndid stuff",
    );
    // Estimate noise never prints a negative reclaimed count.
    assert.is_true(
        (
            format_compaction_block("s", 100, 200, 1, false, "enter", theme = null).index_of(
                "0 reclaimed",
            )
        )
            != null,
    )
}

test "skill blocks parse the pi envelope and shape both arms" {
    match (parse_skill_block("plain text")) {
        null => assert.is_true(true),
        let b: SkillBlock => assert.is_true(false),
    }
    match (parse_skill_block("<skill name=\"n\" location=\"l\">\nbody here\n</skill>")) {
        null => assert.is_true(false),
        let b: SkillBlock => {
            assert.equal(b.name, "n");
            assert.equal(b.location, "l");
            assert.equal(b.content, "body here");
            assert.is_true(b.user_message is null)
        },
    }
    match (parse_skill_block("<skill name=\"n\" location=\"l\">\nbody\n</skill>\n\nhello")) {
        null => assert.is_true(false),
        let b: SkillBlock => assert.equal(b.user_message ?? "", "hello"),
    }
    assert.is_true(parse_skill_block("<skill name=\"\" location=\"l\">\nbody\n</skill>") is null);
    assert.is_true(
        parse_skill_block("<skill name=\"n\" location=\"l\">\nbody\n</skill> trailing") is null,
    );
    assert.equal(
        format_skill_block("n", "body", null, false, "enter", theme = null),
        "[skill] n (enter to expand)",
    );
    assert.equal(
        format_skill_block("n", "body", "hello", true, "enter", theme = null),
        "[skill] n\n**n**\n\nbody\nhello",
    )
}

test "mermaid fences detect and degrade labeled" {
    assert.is_true(is_mermaid_fence("mermaid"));
    assert.is_true(is_mermaid_fence("mermaid graph TD"));
    assert.is_true(is_mermaid_fence("Mermaid"));
    assert.is_true(!is_mermaid_fence("ts"));
    assert.is_true(!is_mermaid_fence(""));
    assert.is_true(!is_mermaid_fence("mermaidish"));
    assert.equal(
        shape_mermaid_block("graph TD\nA-->B\n", 0, theme = null),
        ["··· mermaid (diagram not rendered on this terminal)", "graph TD", "A-->B", "···"],
    );
    assert.equal(shape_mermaid_block("0123456789", 4, theme = null).at(1) ?? "", "0123…");
    assert.equal(shape_mermaid_block("", 0, theme = null).length(), 2);
    // The pipe-path walker labels mermaid openers; other fences unchanged.
    assert.equal(
        render_markdown_text("```mermaid\ngraph TD\n```", theme = null),
        "··· mermaid (diagram not rendered on this terminal)\ngraph TD\n···",
    );
    assert.equal(render_markdown_text("```ts\nx\n```", theme = null), "··· ts\nx\n···")
}

test "working-state labels mirror pi wording" {
    assert.equal(
        format_status_label("working", "thinking", 0, 0, 0, "", cancel_hint = null),
        "thinking",
    );
    assert.equal(
        format_status_label("retry", "", 2, 5, 9, "", cancel_hint = "ctrl-c"),
        "Retrying (2/5) in 9s... (ctrl-c to cancel)",
    );
    assert.equal(
        format_status_label("retry", "", 1, 3, 2, "", cancel_hint = null),
        "Retrying (1/3) in 2s...",
    );
    assert.equal(
        format_status_label("compaction", "", 0, 0, 0, "manual", cancel_hint = "ctrl-c"),
        "Compacting context... (ctrl-c to cancel)",
    );
    assert.equal(
        format_status_label("compaction", "", 0, 0, 0, "threshold", cancel_hint = null),
        "Auto-compacting...",
    );
    assert.equal(
        format_status_label("compaction", "", 0, 0, 0, "overflow", cancel_hint = null),
        "Context overflow detected, auto-compacting...",
    );
    assert.equal(
        format_status_label("branchSummary", "", 0, 0, 0, "", cancel_hint = null),
        "Summarizing branch...",
    );
    assert.equal(format_status_label("mystery", "", 0, 0, 0, "", cancel_hint = null), "mystery")
}

test "image placeholder is dim-styled, byte-clean unthemed" {
    assert.equal(format_image_placeholder("cat.png", theme = null), "[image: cat.png]");
    assert.contains(format_image_placeholder("cat.png", theme = "default"), "[image: cat.png]");
    assert.is_true(
        format_image_placeholder("cat.png", theme = "default").length()
            > "[image: cat.png]".length(),
    )
}
