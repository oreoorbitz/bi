// bi/baml_src/tui.baml — TUI component model, ported from pi/packages/tui
// vendor specs: bi/vendor/pi-tui.ts (1263) + pi/packages/tui/src/component types
// BAML owns pure Component interface + diff helpers + CURSOR_MARKER; host owns Terminal rendering.
// Inspired by pi's Component {render, handleInput, invalidate, focused} + differential logic.

class TuiState {
    width: int,
    height: int,
    focused: bool,
    version: int,
}

function tui_state_new(width: int, height: int) -> TuiState {
    TuiState { width: width, height: height, focused: false, version: 0 }
}

// Raw 0x1B/0x07 bytes (bi#76): BAML has no hex/unicode escape, so the
// marker below is bytes, not text. Must stay byte-equal to the host
// CURSOR_MARKER or HostTui never strips it (pinned by length test).
function cursor_marker() -> string {
    "_pi:c"
}

function visible_width(line: string) -> int {
    // BAML offloads ANSI stripping to host; here we just count chars (approx)
    // For static analysis we keep it simple: visible width == length ignoring cursor marker
    let marker = cursor_marker();
    line.replace_all(marker, "").length()
}

// Live turn status (host renders in place on stderr; BAML owns the text so
// the shape is pinned by baml test, not by eyeballing terminal output).
// elapsed_ms renders as 0.4s / 12s / 3m04s — compact, fixed shape.
function format_elapsed(elapsed_ms: int) -> string {
    if (elapsed_ms < 1000) {
        `${elapsed_ms}ms`
    } else if (elapsed_ms < 60000) {
        let whole = elapsed_ms / 1000;
        let frac = (elapsed_ms - whole * 1000) / 100;
        `${whole}.${frac}s`
    } else {
        let mins = elapsed_ms / 60000;
        let secs = (elapsed_ms - mins * 60000) / 1000;
        let pad = if (secs < 10) {
            "0"
        } else {
            ""
        };
        `${mins}m${pad}${secs}s`
    }
}

// `⠋ thinking · 4.2s · loop:Thinking` — spinner frame picked by the host,
// everything else pure here so the line shape is stable under test.
function format_status(spinner: string, label: string, elapsed_ms: int, event: string) -> string {
    let ev = if (event == "") {
        "…"
    } else {
        event
    };
    `${spinner} ${label} · ${format_elapsed(elapsed_ms)} · ${ev}`
}

// bi#191: live status event tail — a trailing window of the streaming
// assistant text, cut at a word boundary. A raw char cut leaves mid-word
// fragments (`…ve`) that glue to the status line and persist in scrollback
// when the row settles; an emphasis marker orphaned by the cut (`**` with
// no opener) reads as literal junk. Rules:
//  - text fits the window: verbatim, no ellipsis
//  - windowed: drop the partial leading word at the first space inside the
//    window, prepend a single `…` (content was actually dropped)
//  - no space in the window (one overlong token): hard cut + `…`
// Newlines flatten to spaces first — the event rides a single-row paint.
function strip_leading_marks(s: string) -> string {
    let out = s;
    while (out.starts_with("*") || out.starts_with("_") || out.starts_with("`")) {
        out = out.slice(1, out.length())
    }
    out
}

function status_event_tail(text: string, max_chars: int) -> string {
    let flat = text.replace_all("\n", " ").trim();
    if (max_chars <= 0) {
        ""
    } else if (flat.length() <= max_chars) {
        flat
    } else {
        let window = flat.slice(flat.length() - max_chars, flat.length());
        let cut = match (window.index_of(" ")) {
            null => window,
            let i: int => window.slice(i + 1, window.length()),
        };
        `…${strip_leading_marks(cut)}`
    }
}

// Final line replacing the status: `✓ done · 3 turns · 6.1s` /
// `✗ TurnFailure <kind> · 2 turns · 6.1s`. Host passes counts, BAML shapes.
// The whole line takes the good/bad role so the outcome reads at a glance;
// theme null/none (pipes) stays plain.
function format_turn_summary(
    failed: bool,
    detail: string,
    turns: int,
    messages: int,
    elapsed_ms: int,
    theme: string? = null,
) -> string {
    let head = if (failed) {
        `✗ ${detail}`
    } else {
        "✓ done"
    };
    let tm = if (turns == 1) {
        "1 turn"
    } else {
        `${turns} turns`
    };
    let mm = if (messages == 1) {
        "1 message"
    } else {
        `${messages} messages`
    };
    let line = `${head} · ${tm} · ${mm} · ${format_elapsed(elapsed_ms)}`;
    if (failed) {
        style_segment(line, "bad", theme)
    } else {
        style_segment(line, "good", theme)
    }
}

// Turn failure detail (the `TurnFailure <message>` line under the summary).
// Bad role by policy, not by host choice.
function format_turn_error(line: string, theme: string? = null) -> string {
    style_segment(line, "bad", theme)
}

// Faint full-width rule closing a REPL block (turn output, slash
// listings). Dim role so it structures without shouting; plain ───
// run on theme none/pipes. Width is terminal cells; <= 0 renders empty.
function render_divider(width: int, theme: string? = null) -> string {
    if (width <= 0) {
        ""
    } else {
        let rule = "";
        for (let i = 0; i < width; i += 1) {
            rule = `${rule}─`
        }
        style_segment(rule, "dim", theme)
    }
}

function diff_lines(old: string[], new_lines: string[]) -> string[] {
    // Pure diff helper: returns indices where lines differ (as strings of indices)
    // For BAML test: collect differing line numbers as strings
    let out: string[] = [];
    let n = if (old.length() > new_lines.length()) {
        old.length()
    } else {
        new_lines.length()
    };
    for (let i = 0; i < n; i += 1) {
        let a = if (i < old.length()) {
            old[i]
        } else {
            ""
        };
        let b = if (i < new_lines.length()) {
            new_lines[i]
        } else {
            ""
        };
        if (a != b) {
            out.push(i.to_string())
        }
    }
    out
}

// Select frame (bi#68): one frame for /model, /resume, /tree numbered
// lists. Rows arrive pre-shaped — each list keeps its own numbering so
// numeric picks resolve against the same text — and the cursor only
// highlights a row for display (arrow-key picks wait on the bi#69
// raw-mode layer). Out-of-range cursors clamp; every row is
// width-capped like the ready frame. Rendered through HostTui.
function render_select_frame(rows: string[], cursor: int, width: int) -> string[] {
    let at = if (rows.length() == 0) {
        0
    } else if (cursor < 0) {
        0
    } else if (cursor >= rows.length()) {
        rows.length() - 1
    } else {
        cursor
    };
    let out: string[] = [];
    let i = 0;
    for (let r in rows) {
        let mark = if (rows.length() > 0 && i == at) {
            ">"
        } else {
            " "
        };
        out.push(truncate_chars(`${mark} ${r}`, width));
        i = i + 1
    }
    out
}

// Ready frame: the startup block (header + ready BAIS rows), width-capped.
// First production frame from this file — renderReadyScreen's host-side
// version is deleted with this change, not kept in parallel.
class ReadyRow {
    id: string,
    title: string,
}

function render_ready_frame(rows: ReadyRow[], width: int) -> string[] {
    let out = [truncate_chars("bi — ready BAIS", width)];
    for (let r in rows) {
        out.push(truncate_chars(`${r.id}  ${r.title}`, width))
    }
    out
}

// bi#181: rounded editor box shapes (kimi custom-editor.ts:792-857
// mirror). The prompt label lives IN the top border; the input glyph is
// a bare `>` spliced at column 2 by the host (its render post-process
// guards the cursor cell — only literal spaces are overwritten).
function dash_run(n: int) -> string {
    let out = "";
    for (let i = 0; i < n; i += 1) {
        out = `${out}─`
    }
    out
}

// bi#201: the footer prompt is an invitation, not an odometer — plain
// `bi>` at every turn count (turns already read in the status line).
// The turn arg stays so call sites keep passing sess.turn unchanged.
function format_prompt_label(turn: int) -> string {
    "bi>"
}

function prompt_glyph() -> string {
    ">"
}

function editor_side_border() -> string {
    "│"
}

// Top border with the label spliced one space after the left corner.
// Falls back to a plain dash run when the label cannot fit (narrow
// terminal), and to bare corners at degenerate widths (kimi's
// length-1 guard).
function render_editor_top_border(label: string, width: int) -> string {
    if (width <= 1) {
        "╭"
    } else {
        let inner = width - 2;
        let tag = ` ${label} `;
        if (tag.length() + 1 <= inner) {
            `╭${tag}${dash_run(inner - tag.length())}╮`
        } else {
            `╭${dash_run(inner)}╮`
        }
    }
}

function render_editor_bottom_border(width: int) -> string {
    if (width <= 1) {
        "╰"
    } else {
        `╰${dash_run(width - 2)}╯`
    }
}

// bi#180: welcome entry frame (kimi welcome.ts:49-107 mirror) — a
// rounded primary-bordered box with logo, bold title, dim hint, and an
// aligned label column, rendered INSIDE repl() after the last startup
// modal hides. Narrow terminals (< 24 cols, kimi precedent) drop the
// box entirely. Theme roles: accent for border/logo/title (kimi
// primary), dim for hint/labels (kimi textDim) — bi#185 palette tokens
// swap here when they land.
class WelcomeInfo {
    directory: string,
    session: string,
    model: string,
    version: string,
}

function pad_end(text: string, n: int) -> string {
    let out = text;
    while (out.length() < n) {
        out = `${out} `
    }
    out
}

// One label row's content: padded name column (dim) + fitted value.
function welcome_label(name: string, value: string, text_w: int, theme: string?) -> string {
    let name_f = style_segment(pad_end(name, 11), "dim", theme);
    let value_f = pad_end(truncate_chars(value, text_w), text_w);
    `${name_f}${value_f}`
}

// One content row: │ + 2-pad + pre-fitted content + right-fill + │
// (kimi: innerWidth = safeWidth - 4, rightPad = innerWidth - vis).
function welcome_row(content: string, visible: int, inner: int) -> string {
    `│  ${content}${pad_end("", inner - visible)}│`
}

function render_welcome_frame(info: WelcomeInfo, width: int, theme: string? = null) -> string[] {
    let title = "Welcome to bi!";
    let hint = "Type / for commands · /help for help";
    if (width < 24) {
        // Truncate plain, style after — never cut inside an SGR span.
        [
            style_segment(truncate_chars(title, width), "accent", theme),
            style_segment(truncate_chars(hint, width), "dim", theme),
            truncate_chars(`Model: ${info.model}`, width),
        ]
    } else {
        let inner = width - 4;
        let logo_w = 7;
        // Field width for the label values (and the text column right of
        // the logo): the label column is the widest fixed content
        // (11 cells), so values get inner - 11 and the logo rows
        // right-fill the difference — every row is exactly `inner`
        // visible cells by construction; all width math is plain-text,
        // styling wraps pre-fitted fields and never shifts a column.
        let text_w = inner - 11;
        let logo0 = style_segment(pad_end("▐█▛█▛█▌", logo_w), "accent", theme);
        let logo1 = style_segment(pad_end("▐█████▌", logo_w), "accent", theme);
        let title_f = style_segment(pad_end(truncate_chars(title, text_w), text_w), "accent", theme);
        let hint_f = style_segment(pad_end(truncate_chars(hint, text_w), text_w), "dim", theme);
        let blank = pad_end("", inner);
        [
            style_segment(`╭${dash_run(width - 2)}╮`, "accent", theme),
            `│  ${blank}│`,
            welcome_row(`${logo0}  ${title_f}`, logo_w + 2 + text_w, inner),
            welcome_row(`${logo1}  ${hint_f}`, logo_w + 2 + text_w, inner),
            `│  ${blank}│`,
            welcome_row(welcome_label("Directory:", info.directory, text_w, theme), 11 + text_w, inner),
            welcome_row(welcome_label("Session:", info.session, text_w, theme), 11 + text_w, inner),
            welcome_row(welcome_label("Model:", info.model, text_w, theme), 11 + text_w, inner),
            welcome_row(welcome_label("Version:", info.version, text_w, theme), 11 + text_w, inner),
            `│  ${blank}│`,
            style_segment(`╰${dash_run(width - 2)}╯`, "accent", theme),
        ]
    }
}

interface Component {
    function render(self, width: int) -> string[] throws never
    function handle_input(self, data: string) -> void throws never
    function invalidate(self) -> void throws never
}

class TextComponent {
    text: string,
    implements Component {
        function render(self, width: int) -> string[] {
            // naive wrap at width
            if (self.text.length() <= width) {
                [self.text]
            } else {
                let out: string[] = [];
                let start = 0;
                while (start < self.text.length()) {
                    let end = start + width;
                    if (end > self.text.length()) {
                        end = self.text.length()
                    }
                    out.push(self.text.slice(start, end));
                    start = end
                }
                out
            }
        }
        function handle_input(self, data: string) -> void {
            // no-op
        }
        function invalidate(self) -> void {
            // no-op
        }
    }
}

class FocusableTextComponent {
    text: string,
    focused: bool,
    implements Component {
        function render(self, width: int) -> string[] {
            let base = TextComponent { text: self.text }.render(width);
            if (self.focused) {
                // emit CURSOR_MARKER at end of first line (host will position cursor)
                if (base.length() > 0) {
                    base[0] = base[0] + cursor_marker()
                }
                base
            } else {
                base
            }
        }
        function handle_input(self, data: string) -> void {
            // no-op
        }
        function invalidate(self) -> void {
            // no-op
        }
    }
}
