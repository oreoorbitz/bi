// bi/src/countdown.ts — shared countdown tick source for dialogs (bi#95).
//
// Port of pi's CountdownTimer
// (packages/coding-agent/src/modes/interactive/components/countdown-timer.ts):
// the one tick source for dialog expiry — device-code windows (bi#94 login),
// retry countdowns, cancel-safe cleanup. Consumers must NOT hand-roll their
// own setInterval; construct one CountdownTimer per timed dialog.
//
// Standing split: the host owns the tick source (setInterval, expiry,
// disposal); BAML owns second-formatting (baml_src/countdown.baml —
// format_countdown/countdown_title/countdown_retry_message). Tick callbacks
// receive raw whole seconds; the `countdown_label` / `countdown_retry_text`
// helpers below apply the BAML shapers.
//
// Semantics (pi-identical):
// - remaining starts at ceil(timeoutMs / 1000); onTick fires immediately
//   with that value, then once per second with the decremented value.
// - At <= 0 the timer disposes itself BEFORE calling onExpire, so expire
//   fires exactly once and never refires.
// - dispose() is idempotent; unmount (Esc/cancel/success) must always call
//   it — otherwise the interval keeps ticking after the dialog is gone.
// - timeoutMs <= 0 behaves as pi does: immediate onTick(<= 0), expiry on
//   the first 1s tick. Display clamps negatives via format_countdown.

import { countdown_retry_message, countdown_title, format_countdown } from "../baml_sdk/index.js";

// Structural render target — pi passes its concrete TUI for requestRender;
// anything with that method works, so tests pass a stub and bi#94 passes
// the real TUI without this module importing widget code.
export interface CountdownRenderTarget {
	requestRender(): void;
}

export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds: number;
	private readonly target: CountdownRenderTarget | undefined;
	private readonly onTick: (seconds: number) => void;
	private readonly onExpire: () => void;

	constructor(
		timeoutMs: number,
		target: CountdownRenderTarget | undefined,
		onTick: (seconds: number) => void,
		onExpire: () => void,
	) {
		this.target = target;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.onTick(this.remainingSeconds);

		this.intervalId = setInterval(() => {
			this.remainingSeconds--;
			this.onTick(this.remainingSeconds);
			this.target?.requestRender();

			if (this.remainingSeconds <= 0) {
				this.dispose();
				this.onExpire();
			}
		}, 1000);
	}

	remaining(): number {
		return this.remainingSeconds;
	}

	// True once the interval is gone — after expiry or dispose().
	get settled(): boolean {
		return this.intervalId === undefined;
	}

	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}

// Dialog title for a tick: `Sign in (7s)`. Fractional/negative input is
// ceiling-clamped to whole non-negative seconds before shaping.
export function countdown_label(base: string, seconds: number): string {
	return countdown_title(base, Math.max(0, Math.ceil(seconds)));
}

// Retry line for a tick: `Retrying (1/3) in 7s...`.
export function countdown_retry_text(attempt: number, maxAttempts: number, seconds: number): string {
	return countdown_retry_message(attempt, maxAttempts, Math.max(0, Math.ceil(seconds)));
}

// Bare duration for a tick: `7s`.
export function format_countdown_text(seconds: number): string {
	return format_countdown(Math.max(0, Math.ceil(seconds)));
}
