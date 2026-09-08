// bi/src/paste-burst.ts — non-bracketed paste-burst guard (bi#154).
//
// Port of kimi-code `packages/pi-tui/src/paste-burst.ts` (commit
// `909162725`, "avoid submitting rapid multi-line paste bursts").
// Terminals that never send bracketed-paste markers deliver a paste as
// a rapid stream of plain characters followed by Enter; a bare Enter
// would otherwise submit the first line mid-paste and spray the rest
// as follow-up turns. This heuristic tracks consecutive printable
// chars arriving within 8ms; once 8+ arrive in a burst, an imminent
// Enter inserts a newline instead of submitting (plus a 120ms suppress
// window covering the paste's trailing newline).
//
// It never buffers characters — typed text inserts normally; it only
// decides Enter's meaning. Thresholds are byte-identical to upstream.
const PASTE_BURST_MIN_CHARS = 8;
const PASTE_BURST_CHAR_INTERVAL_MS = 8;
const PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS = 30;
const PASTE_ENTER_SUPPRESS_WINDOW_MS = 120;

/**
 * Detects non-bracketed paste bursts: a rapid stream of plain characters
 * followed by Enter, where a bare Enter would otherwise submit the draft.
 *
 * This is a heuristic fallback for terminals that do not surface bracketed
 * paste markers. It intentionally does not buffer characters; the editor still
 * inserts typed text normally, and this class only decides whether an imminent
 * Enter should insert a newline instead of submitting.
 */
export class PasteBurst {
	private lastPlainCharAt?: number;
	private consecutivePlainChars = 0;
	private activeUntil = 0;
	private enterSuppressUntil = 0;

	onPlainChar(now: number): void {
		if (this.lastPlainCharAt !== undefined && now - this.lastPlainCharAt <= PASTE_BURST_CHAR_INTERVAL_MS) {
			this.consecutivePlainChars++;
		} else {
			this.consecutivePlainChars = 1;
		}

		this.lastPlainCharAt = now;

		if (this.consecutivePlainChars >= PASTE_BURST_MIN_CHARS) {
			this.extendWindow(now);
		}
	}

	shouldInsertNewlineInsteadOfSubmit(now: number): boolean {
		if (now <= this.activeUntil || now <= this.enterSuppressUntil) {
			return true;
		}

		return (
			this.lastPlainCharAt !== undefined &&
			this.consecutivePlainChars >= PASTE_BURST_MIN_CHARS &&
			now - this.lastPlainCharAt <= PASTE_BURST_CHAR_INTERVAL_MS
		);
	}

	extendWindow(now: number): void {
		this.activeUntil = now + PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS;
		this.enterSuppressUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
	}

	reset(): void {
		this.lastPlainCharAt = undefined;
		this.consecutivePlainChars = 0;
		this.activeUntil = 0;
		this.enterSuppressUntil = 0;
	}
}
