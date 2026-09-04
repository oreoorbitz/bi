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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Live turn status on stderr. While a turn runs there is no active readline
// editing, so an in-place updating line is safe: tick() rewrites the same
// line (\r + clear), stop() replaces it with the BAML-shaped final summary.
// Non-TTY stderr (pipes/CI) gets one plain line per event instead —
// control bytes in logs are never worth it.
export class HostStatus {
	private timer: ReturnType<typeof setInterval> | null = null;
	private startMs = 0;
	private tick = 0;
	private event = "";
	private label: string;
	private formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string;
	private formatSummary: (failed: boolean, detail: string, turns: number, messages: number, elapsedMs: number) => string;
	constructor(
		label: string,
		fns: {
			formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string;
			formatSummary: (failed: boolean, detail: string, turns: number, messages: number, elapsedMs: number) => string;
		},
	) {
		this.label = label;
		this.formatStatus = fns.formatStatus;
		this.formatSummary = fns.formatSummary;
	}
	private get tty(): boolean {
		return !!process.stderr.isTTY;
	}
	start(): void {
		this.startMs = Date.now();
		if (!this.tty) return;
		this.timer = setInterval(() => void this.paint(), 100);
		void this.paint();
	}
	onEvent(e: string): void {
		this.event = e;
		if (!this.tty) console.error(`[loop] ${e}`);
	}
	private elapsed(): number {
		return Date.now() - this.startMs;
	}
	private paint(): void {
		const line = this.formatStatus(SPINNER[this.tick % SPINNER.length], this.label, this.elapsed(), this.event);
		this.tick += 1;
		process.stderr.write(`\r\x1b[2K${line}`);
	}
	// Replaces the status line with the final summary. Counts come from the
	// caller (result.messages/turns); BAML shapes the text.
	stop(opts: { failed: boolean; detail: string; turns: number; messages: number }): void {
		const ms = this.elapsed();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		const line = this.formatSummary(opts.failed, opts.detail, opts.turns, opts.messages, ms);
		if (this.tty) process.stderr.write(`\r\x1b[2K${line}\n`);
		else console.error(`[bi] ${line}`);
	}
}
