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

function cursor_marker() -> string {
    "\x1b_pi:c\x07"
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

// Final line replacing the status: `✓ done · 3 turns · 6.1s` /
// `✗ TurnFailure <kind> · 2 turns · 6.1s`. Host passes counts, BAML shapes.
function format_turn_summary(
    failed: bool,
    detail: string,
    turns: int,
    messages: int,
    elapsed_ms: int,
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
    `${head} · ${tm} · ${mm} · ${format_elapsed(elapsed_ms)}`
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
