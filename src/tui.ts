// bi/src/tui.ts — host differential TUI, mirrors pi/packages/tui differential rendering
// BAML owns Component + diff_lines/visible_width/cursor_marker for baml test; host does TS rendering.
// This is minimal: renders BAIS ready + prompt, diffs lines (pi does ANSI differential).

const CURSOR_MARKER = "\x1b_pi:c\x07";

export class HostTui {
	private oldLines: string[] = [];
	private width: number;
	constructor(width = process.stdout.columns ?? 80) {
		this.width = width;
	}
	render(lines: string[]): void {
		// BAML diff_lines is pure; host could call it via baml_sdk, but for TUI we use TS diff
		const diff = lines.filter((l, i) => l !== this.oldLines[i]);
		if (diff.length > 0 || lines.length !== this.oldLines.length) {
			if (this.oldLines.length) process.stdout.write("\x1b[2J\x1b[H");
			for (const l of lines) process.stdout.write(l.replace(CURSOR_MARKER, "") + "\n");
		}
		this.oldLines = lines;
	}
	static visibleWidth(line: string): number {
		return line.replace(CURSOR_MARKER, "").length;
	}
}

export function renderReadyScreen(ready: { issue: { id: string; title: string } }[], width = 80): string[] {
	// host renders directly; BAML TextComponent + FocusableTextComponent stay as baml test doubles
	const header = "bi — ready BAIS";
	const lines = [header.slice(0, width)];
	for (const f of ready) lines.push(`${f.issue.id}  ${f.issue.title}`.slice(0, width));
	return lines;
}
