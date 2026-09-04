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
