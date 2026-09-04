// bi/baml_src/render.baml — message shaping policy (bi#27).
// BAML owns markdown→terminal-text transforms + tool status lines; the
// host prints the shaped lines (ANSI/color arrives with bi#33 themes).
// Deliberately no syntax highlighting or width-aware layout here — plain
// readable text that survives pipes and narrow terminals.

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
        } else if ((c == "*" && i + 1 < cs.length() && cs.at(i + 1) == "*") || (c == "_" && i + 1 < cs.length() && cs.at(i + 1) == "_")) {
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
        if (hashes >= 1 && hashes <= 6 && hashes < line.length() && line.slice(hashes, hashes + 1) == " ") {
            style_segment(render_inline(line.slice(hashes + 1, line.length())), "accent", theme)
        } else {
            render_inline(line)
        }
    }
}

// Full message: code fences pass through with ··· delimiters (lang kept
// on the opener), prose lines render. Trailing-newline shape preserved.
function render_markdown_text(text: string, theme: string? = null) -> string {
    let lines = text.split("\n");
    let out = "";
    let in_fence = false;
    for (let line in lines) {
        let rendered = if (line.slice(0, 3) == "```") {
            in_fence = !in_fence;
            let lang = line.slice(3, line.length()).trim();
            if (lang.length() > 0 && in_fence) {
                style_segment(`··· ${lang}`, "dim", theme)
            } else {
                style_segment("···", "dim", theme)
            }
        } else if (in_fence) {
            line
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

function format_tool_done(name: string, output: string, failed: bool, theme: string? = null) -> string {
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
    assert.is_true(format_tool_done("bash", "ok", false, theme = "default").length() > "✓ bash · 2 chars".length());
    assert.is_true(!render_markdown_text("# T\n```py\nx\n```", theme = "default").includes("```"))
}

test "tool status lines name call and outcome" {
    assert.equal(format_tool_start("bash", "{\"cmd\":\"ls -la /tmp\"}"), "◌ bash — {\"cmd\":\"ls -la /tmp\"}");
    assert.equal(format_tool_done("bash", "a\nb\n", false), "✓ bash · 4 chars");
    assert.equal(format_tool_done("bash", "exit 1\ntraceback here", true), "✗ bash — exit 1");
    assert.equal(truncate_chars("abcdef", 3), "abc…");
    assert.equal(first_line("one\ntwo"), "one")
}
