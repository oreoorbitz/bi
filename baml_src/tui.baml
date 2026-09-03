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
