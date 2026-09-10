// bi/src/status.ts — working-state indicator kinds (bi#96).
//
// Pi's StatusIndicator distinguishes working, retry, compaction, and
// branchSummary loader states with distinct spinner+message styling. This
// module wires those kinds into bi's status path end to end:
//
//   state (StatusState) -> label (BAML format_status_label, read-only) ->
//   display (KindStatus paint loop, host-owned tick)
//
// BAML owns every shaped string (resolveStatusLabel delegates to the
// sibling's format_status_label; the host never concatenates status text).
// The host owns the tick: per-kind spinner frames plus the repaint timer.
//
// KindStatus mirrors HostStatus's public surface (start/onEvent/stop) so the
// cli turn needs only a constructor swap. It is standalone rather than a
// HostStatus subclass: HostStatus has no label-mutation hook and its timer
// fields are private, so kind state lives here; line shaping still
// delegates to the same BAML formatStatus/formatSummary fns.
//
// Ambient sink: retry (bi#16) and compaction (bi#11) run deep inside the
// agent loop where the turn's status object is not threaded. They report
// through the module-level sink instead (set by KindStatus.start, cleared
// by KindStatus.stop). Reporters no-op when no turn is active, and stop()
// always resets to working + unregisters — states never leak across turns.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { format_status_label, status_event_tail } from "../baml_sdk/index.js";
import { CHROME_RESET, chromeAnsi } from "./theme-files.js";

export type StatusKind = "working" | "retry" | "compaction" | "branchSummary";
export const STATUS_KINDS: StatusKind[] = ["working", "retry", "compaction", "branchSummary"];

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface StatusState {
	kind: StatusKind;
	// Working passthrough label (e.g. "thinking"); other kinds shape their
	// own text and ignore this.
	label: string;
	attempt: number;
	maxAttempts: number;
	delaySecs: number;
	reason: string;
}

export function defaultStatusState(label: string): StatusState {
	return { kind: "working", label, attempt: 0, maxAttempts: 0, delaySecs: 0, reason: "" };
}

// Distinct spinner frames per kind — the host-owned half of the styling.
// Working keeps the braille set HostStatus uses; the other kinds pick
// visually distinct cycles so a retry storm or background compaction reads
// differently from normal work at a glance.
export const STATUS_SPINNERS: Record<StatusKind, string[]> = {
	working: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	retry: ["◐", "◓", "◑", "◒"],
	compaction: ["▁", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃"],
	branchSummary: ["✶", "✸", "✹", "✺", "✹", "✸"],
};

export function spinnerFor(kind: StatusKind, tick: number): string {
	const frames = STATUS_SPINNERS[kind] ?? STATUS_SPINNERS.working;
	return frames[tick % frames.length];
}

// Host keybinding text for the BAML cancel hint (pi: keyText("app.interrupt")).
export const STATUS_CANCEL_HINT = "ctrl-c";

// BAML owns the text: every kind label goes through format_status_label.
// Synchronous — the shaping fn is pure, so the paint loop stays sync.
export function resolveStatusLabel(state: StatusState, cancelHint: string | null = STATUS_CANCEL_HINT): string {
	return format_status_label(state.kind, state.label, state.attempt, state.maxAttempts, state.delaySecs, state.reason, {
		cancel_hint: cancelHint,
	});
}

// bi#206: footer status-row sink. When a footer has an open status row
// (TTY, installed), KindStatus ticks + the completion summary paint
// into the footer region instead of stderr. Every other path (pipes,
// uninstalled/fullscreen footer, frozen-then-resumed ticks) keeps
// today's stderr bytes. Structural on purpose: drills fake it, and
// neither direction imports the other (no tui <-> status cycle).
export interface StatusRowSink {
	openStatusRow(echoRows: number): void;
	// True when the line reached the status row (differential: an
	// unchanged line writes zero bytes). False when no row is open —
	// the caller falls back to the legacy relative paint.
	paintStatusRow(line: string): boolean;
	// True when the summary replaced the row in place, then parked
	// below the block (summary + 3 newlines: hug lands on empty rows,
	// a bottom-touching block scrolls once with fossils intact).
	// False → legacy.
	commitStatusRow(summary: string): boolean;
	clearStatusRow(): void;
	statusRowActive(): boolean;
}

// Minimal display contract for deep-loop reporters (retry/compaction).
// They only signal state; KindStatus owns the label + repaint.
export interface StatusSink {
	showWorking(): void;
	showRetry(attempt: number, maxAttempts: number, delaySecs: number): void;
	showCompaction(reason: CompactionReason): void;
	showBranchSummary(): void;
	// bi#218: modal freeze. While a modal awaits user input the tick
	// must stop (no motion without work) and the wait must not bill
	// as thinking; unfreeze resumes from the frozen elapsed.
	freeze(): void;
	unfreeze(): void;
}

let activeSink: StatusSink | null = null;
export function setActiveStatus(s: StatusSink | null): void {
	activeSink = s;
}
export function activeStatus(): StatusSink | null {
	return activeSink;
}

// bi#218: modal-scoped freeze helpers. The prompt layer (askApproval)
// freezes on open and unfreezes on resolve — no cli.ts touch. Null
// sink (no turn active, pipes) is a safe no-op.
export function freezeActiveStatus(): void {
	activeStatus()?.freeze();
}
export function unfreezeActiveStatus(): void {
	activeStatus()?.unfreeze();
}

// bi#218: the frozen-wait row. Painted INSIDE the modal frame (a plain
// Text row, no chrome so BI_THEME=none/NO_COLOR are byte-identical)
// because the status tick owns no screen rows while a modal is open —
// an out-of-band stderr write would sit on a modal row the differential
// renderer diffs equal and never repaints. Static text: the frozen
// clock ticks nothing, so no live seconds.
export const STATUS_WAITING_LINE = "· waiting on you — thinking timer paused";

// Convenience reporters so retry.ts / compaction.ts don't touch the
// registry shape. All no-op when no turn holds the display.
export function reportRetryWait(attempt: number, maxAttempts: number, delaySecs: number): void {
	activeSink?.showRetry(attempt, maxAttempts, delaySecs);
}
export function restoreWorkingStatus(): void {
	activeSink?.showWorking();
}

// bi#166: clamp painted status lines to the live stderr width. The tick
// rewrites one row (`\r` + clear); an unclamped overwide line wraps to a
// second row the next tick cannot clear, leaving permanent residue. pi-tui
// truncateToWidth is ANSI-aware (same helper Kimi's TruncatedText uses),
// so BAML-shaped color survives the cut. BAML formatStatus/formatSummary
// are untouched — truncation is host paint only. Degenerate widths
// (pipes report 0/undefined) skip the clamp; paint only runs on TTY anyway.
export function clampStatusLine(line: string, width?: number): string {
	const w = width ?? process.stderr.columns ?? 0;
	if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return line;
	return truncateToWidth(line, Math.floor(w));
}

// bi#193: status line chrome — the spinner glyph pops primary, the rest
// of the line (label · elapsed · event tail, kimi's "thinking blocks"
// shade) recedes text_dim. Host wraps known segments at paint time: the
// spinner is a host-owned format_status argument, so it is pre-wrapped
// primary and the dim open is re-closed around the whole line after.
// chromeAnsi/CHROME_RESET are "" / inert under BI_THEME=none and NO_COLOR,
// so the suppressed line is byte-identical to the unstyled one; paint
// only runs on a TTY, so pipes never reach here.
export function paintStatusLine(spinner: string, label: string, elapsedMs: number, event: string, formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string): string {
	const dim = chromeAnsi("text_dim");
	const primary = chromeAnsi("primary");
	const glyph = primary === "" ? spinner : `${primary}${spinner}${dim}`;
	const line = formatStatus(glyph, label, elapsedMs, event);
	return dim === "" ? line : `${dim}${line}${CHROME_RESET}`;
}

// Kind-aware turn status for stderr. Same contract as HostStatus: in-place
// spinner on TTY (tick rewrites the line, stop replaces it with the
// BAML-shaped summary), one plain line per event on pipes.
export class KindStatus implements StatusSink {
	private timer: ReturnType<typeof setInterval> | null = null;
	private startMs = 0;
	private running = false;
	private tick = 0;
	private event = "";
	// bi#218 freeze bookkeeping: depth nests (an outer modal still open
	// keeps the clock stopped when an inner wait releases); only the
	// outermost freeze/unfreeze pair stops/resumes the clock.
	private frozenDepth = 0;
	private frozenElapsed = 0;
	private state: StatusState;
	private label: string;
	private cancelHint: string | null;
	// bi#206: footer status-row sink (cli attaches the live footer per
	// turn). Null = legacy stderr path everywhere.
	private rowSink: StatusRowSink | null = null;
	private formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string;
	private formatSummary: (
		failed: boolean,
		detail: string,
		turns: number,
		messages: number,
		elapsedMs: number,
		$opts?: { theme?: string | null },
	) => string;
	constructor(
		label: string,
		fns: {
			formatStatus: (spinner: string, label: string, elapsedMs: number, event: string) => string;
			formatSummary: (
				failed: boolean,
				detail: string,
				turns: number,
				messages: number,
				elapsedMs: number,
				$opts?: { theme?: string | null },
			) => string;
		},
		opts?: { cancelHint?: string | null },
	) {
		this.state = defaultStatusState(label);
		this.label = "";
		this.cancelHint = opts?.cancelHint ?? STATUS_CANCEL_HINT;
		this.refresh();
		this.formatStatus = fns.formatStatus;
		this.formatSummary = fns.formatSummary;
	}
	get kind(): StatusKind {
		return this.state.kind;
	}
	// Current resolved display label (what the next paint shows).
	get statusLabel(): string {
		return this.label;
	}
	// bi#206: route ticks + summary through the footer status row.
	// Attached per turn by cli; stop() releases (no cross-turn leak
	// when an instance is reused).
	attachFooter(sink: StatusRowSink | null): void {
		this.rowSink = sink;
	}
	private refresh(): void {
		// Pi parity: the working message carries no cancel hint (the caller
		// owns that label verbatim); retry/compaction/branchSummary do.
		// The hint text itself stays host keybinding text; BAML shapes it.
		this.label = resolveStatusLabel(this.state, this.state.kind === "working" ? null : this.cancelHint);
	}
	showWorking(): void {
		this.state = { ...this.state, kind: "working" };
		this.refresh();
	}
	showRetry(attempt: number, maxAttempts: number, delaySecs: number): void {
		this.state = { ...this.state, kind: "retry", attempt, maxAttempts, delaySecs };
		this.refresh();
	}
	showCompaction(reason: CompactionReason): void {
		this.state = { ...this.state, kind: "compaction", reason };
		this.refresh();
	}
	showBranchSummary(): void {
		this.state = { ...this.state, kind: "branchSummary" };
		this.refresh();
	}
	private get tty(): boolean {
		return !!process.stderr.isTTY;
	}
	// bi#206: echoRows anchors the status row below the submitted
	// input echo (prompt home row + echo span) so the open never
	// paints over transcript. Default 1 keeps every existing caller
	// (drills, probes) on the single-line contract.
	start(echoRows = 1): void {
		// Every turn starts working + owns the sink; a stale kind from a
		// previous turn can never survive into this one.
		this.state = defaultStatusState(this.state.label);
		this.refresh();
		this.startMs = Date.now();
		this.running = true;
		// bi#218: a new turn owns its clock outright — no freeze leaks in.
		this.frozenDepth = 0;
		this.frozenElapsed = 0;
		setActiveStatus(this);
		if (!this.tty) return;
		this.timer = setInterval(() => void this.paint(), 100);
		// bi#206: open the footer row before the first tick; a footer
		// that refuses (pipes-guarded above, uninstalled/fullscreen
		// inside) leaves every paint on the legacy path.
		this.rowSink?.openStatusRow(Math.max(1, Math.floor(echoRows) || 1));
		void this.paint();
	}
	onEvent(e: string): void {
		this.event = e;
		if (!this.tty) console.error(`[loop] ${e}`);
	}
	// bi#191: frequent event updates (per-chunk stream tails) set the event
	// without the pipe fallback — one `[loop]` line per chunk would spam
	// logs. Loop lifecycle events keep onEvent's logging.
	setEvent(e: string): void {
		this.event = e;
	}
	private elapsed(): number {
		// bi#218: while frozen the clock stands still — time spent
		// waiting on the user is never billed as thinking.
		if (this.frozenDepth > 0) return this.frozenElapsed;
		return Date.now() - this.startMs;
	}
	// bi#218: freeze stops the interval outright (no out-of-band stderr
	// writes to fight the modal's differential renderer) and pins the
	// billed elapsed. Paints nothing — the modal frame carries the
	// waiting row (STATUS_WAITING_LINE).
	freeze(): void {
		// Pin the billed elapsed BEFORE arming the frozen branch —
		// elapsed() reads frozenElapsed once depth > 0, so reading it
		// after incrementing would bill zero (observed live: a 1s think
		// billed 0.001s).
		if (this.frozenDepth === 0) {
			if (this.running) this.frozenElapsed = Date.now() - this.startMs;
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = null;
			}
			// bi#206: the frozen text must not linger under the modal —
			// erase the row and close it. Ticks after unfreeze fall back
			// to the relative paint (no stale-row risk post-modal).
			this.rowSink?.clearStatusRow();
		}
		this.frozenDepth += 1;
	}
	// bi#218: outermost unfreeze shifts the start forward by the frozen
	// span (the wait evaporates from the bill) and resumes the tick.
	get frozen(): boolean {
		return this.frozenDepth > 0;
	}
	unfreeze(): void {
		// Stray unfreeze (no matching freeze) is a strict no-op — it
		// must never shift the clock (observed live: an unmatched
		// unfreeze reset startMs to now and billed ~0ms).
		if (this.frozenDepth === 0) return;
		this.frozenDepth -= 1;
		if (this.frozenDepth > 0) return;
		if (!this.running) return;
		this.startMs = Date.now() - this.frozenElapsed;
		this.frozenElapsed = 0;
		if (this.tty && this.timer === null) {
			this.timer = setInterval(() => void this.paint(), 100);
			void this.paint();
		}
	}
	private paint(): void {
		const line = paintStatusLine(spinnerFor(this.state.kind, this.tick), this.label, this.elapsed(), this.event, this.formatStatus);
		this.tick += 1;
		// bi#206: the sink paints into the footer row when one is open;
		// a refused paint (closed, uninstalled, post-freeze) falls
		// through to the legacy relative row. One clamp serves both:
		// stderr/stdout share the pty winsize, so the footer row and
		// the legacy row are the same width.
		if (this.tty && this.rowSink?.paintStatusRow(clampStatusLine(line))) return;
		process.stderr.write(`\r\x1b[2K${clampStatusLine(line)}`);
	}
	// Replaces the status line with the final summary (same shape as
	// HostStatus.stop), then resets to working and releases the sink so
	// retry/compaction reporters from this turn go nowhere afterwards.
	stop(opts: { failed: boolean; detail: string; turns: number; messages: number; theme?: string | null }): void {
		const ms = this.elapsed();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.running = false;
		// bi#218: the bill closes here — no freeze leaks out either.
		this.frozenDepth = 0;
		this.frozenElapsed = 0;
		const line = this.formatSummary(opts.failed, opts.detail, opts.turns, opts.messages, ms, { theme: opts.theme ?? null });
		// bi#206: the summary replaces the footer row in place (row +
		// newline, zero scroll — the row is never the bottom one).
		// Every refused commit keeps today's bytes exactly.
		if (!(this.tty && (this.rowSink?.commitStatusRow(line) ?? false))) {
			if (this.tty) process.stderr.write(`\r\x1b[2K${line}\n`);
			else console.error(`[bi] ${line}`);
		}
		if (activeStatus() === this) setActiveStatus(null);
		this.rowSink = null;
		this.state = defaultStatusState(this.state.label);
		this.refresh();
	}
}

// bi#191: accumulate stream deltas and mirror them into the status event as
// a word-boundary tail (BAML status_event_tail). Shared by the cli turn path
// and the drill so the drill pins the production wiring, not a copy. The
// draft never touches stderr as raw deltas: appended chunks shared the
// in-place status row, and wrapped upper rows settled into scrollback as
// mid-word debris (`…ve`, `…i#190**`).
export function statusEventTailUpdater(status: KindStatus, maxChars: number): (delta: string) => void {
	let shown = "";
	return (delta: string) => {
		shown += delta;
		status.setEvent(status_event_tail(shown, maxChars));
	};
}
