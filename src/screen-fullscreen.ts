// bi/src/screen-fullscreen.ts — BI_FULLSCREEN=1 alt-screen REPL shell (bi#160).
//
// Opt-in fullscreen: the REPL runs inside pi-tui's TuiAltScreen with a
// VStack root (primary follow-end ScrollView transcript above a docked
// prompt row + BAML-shaped footer), instead of readline line-mode over
// a DECSTBM footer. Unset flag or pipes: this module is never entered
// and the REPL is byte-identical to today.
//
// v1 scope (honest limits — see NOTES for the follow-up): line input
// stays readline (forced line-mode, hardware cursor kept visible), so
// the dock's prompt row mirrors the live prompt label rather than
// owning keystrokes; modal pickers (resume picker skipped) still open
// on the main-screen host — long-horizon prompt/turn loops are the
// supported surface.
import { ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, setKeybindings } from "@earendil-works/pi-tui";
import { currentKeybindingsManager } from "./keybindings.js";
import { chunkyLinkDrainIdleMs } from "./tui.js";

export const FULLSCREEN_ENV = "BI_FULLSCREEN";

// Gate: exact flag value plus a real TTY on both ends. Piped and
// --print invocations never enter (output unchanged); anything but
// "1" is today's REPL byte-for-byte.
export function fullscreenRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[FULLSCREEN_ENV] !== "1") return false;
	return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

export interface FullscreenRoot {
	root: VStack;
	scroll: ScrollView;
	transcript: Text;
	promptRow: Text;
	footer: Text;
}

// Layout root per acceptance: VStack holding a primary follow-end
// ScrollView (basis 0, grow 1) above a docked VStack with the prompt
// row and the BAML-shaped footer frame. The footer's minSize 1
// mirrors composeFullscreenFrame (tui.ts) — the drill proves the same
// allocateStackSizes contract keeps it at ≥1 row headlessly, while
// the pty half proves the live root pins the dock.
export function buildFullscreenRoot(): FullscreenRoot {
	const transcript = new Text("");
	const promptRow = new Text("");
	const footer = new Text("");
	const scroll = new ScrollView(transcript, { follow: "end", primary: true });
	const dock = new VStack([{ component: promptRow }, { component: footer, minSize: 1 }]);
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1 },
		{ component: dock, shrink: 0 },
	]);
	return { root, scroll, transcript, promptRow, footer };
}

// Transcript mirror cap: Text re-renders on every push, so unbounded
// growth would slow long swarm sessions. Oldest rows drop first
// (follow-end keeps the tail — the most recent turns survive).
export const MAX_TRANSCRIPT_LINES = 20000;

export class FullscreenSession {
	private term: ProcessTerminal | null = null;
	private ui: TuiAltScreen | null = null;
	private parts: FullscreenRoot | null = null;
	private lines: string[] = [];
	private lastPrompt = "";
	private lastFooter: string[] = [];
	private inLibraryWrite = false;

	// Reentrancy guard for the stdout/stderr tee: library frame bytes
	// must never land in the transcript mirror. Synchronous flag is
	// sound — term.write reaches the fd synchronously; only the render
	// scheduling is async.
	get inWrite(): boolean {
		return this.inLibraryWrite;
	}

	get scroll(): ScrollView | null {
		return this.parts?.scroll ?? null;
	}

	start(logDir: string): void {
		if (this.ui) return;
		// Library defaults plus validated ~/.bi overrides, same as
		// runModal — PgUp/PgDn/search bindings stay remappable.
		setKeybindings(currentKeybindingsManager());
		const term = new ProcessTerminal();
		const session = this;
		const origWrite = term.write.bind(term);
		term.write = (s: string) => {
			session.inLibraryWrite = true;
			try {
				origWrite(s);
			} finally {
				session.inLibraryWrite = false;
			}
		};
		// showHardwareCursor: readline still owns line editing on the
		// bottom row in v1, so the cursor stays visible for it. mouse:
		// wheel/drag scroll plus text selection per acceptance.
		const ui = new TuiAltScreen(term, true, logDir, { mouse: true });
		const parts = buildFullscreenRoot();
		ui.setLayoutRoot(parts.root);
		ui.start();
		this.term = term;
		this.ui = ui;
		this.parts = parts;
	}

	setPrompt(label: string): void {
		this.lastPrompt = label;
		this.parts?.promptRow.setText(label);
		this.ui?.requestRender();
	}

	setFooter(lines: string[]): void {
		this.lastFooter = [...lines];
		this.parts?.footer.setText(lines.join("\n"));
		this.ui?.requestRender();
	}

	pushLines(rows: string[]): void {
		if (rows.length === 0) return;
		this.lines.push(...rows);
		if (this.lines.length > MAX_TRANSCRIPT_LINES) {
			this.lines.splice(0, this.lines.length - MAX_TRANSCRIPT_LINES);
		}
		this.parts?.transcript.setText(this.lines.join("\n"));
		this.ui?.requestRender();
	}

	async stop(): Promise<void> {
		const ui = this.ui;
		const term = this.term;
		const lines = this.lines;
		const prompt = this.lastPrompt;
		const footer = this.lastFooter;
		this.ui = null;
		this.term = null;
		this.parts = null;
		this.lines = [];
		if (!ui || !term) return;
		// runModal discipline: drain stragglers, then stop with
		// preserveScreen (clean exit, no library replay).
		await term.drainInput(500, chunkyLinkDrainIdleMs());
		ui.stop({ preserveScreen: true });
		// Host replay: the library's own replay path re-renders the
		// layout root directly (VStack.render with unbounded height),
		// which sizes entry-option children to zero and drops the
		// ScrollView content (probed headlessly: object-form children
		// replay the dock only; bare children replay but break the
		// live grow:1 layout). The shell therefore reprints its own
		// document — transcript tail, prompt row, footer — so the
		// session stays visible in scrollback. Plain writes, same byte
		// style as the line-mode REPL.
		for (const line of [...lines, prompt, ...footer]) {
			if (line.length > 0) process.stdout.write(line + "\n");
		}
	}
}

// Live transcript mirror: wrap the fd writes so everything the REPL
// prints (turns, status, errors) lands in the ScrollView. Readline's
// prompt fragments are buffered until newline and collapsed at the
// last \r (each keystroke redraws the line) — submitted commands
// appear once, in-progress editing never pollutes the mirror.
// Restored verbatim by the returned release function.
export function teeOutputTo(session: FullscreenSession): () => void {
	const outWrite = process.stdout.write.bind(process.stdout);
	const errWrite = process.stderr.write.bind(process.stderr);
	const outAcc = { s: "" };
	const errAcc = { s: "" };
	// One flushed row per newline; a row keeps only the text after its
	// last \r (readline redraws the pending line per keystroke).
	const feed = (acc: { s: string }, chunk: unknown): void => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
		if (!text) return;
		acc.s += text;
		const rows = acc.s.split("\n");
		acc.s = rows.pop() ?? "";
		const clean: string[] = [];
		for (const r of rows) clean.push(r.slice(r.lastIndexOf("\r") + 1));
		session.pushLines(clean);
	};
	(process.stdout as unknown as { write: unknown }).write = function (chunk: unknown, ...rest: unknown[]) {
		if (!session.inWrite) feed(outAcc, chunk);
		return (outWrite as (...a: unknown[]) => unknown)(chunk, ...rest);
	};
	(process.stderr as unknown as { write: unknown }).write = function (chunk: unknown, ...rest: unknown[]) {
		if (!session.inWrite) feed(errAcc, chunk);
		return (errWrite as (...a: unknown[]) => unknown)(chunk, ...rest);
	};
	return () => {
		(process.stdout as unknown as { write: unknown }).write = outWrite;
		(process.stderr as unknown as { write: unknown }).write = errWrite;
	};
}
