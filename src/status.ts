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

// Minimal display contract for deep-loop reporters (retry/compaction).
// They only signal state; KindStatus owns the label + repaint.
export interface StatusSink {
	showWorking(): void;
	showRetry(attempt: number, maxAttempts: number, delaySecs: number): void;
	showCompaction(reason: CompactionReason): void;
	showBranchSummary(): void;
}

let activeSink: StatusSink | null = null;
export function setActiveStatus(s: StatusSink | null): void {
	activeSink = s;
}
export function activeStatus(): StatusSink | null {
	return activeSink;
}

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
	private tick = 0;
	private event = "";
	private state: StatusState;
	private label: string;
	private cancelHint: string | null;
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
	start(): void {
		// Every turn starts working + owns the sink; a stale kind from a
		// previous turn can never survive into this one.
		this.state = defaultStatusState(this.state.label);
		this.refresh();
		this.startMs = Date.now();
		setActiveStatus(this);
		if (!this.tty) return;
		this.timer = setInterval(() => void this.paint(), 100);
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
		return Date.now() - this.startMs;
	}
	private paint(): void {
		const line = paintStatusLine(spinnerFor(this.state.kind, this.tick), this.label, this.elapsed(), this.event, this.formatStatus);
		this.tick += 1;
		process.stderr.write(`\r\x1b[2K${clampStatusLine(line)}`);
	}
	// Replaces the status line with the final summary (same shape as
	// HostStatus.stop), then resets to working and releases the sink so
	// retry/compaction reporters from this turn go nowhere afterwards.
	stop(opts: { failed: boolean; detail: string; turns: number; messages: number; theme?: string | null }): void {
		const ms = this.elapsed();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		const line = this.formatSummary(opts.failed, opts.detail, opts.turns, opts.messages, ms, { theme: opts.theme ?? null });
		if (this.tty) process.stderr.write(`\r\x1b[2K${line}\n`);
		else console.error(`[bi] ${line}`);
		if (activeStatus() === this) setActiveStatus(null);
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
