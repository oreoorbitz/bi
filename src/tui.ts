// bi/src/tui.ts — host differential TUI, mirrors pi/packages/tui differential rendering
// BAML owns Component + diff_lines/visible_width/cursor_marker for baml test; host does TS rendering.
// This is minimal: renders BAIS ready + prompt, diffs lines (pi does ANSI differential).
import { render_divider_async, render_select_frame_async } from "../baml_sdk/index.js";

const CURSOR_MARKER = "\x1b_pi:c\x07";

export class HostTui {
	private oldLines: string[] = [];
	private width: number;
	private write: (s: string) => void;
	constructor(width = process.stdout.columns ?? 80, write: (s: string) => void = (s) => process.stdout.write(s)) {
		this.width = width;
		this.write = write;
	}
	render(lines: string[]): void {
		// Differential repaints, pi-TUI spec: first render streams rows
		// (cursor ends below the frame); same-count repaints restore to
		// below-frame, step up, and rewrite CHANGED rows only, then
		// restore — no full clear, no scroll creep (no net newlines).
		// Frames must arrive width-capped (BAML frames are); a row wider
		// than the terminal wraps and misaligns the region. Count
		// changes still full-clear (rare; startup-shaped usage).
		const clean = lines.map((l) => l.replace(CURSOR_MARKER, ""));
		if (this.oldLines.length === 0) {
			for (const l of clean) this.write(l + "\n");
		} else if (clean.length !== this.oldLines.length) {
			this.write("\x1b[2J\x1b[H");
			for (const l of clean) this.write(l + "\n");
		} else {
			this.write("\x1b[s");
			this.write(`\x1b[${clean.length}A`);
			for (let i = 0; i < clean.length; i++) {
				if (clean[i] !== this.oldLines[i]) this.write(`\r\x1b[2K${clean[i]}`);
				if (i < clean.length - 1) this.write("\n");
			}
			this.write("\x1b[u");
		}
		this.oldLines = clean;
	}
	static visibleWidth(line: string): number {
		return line.replace(CURSOR_MARKER, "").length;
	}
}

// Select-list frame (bi#68): the one host path for /model, /resume,
// /tree listings. BAML owns rows + cursor + width shaping; the host
// only splits the shaped text and diffs the frame through HostTui.
// Picks stay numeric — the cursor index is display state until the
// bi#69 raw-mode layer. A BAML-shaped divider closes the block on
// stdout so the next prompt doesn't crowd the list.
export async function renderSelectList(text: string, cursor: number, width?: number, theme?: string | null): Promise<void> {
	const w = width ?? process.stdout.columns ?? 80;
	const rows = text.split("\n").filter((l) => l.length > 0);
	new HostTui(w).render(await render_select_frame_async(rows, cursor, w));
	process.stdout.write((await render_divider_async(w, { theme: theme ?? null })) + "\n");
}
// Pinned bottom-row footer (bi#67). BAML owns the frame line
// (render_footer_frame, width-capped to one row); the host owns the
// scroll region + repaint. DECSTBM reserves the last row, so turn output
// scrolls above the footer instead of pushing it away.
//
// Readline coexistence: repaints happen only between turns (no active
// question pending), save the cursor, address the footer row absolutely,
// and restore — readline's in-progress line is never touched. Row N is
// only ever addressed by HostFooter (region scrolling cannot reach it),
// which is what makes the differential skip sound. Pipes and degenerate
// screens fall back to a plain printed line, byte-identical to the
// pre-footer console.error readout.
export class HostFooter {
	private installedRows = 0;
	private lastLine: string | null = null;
	constructor(
		private dims: () => { rows: number; cols: number } = () => ({
			rows: process.stdout.rows ?? 0,
			cols: process.stdout.columns ?? 80,
		}),
		private tty: () => boolean = () => !!process.stdout.isTTY && !!process.stderr.isTTY,
		private write: (s: string) => void = (s) => process.stderr.write(s),
	) {}
	// Paints the BAML-shaped frame row; fallback is the plain printed
	// footer for pipes (byte-identical to the old readout). Differential:
	// an unchanged line on an unchanged screen writes zero bytes. A
	// resize reinstalls the region and repaints even when the text matches.
	show(frame: string, fallback: string): void {
		const { rows } = this.dims();
		if (!this.tty() || rows < 2) {
			this.reset();
			this.write(fallback + "\n");
			return;
		}
		if (this.installedRows !== rows) this.install(rows, frame);
		else if (this.lastLine !== frame) this.paint(rows, frame);
	}
	// Tears down the region and erases the footer row; silent when the
	// region was never installed (pipes stay escape-free).
	dispose(): void {
		this.reset();
	}
	private install(rows: number, frame: string): void {
		// DECSTBM homes the cursor, so save first; paint the footer row,
		// then restore — the transcript cursor never moves.
		this.write("\x1b[s");
		this.write(`\x1b[1;${rows - 1}r`);
		this.paintBody(rows, frame);
		this.write("\x1b[u");
		this.installedRows = rows;
		this.lastLine = frame;
	}
	private paint(rows: number, frame: string): void {
		this.write("\x1b[s");
		this.paintBody(rows, frame);
		this.write("\x1b[u");
		this.lastLine = frame;
	}
	private paintBody(rows: number, frame: string): void {
		this.write(`\x1b[${rows};1H\x1b[2K${frame}`);
	}
	private reset(): void {
		if (this.installedRows === 0) return;
		this.write("\x1b[s");
		this.write("\x1b[r");
		this.write(`\x1b[${this.installedRows};1H\x1b[2K`);
		this.write("\x1b[u");
		this.installedRows = 0;
		this.lastLine = null;
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
	private formatSummary: (failed: boolean, detail: string, turns: number, messages: number, elapsedMs: number, $opts?: { theme?: string | null }) => string;
	constructor(
		label: string,
		fns: {
			formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string;
			formatSummary: (failed: boolean, detail: string, turns: number, messages: number, elapsedMs: number, $opts?: { theme?: string | null }) => string;
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
	// caller (result.messages/turns); BAML shapes the text and owns the
	// good/bad role via the theme. The caller closes the block with a
	// divider after any trailing detail lines print.
	stop(opts: { failed: boolean; detail: string; turns: number; messages: number; theme?: string | null }): void {
		const ms = this.elapsed();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		const line = this.formatSummary(opts.failed, opts.detail, opts.turns, opts.messages, ms, { theme: opts.theme ?? null });
		if (this.tty) process.stderr.write(`\r\x1b[2K${line}\n`);
		else console.error(`[bi] ${line}`);
	}
}
