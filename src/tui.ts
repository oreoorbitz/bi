// bi/src/tui.ts — host differential TUI, mirrors pi/packages/tui differential rendering
// BAML owns Component + diff_lines/visible_width/cursor_marker for baml test; host does TS rendering.
// This is minimal: renders BAIS ready + prompt, diffs lines (pi does ANSI differential).
import { footer_tips_async, render_divider_async, render_select_frame_async, tip_rotate_interval_ms_async } from "../baml_sdk/index.js";
import { chromeAnsi, loadChromePalette } from "./theme-files.js";
import { Container, ProcessTerminal, ScrollView, Text, TuiAltScreen, TuiMainScreen, getKeybindings, setKeybindings, sliceByColumn, visibleWidth as piVisibleWidth, type TUI } from "@earendil-works/pi-tui";
// bi#163: declared frame composition over pi-tui's VStack sizing contract.
// allocateStackSizes/visibleStackEntries are the exact fns VStack lays out
// with (components/stack.ts) — the host reuses them directly on line-array
// regions so BAML keeps owning row content while chrome declares sizing.
// (Deep path: index re-exports VStack but not the layout fns.)
import { allocateStackSizes, visibleStackEntries } from "@earendil-works/pi-tui/dist/components/stack.js";
import { currentKeybindingsManager } from "./keybindings.js";
import type { LayoutViewport, StackLayoutEntry } from "@earendil-works/pi-tui/dist/layout-node.js";

const CURSOR_MARKER = "\x1b_pi:c\x07";

// bi#162: REPL-lifetime pi-tui host for prompt modals.
//
// Kimi keeps one TuiBase for the app lifetime and mounts dialogs via
// showOverlay (tui.ts:552-661: preFocus recorded, focus restored on
// hide). bi did the opposite — every prompt modal built its own
// ProcessTerminal + TuiMainScreen, re-negotiating kitty flags per
// dialog (bi#119 names that churn as the escape-tail junk mechanism).
// This block owns the single host: created + started lazily on the
// first modal, shared by every modal until the leases drain, stopped
// exactly once. Negotiation runs once per host, pop + drain + stop
// once per dispose — the bi#119 envelope kept as defense-in-depth,
// just no longer per modal.
//
// Lease protocol: repl() (cli.ts) and multi-prompt login flows hold a
// lease for their whole run; one-shot modal users hold none and their
// host is disposed when their modal closes (same lifetime as before,
// so a lone `bi login` never hangs on a live stdin listener).
export interface ReplTuiHost {
	term: ProcessTerminal;
	ui: TUI;
	// True once the kitty/DA settle has run on this host. Later modals
	// never re-query (BI_MODAL_SETTLE=0 skips even the first, for the
	// drill proof that the overlay path removed the re-query).
	settled: boolean;
}

let replTuiHost: ReplTuiHost | null = null;
let replTuiLeases = 0;

// bi#194: the live HostFooter (at most one per process — cli.ts
// constructs a single footer for the REPL). Registered by the HostFooter
// constructor, cleared by its dispose; ensureReplTui's frame hook calls
// repin() on it after every pi-tui frame so the footer's CUP transport
// reasserts rows N-1/N (pi-tui's relative full-height dumps stream over
// them — the pre-194 DECSTBM region absorbed that at the boundary; with
// the region gone the owner re-pins instead). Null in drills and pipes.
let liveFooter: HostFooter | null = null;

/** The installed footer, if any — turns use it for the hint/live channels (bi#169). Null in drills and pipes. */
export function liveFooterNow(): HostFooter | null {
	return liveFooter;
}

/** True while a REPL/login flow holds the host across modals. */
export function replTuiLeased(): boolean {
	return replTuiLeases > 0;
}

/** Hold the host across modals (REPL lifetime, login flows). */
export function retainReplTui(): void {
	replTuiLeases += 1;
}

/** Release a lease; the last release disposes the host. */
export async function releaseReplTui(): Promise<void> {
	if (replTuiLeases > 0) replTuiLeases -= 1;
	if (replTuiLeases === 0) await disposeReplTui();
}

/** Idempotent: creates + starts the host once; later calls reuse it. */
export function ensureReplTui(logDir: string): ReplTuiHost {
	if (replTuiHost) return replTuiHost;
	const term = new ProcessTerminal();
	const ui: TUI = new TuiMainScreen(term, false, logDir);
	// bi#194 frame hook: after every pi-tui frame write the live footer
	// re-pins its rows by absolute CUP (its dumps stream over rows N-1/N
	// now that no scroll region absorbs them). terminal.write is the
	// frame choke point — the library's query/control bytes go through
	// process.stdout directly, so this fires once per frame buffer, not
	// per control sequence. The footer's own writes target stderr and
	// never re-enter here.
	const frameWrite = term.write.bind(term);
	term.write = (data: string): void => {
		frameWrite(data);
		liveFooter?.repin();
	};
	// Inert base layer: readline owns the REPL screen, so the host's
	// own frame is empty — modals composite over it via showOverlay
	// and hide() repaints back to it (shrink-clear erases modal rows).
	ui.addChild(new Container());
	ui.start();
	// Suppress event-type reporting (kitty flag 2): the library pushes
	// flags 1+2+4, but no pi-tui component consumes presses/releases/
	// repeats distinctly (no wantsKeyRelease opt-ins, no isKeyRepeat
	// readers) — and every release is a junk vector on a chunking link
	// (`3u` tails) with zero benefit here. Flags 1+4 keep disambiguated
	// presses, modifiers, and alternate keys; held keys degrade to
	// legacy repeated presses, which is correct for a text editor.
	// Kitty enhancement flags stack: the library's push is underneath,
	// ours is balanced by the explicit pop in disposeReplTui below (the
	// drain pops the library's; stop then sees cleared flags and
	// skips). Non-kitty terminals ignore both writes.
	term.write("\x1b[>5u");
	replTuiHost = { term, ui, settled: false };
	return replTuiHost;
}

/**
 * Tear down the host: drain stragglers while the library still drops
 * everything (bi#119 envelope, once per host), pop our kitty
 * suppression, then stop. Same order as pi's interactive-mode
 * shutdown. Never per modal: drainInput pops the shared kitty flags,
 * which would re-open the release storm for the next modal.
 */
export async function disposeReplTui(): Promise<void> {
	const host = replTuiHost;
	replTuiHost = null;
	if (!host) return;
	while (host.ui.hasOverlay()) host.ui.hideOverlay();
	await host.term.drainInput(500, chunkyLinkDrainIdleMs());
	host.term.write("\x1b[<u");
	host.ui.stop();
}


// Long drain window over chunking links, mirroring pi-tui's SSH-gated
// escape timeout (resolveEscapeTimeoutMs: 100ms SSH vs 10ms local).
// Direct local links process the kitty pop in ~1ms, so pending
// releases never get generated; anything that chunks escape traffic —
// SSH, tmux (escape-time), screen, emulator batching — needs the wait.
// Detection is env-based (same signals pi-tui itself uses, plus
// multiplexer markers); plain local terminals keep 50ms and pay no
// added latency.
export function chunkyLinkDrainIdleMs(): number {
	const env = process.env;
	return env.SSH_CONNECTION || env.SSH_TTY || env.TMUX || env.STY || env.ZELLIJ ? 250 : 50;
}

export function termWidth(fallback = 80): number {
	// Headless ptys and odd redirections report 0/undefined columns,
	// which would collapse every width-capped frame to "…"
	// (truncate_chars with max 0). Only a positive finite width is trusted.
	const c = process.stdout.columns ?? fallback;
	return typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.floor(c) : fallback;
}

// bi#163: one ordered VStack-style entry per frame region. Fields are the
// StackEntryOptions contract (basis/grow/shrink/minSize/maxSize/visible);
// `lines` is the BAML-shaped content. Chrome declares "never below 1 row"
// (minSize: 1) and the transcript declares "grow into the rest" (grow: 1);
// entries hide responsively via visible(viewport).
export interface FrameRegion {
	lines: string[];
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface FrameViewport {
	width: number;
	height?: number;
}

// Anchor component for sizing entries: allocateStackSizes/visibleStackEntries
// never touch `component`, but StackLayoutEntry requires one — a single inert
// Container stands in for all regions (VStack does the same per child).
const frameAnchor = new Container();

// Width-cap one row (bi#161, kimi tui-main-screen mirror): measure with
// pi-tui visibleWidth (ANSI-aware), cut with pi-tui sliceByColumn —
// never trusted to arrive pre-capped, never wrapped. A truncated styled
// line keeps its in-range SGR and gains a closing reset (the slice drops
// the reset past the cut; EL 2K clears text, not SGR, so without it the
// style would leak into the rows below). Shared by HostTui.render and
// composeFrame so composed frames carry the same cap.
// Graphics payloads are byte sequences, not text rows: slicing one by
// columns corrupts the image. Owner of the prefixes is image-display.ts
// (isImageLine); this prefix mirror keeps tui.ts free of that import
// (image-display stays baml_sdk-free, no tui cycle).
const KITTY_LINE_PREFIX = "\x1b_G";
const ITERM2_LINE_PREFIX = "\x1b]1337;File=";

function isGraphicsLine(line: string): boolean {
	return (
		line.startsWith(KITTY_LINE_PREFIX) ||
		line.startsWith(ITERM2_LINE_PREFIX) ||
		line.includes(KITTY_LINE_PREFIX) ||
		line.includes(ITERM2_LINE_PREFIX)
	);
}

function capLine(line: string, width: number): string {
	// bi#167 image regions: graphics lines pass through byte-identical —
	// the kitty/iterm2 payload carries its own cell size, never the cap.
	if (isGraphicsLine(line)) return line;
	if (piVisibleWidth(line) <= width) return line;
	const cut = sliceByColumn(line, 0, width, true);
	if (line.includes("\x1b") && !/(?:\x1b\[0?m)$/.test(cut)) return cut + "\x1b[0m";
	return cut;
}

// bi#163: compose ordered regions into the clipped line array for one frame.
// Sizing resolves through pi-tui's VStack machinery: visible(viewport)
// filters first, then allocateStackSizes deals grow/shrink against the
// available height with minSize/maxSize clamps. Overflow keeps the TAIL of a
// region (transcript scroll semantics — the most recent lines survive).
// Width degrades safely: non-positive/non-finite widths clamp to 1, so
// narrow terminals (< 40 cols) render without throwing or negative padding.
// Height omitted means "no clipping" (passthrough concatenation, capped).
export function composeFrame(regions: FrameRegion[], viewport: FrameViewport): string[] {
	const rawW = Math.floor(viewport.width);
	const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
	const entries: StackLayoutEntry[] = regions.map((r) => ({
		component: frameAnchor,
		...(r.basis === undefined ? {} : { basis: r.basis }),
		...(r.grow === undefined ? {} : { grow: r.grow }),
		...(r.shrink === undefined ? {} : { shrink: r.shrink }),
		...(r.minSize === undefined ? {} : { minSize: r.minSize }),
		...(r.maxSize === undefined ? {} : { maxSize: r.maxSize }),
		...(r.visible === undefined ? {} : { visible: r.visible }),
	}));
	const totalIntrinsic = regions.reduce((sum, r) => sum + r.lines.length, 0);
	const rawH = viewport.height === undefined ? totalIntrinsic : Math.floor(viewport.height);
	const height = Number.isFinite(rawH) && rawH > 0 ? rawH : 0;
	const vp: LayoutViewport = { width, height };
	const visEntries = visibleStackEntries(entries, vp);
	const visRegions = visEntries.map((e) => regions[entries.indexOf(e)]);
	const intrinsic = visRegions.map((r) => r.lines.length);
	const sizes = allocateStackSizes(visEntries, intrinsic, height, 0);
	const out: string[] = [];
	for (let k = 0; k < visRegions.length; k++) {
		const take = Math.max(0, Math.min(visRegions[k].lines.length, sizes[k] ?? 0));
		const kept = visRegions[k].lines.slice(visRegions[k].lines.length - take);
		for (const line of kept) out.push(capLine(line, width));
	}
	return out;
}

export class HostTui {
	private oldLines: string[] = [];
	private width: number;
	private write: (s: string) => void;
	constructor(width = termWidth(), write: (s: string) => void = (s) => process.stdout.write(s)) {
		this.width = Math.max(1, width);
		this.write = write;
	}
	// Live terminal width (bi#161). A SIGWINCH between renders updates
	// process.stdout.columns, so a positive finite reading always wins over
	// the cached width and the next frame renders at the new width.
	// Headless ptys report 0/undefined — those never override, so an
	// explicitly constructed width (drills, pipes) stays put.
	private liveWidth(): { width: number; resized: boolean } {
		const c = process.stdout.columns;
		if (typeof c === "number" && Number.isFinite(c) && c > 0) {
			const w = Math.max(1, Math.floor(c));
			return { width: w, resized: w !== this.width };
		}
		return { width: this.width, resized: false };
	}
	// Width-cap one row — shared capLine (bi#161/bi#163), so HostTui and
	// composeFrame truncate identically.
	private cap(line: string, width: number): string {
		return capLine(line, width);
	}
	render(lines: string[]): void {
		// Differential repaints, pi-TUI spec: first render streams rows
		// (cursor ends below the frame); same-count repaints restore to
		// below-frame, step up, and rewrite CHANGED rows only, then
		// restore — no full clear, no scroll creep (no net newlines).
		// Every buffer is ?2026-bracketed (synchronized output) so the
		// terminal never paints half a frame. Rows are width-capped here
		// (a row wider than the terminal would wrap and misalign the
		// region). Pure count changes still full-clear (rare;
		// startup-shaped usage); a columns change instead takes the resize
		// path — full re-render at the new width, stale rows cleared in
		// place, never 2J (kimi viewport/width-change mirror).
		const live = this.liveWidth();
		this.width = live.width;
		const width = this.width;
		const clean = lines.map((l) => this.cap(l.replace(CURSOR_MARKER, ""), width));
		this.write("\x1b[?2026h");
		if (this.oldLines.length === 0) {
			for (const l of clean) this.write(l + "\n");
		} else if (live.resized) {
			this.renderResized(clean);
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
		this.write("\x1b[?2026l");
		this.oldLines = clean;
	}
	// Resize path: cursor starts below the old frame. Step up over it,
	// rewrite every row at the new width (references never match across a
	// width change), clear stale rows when the frame shrank, and park the
	// cursor below the new frame — the saved position is stale (it points
	// below the OLD frame), so it is never restored. Grown rows stream
	// exactly like a first render; no path here scrolls away content or
	// touches 2J.
	private renderResized(clean: string[]): void {
		const old = this.oldLines.length;
		const n = clean.length;
		this.write("\x1b[s");
		this.write(`\x1b[${old}A`);
		for (let i = 0; i < Math.max(old, n); i++) {
			if (i > 0) this.write("\n");
			this.write(`\r\x1b[2K${clean[i] ?? ""}`);
		}
		if (n >= old) {
			// Cursor sits on the last frame row — step below the frame.
			this.write("\n");
		} else {
			const up = old - n - 1;
			if (up > 0) this.write(`\x1b[${up}A`);
		}
	}
	static visibleWidth(line: string): number {
		return piVisibleWidth(line.replace(CURSOR_MARKER, ""));
	}
}

// Select-list frame (bi#68): the one host path for /model, /resume,
// /tree listings. BAML owns rows + cursor + width shaping; the host
// composes the shaped frame + closing divider as one frame (bi#163) and
// diffs it through HostTui — no direct stdout assembly on this path.
// Picks stay numeric — the cursor index is display state until the
// bi#69 raw-mode layer. A BAML-shaped divider closes the block on
// stdout so the next prompt doesn't crowd the list.
export async function renderSelectList(text: string, cursor: number, width?: number, theme?: string | null): Promise<void> {
	const w = width ?? termWidth();
	const rows = text.split("\n").filter((l) => l.length > 0);
	const frame = await render_select_frame_async(rows, cursor, w);
	const divider = await render_divider_async(w, { theme: theme ?? null });
	new HostTui(w).render(
		composeFrame(
			[
				{ lines: frame, grow: 1, shrink: 1, minSize: 0 },
				{ lines: [divider], minSize: 1, shrink: 0 },
			],
			{ width: w },
		),
	);
}
// Pinned bottom-row footer (bi#67). BAML owns the frame line
// (render_footer_frame, width-capped to one row); the host owns the
// repaint.
//
// bi#194: ONE paint transport owns the footer rows — HostFooter
// addresses rows N-1/N with absolute CUP on every repaint, and no
// scroll region exists anywhere in the stack (pi-tui paints relatively
// and region-free; the pre-194 DECSTBM region interleaved with that
// relative painting at the rows-2 boundary). pi-tui's relative
// full-height frame dumps still stream over the footer rows (the region
// used to absorb them; the overlay margin only shapes the overlay box,
// not the base-frame dump), so the owner reasserts its rows after every
// host frame via the ensureReplTui frame hook (repin()). Named
// residual: mid-turn bypass output (console.log turn text) scrolls the
// whole screen, footer rows included — the post-turn show() re-pins
// them (the turn counter increments every turn, so the differential
// always fires, and a frame-row change re-pins BOTH rows).
//
// bi#184: row N-1 (frame) carries provider/model · thinking · counters ·
// cwd · branch; row N (model line) carries ONLY the catalog ctx window —
// no fact prints on both rows.
//
// bi#186: the model row also holds the rotating tips slot, right-aligned
// in textMuted (chrome palette, bi#185). BAML owns the corpus + rotation
// policy as data (selectors.baml footer_tips/tips_slot_text); HostFooter
// owns the 10s timer (started on the first TTY render, cleared by
// reset/dispose, unref'd so it never holds the event loop) and mirrors
// the pure pairing policy synchronously for the differential render —
// footer-tips.mjs pins mirror == BAML output (one-test→one-impl). A
// transient hint (bi#169 channel) preempts the slot while set; clearing
// releases back to the rotating tip. Pipes get neither tips nor hints.
//
// Readline coexistence: repaints happen only between turns (no active
// question pending), save the cursor, address the footer row absolutely,
// and restore — readline's in-progress line is never touched. Rows
// N-1/N carry only HostFooter content: pi-tui frames may stream over
// them, but the frame hook re-pins after every frame, which is what
// keeps the differential skip sound. Pipes and degenerate screens fall
// back to a plain printed line, byte-identical to the pre-footer
// console.error readout.
// Width below which the brand model line hides (bi#163 responsive demo via
// visible(viewport)): narrow terminals keep the footer + transcript rows,
// never clip chrome to fit. Mirrors the composeFrame narrow-width drill.
export const MODEL_LINE_MIN_WIDTH = 40;

// bi#208: footer follows content — hug rows (pure, headless-testable).
//
// The pinned footer (rows N-1/N) leaves a dead gap on short
// transcripts. With the input gate set (production REPL), the footer
// learns the cursor row via DSR and hugs: the frame lands directly
// below the last transcript line, the model row below it. Once
// content reaches the fold the footer pins (sticky) and all later
// paints take the legacy bottom path with zero further queries. A
// null cursor row (timeout, mute terminal, no gate) degrades to
// pinned — today's behavior. Rows are 1-based terminal rows.
export interface FooterHug {
	promptRow: number;
	frameRow: number;
	modelRow: number;
	pinned: boolean;
}
export function footerHugRows(rows: number, cursorRow: number | null): FooterHug {
	if (cursorRow == null || cursorRow >= rows - 2)
		return { promptRow: rows - 2, frameRow: rows - 1, modelRow: rows, pinned: true };
	return { promptRow: cursorRow, frameRow: cursorRow + 1, modelRow: cursorRow + 2, pinned: false };
}

// One-shot DSR cursor-row query (bi#208). The caller suspends line
// input first: an attached readline would eat the reply as keypresses
// (bi#119 junk class). Raw mode is required — cooked stdin
// line-buffers the reply forever. Restores the prior raw/paused state
// after; runModal re-asserts both anyway (prompt.ts reset step).
// Resolves null on timeout/mute/refusal — the caller pins.
export const FOOTER_DSR_TIMEOUT_MS = 150;
export function queryCursorRow(timeoutMs = FOOTER_DSR_TIMEOUT_MS): Promise<number | null> {
	const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const wasRaw = stdin.isRaw ?? false;
		const wasPaused = stdin.isPaused();
		const finish = (v: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				stdin.removeListener("data", onData);
			} catch {}
			try {
				if (typeof stdin.setRawMode === "function" && stdin.isTTY) stdin.setRawMode(wasRaw);
			} catch {}
			try {
				if (wasPaused) stdin.pause();
			} catch {}
			resolve(v);
		};
		const onData = (d: unknown) => {
			buf += String(d);
			const m = /\x1b\[(\d+);(\d+)R/.exec(buf);
			if (m) finish(Number(m[1]));
			else if (buf.length > 128) finish(null);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		try {
			if (typeof stdin.setRawMode === "function" && stdin.isTTY) stdin.setRawMode(true);
			stdin.resume();
			stdin.on("data", onData);
			process.stdout.write("\x1b[6n");
		} catch {
			finish(null);
		}
	});
}

// Synchronous mirror of selectors.baml tips_slot_text (bi#186) — the
// differential render path cannot await the BAML call per repaint.
// scripts/footer-tips.mjs pins this mirror equal to tips_slot_text_async
// across ticks and widths.
export function tipsSlotText(corpus: string[], tick: number, width: number): string {
	if (width <= 0 || corpus.length === 0) return "";
	const n = corpus.length;
	const i = ((tick % n) + n) % n;
	const first = corpus[i] ?? "";
	const second = corpus[(i + 1) % n] ?? "";
	const pair = `${first} | ${second}`;
	if (pair.length <= width) return pair;
	if (first.length <= width) return first;
	return `${first.slice(0, width)}…`;
}

// bi#186 tips wiring for HostFooter. Omitted (production): the corpus +
// cadence load async from BAML on construction. Passed (drills): the
// corpus is used directly — an empty corpus disables the slot and skips
// the async load, keeping byte pins deterministic.
export interface HostFooterTips {
	corpus: string[];
	intervalMs?: number;
}

export class HostFooter {
	private installedRows = 0;
	private installedFrame = 0;
	private lastFrame: string | null = null;
	private lastModel: string | null = null;
	// bi#208 hug state: input gate (production REPL wires the reader's
	// suspend), cached hug rows (null = pinned legacy).
	private inputGate: { suspend(): void } | null = null;
	private hug: FooterHug | null = null;
	// hub#237: hug rows are only valid synchronously after a DSR — any
	// scroll (welcome/BAIS prints, turn output) silently recycles
	// absolute rows, so reusing them later scribbles mid-screen (the
	// bi.jpg slab) and misplaces the prompt modal (missing input).
	// showAsync/homeInput arm this around their settle→render pair;
	// every other paint (tips/live timers, hints) pins.
	private hugArmed = false;
	// Last shown frame args for differential repaint.
	private lastArgs: { frame: string; model: string; fallback: string } | null = null;
	// bi#186 tips slot state.
	private tipsCorpus: string[] | null;
	private tipsIntervalMs: number;
	private tipTick = 0;
	private tipTimer: ReturnType<typeof setInterval> | null = null;
	private hint: string | null = null;
	constructor(
		private dims: () => { rows: number; cols: number } = () => ({
			rows: process.stdout.rows ?? 0,
			cols: termWidth(),
		}),
		private tty: () => boolean = () => !!process.stdout.isTTY && !!process.stderr.isTTY,
		private write: (s: string) => void = (s) => process.stderr.write(s),
		tips?: HostFooterTips,
	) {
		this.tipsCorpus = tips ? tips.corpus : null;
		// Default mirrors selectors.baml tip_rotate_interval_ms (pinned
		// equal by footer-tips.mjs); the async load replaces it with the
		// BAML value.
		this.tipsIntervalMs = tips?.intervalMs ?? 10000;
		if (!tips) void this.loadTips();
		liveFooter = this;
	}
	// bi#194: reassert both rows after a pi-tui frame (the host's relative
	// dumps stream over rows N-1/N now that no scroll region absorbs
	// them). Absolute CUP behind save/restore — the same transport as
	// every other HostFooter write, so the footer rows keep exactly one
	// owner. No-op unless installed on a roomful TTY at the installed
	// geometry (a resize routes through render() instead).
	repin(): void {
		if (this.installedRows === 0 || this.lastFrame === null) return;
		const { rows } = this.dims();
		if (!this.tty() || rows < 3 || rows !== this.installedRows) return;
		this.write("\x1b[s");
		this.paintBody(this.installedFrame, this.lastFrame, this.lastModel);
		this.write("\x1b[u");
	}
	// Loads the BAML corpus + cadence and the chrome palette override,
	// then repaints so the slot appears without waiting a full interval.
	// Tips are ambient chrome: a load failure is a loud named warning,
	// never a footer failure (bi#55).
	private async loadTips(): Promise<void> {
		try {
			const [corpus, ms] = await Promise.all([footer_tips_async(), tip_rotate_interval_ms_async()]);
			this.tipsCorpus = corpus as string[];
			this.tipsIntervalMs = ms as number;
			await loadChromePalette();
		} catch (e) {
			console.error(
				`[bi] footer tips unavailable (${e instanceof Error ? e.message : e}) — footer runs without the tips slot`,
			);
			return;
		}
		if (this.installedRows > 0) this.render();
	}
	// Paints the two BAML-shaped rows: the footer frame (row N-1) and
	// the brand model line below it (row N). Both rows compose through
	// composeFrame (bi#163): footer + model declare minSize 1 each so the
	// transcript filler yields first on short screens, and the model line
	// hides below MODEL_LINE_MIN_WIDTH via visible(viewport). Fallback is
	// the plain printed footer + plain model line for pipes (byte-identical
	// to the old readout plus one line). Differential per row: unchanged
	// rows on an unchanged screen write zero bytes. A resize repaints at
	// the new geometry even when the text matches.
	// bi#208: wire the reader's suspend (cli.ts) — the DSR query runs
	// with readline detached. Unset (drills, pipes) means pinned legacy.
	setInputGate(gate: { suspend(): void } | null): void {
		this.inputGate = gate;
	}
	// Rows the modal editor must keep clear below its box (prompt.ts
	// bottom margin): pinned reserves 2 (today), hugged reserves up to
	// the floating frame row.
	reserveBottom(): number {
		const { rows } = this.dims();
		if (this.installedRows === 0) return 2;
		// hub#237: the margin follows the freshly settled hug rows (the
		// prompt homes there in the same tick — askEdit runs with no
		// print between), never the installed paint: a scroll between
		// install and prompt recycles those numbers and the old formula
		// (rows - installedFrame + 1 ≈ rows) pushed the modal above the
		// viewport (bi.jpg: prompt input missing completely). Clamped
		// on-screen — a stale hug degrades to a squished-but-visible
		// box, never an invisible one.
		const h = this.hug;
		if (!h || h.pinned) return 2;
		const frame = Math.min(h.frameRow, rows - 1);
		return Math.max(2, Math.min(rows - 2, rows - frame + 1));
	}
	// Resolve hug rows for this paint: query iff the gate is set and
	// (never pinned or the geometry changed since install). Sticky pin
	// otherwise — zero queries on the steady path. Timeout/mute pins.
	private async settleRows(rows: number): Promise<FooterHug> {
		if (this.inputGate && (!this.hug?.pinned || this.installedRows !== rows)) {
			let row: number | null = null;
			try {
				this.inputGate.suspend();
				row = await queryCursorRow();
			} catch {
				row = null;
			}
			this.hug = footerHugRows(rows, row);
		}
		this.hug ??= footerHugRows(rows, null);
		return this.hug;
	}
	// Paint-time rows under the current geometry: hug rows clamped to
	// the fold (a taller resize keeps the cached cursor row; a shorter
	// one pins). hub#237: the hug rows apply only while armed (the
	// settle→render pair just ran) — every other paint pins, because a
	// scroll since the settle recycled those absolute rows.
	private paintRows(rows: number): { frame: number; model: number } {
		const h = this.hug;
		if (!h || h.pinned || !this.hugArmed) return { frame: rows - 1, model: rows };
		const frame = Math.min(h.frameRow, rows - 1);
		return { frame, model: frame + 1 };
	}
	show(frame: string, model: string, fallback: string): void {
		this.lastArgs = { frame, model, fallback };
		this.render();
	}
	// bi#208: production paints settle the hug rows first (DSR while
	// unpinned, sticky pin after). Drills keep the synchronous show()
	// contract above — same bytes as before when the gate is unset.
	// hub#237: the settle→render pair runs armed (those rows are valid
	// right now); the arm drops before returning so timer paints pin.
	async showAsync(frame: string, model: string, fallback: string): Promise<void> {
		this.lastArgs = { frame, model, fallback };
		const { rows } = this.dims();
		if (this.tty() && rows >= 3) await this.settleRows(rows);
		this.hugArmed = true;
		try {
			this.render();
		} finally {
			this.hugArmed = false;
		}
	}
	// Transient hint (bi#169 channel): preempts the tips slot while set,
	// styled primary (actionable); clearing releases back to the rotating
	// tip. Pipes stay byte-silent — hints are chrome, not output.
	setHint(hint: string | null): void {
		this.hint = hint !== null && hint.length > 0 ? hint : null;
		if (this.tty()) this.render();
	}
	private render(): void {
		const a = this.lastArgs;
		if (!a) return;
		const frame = a.frame;
		const model = a.model;
		const { rows, cols } = this.dims();
		if (!this.tty() || rows < 3) {
			this.reset();
			this.write(a.fallback + "\n" + a.model + "\n");
			return;
		}
		const modelOn = cols >= MODEL_LINE_MIN_WIDTH;
		const composed = composeFrame(
			[
				{ lines: [], grow: 1, shrink: 1, minSize: 0 },
				{ lines: [frame], minSize: 1, shrink: 0 },
				{ lines: [model], minSize: 1, shrink: 0, visible: (vp) => vp.width >= MODEL_LINE_MIN_WIDTH },
			],
			{ width: cols, height: rows },
		);
		const cFrame = composed[composed.length - (modelOn ? 2 : 1)] ?? frame;
		const cModelRaw = modelOn ? (composed[composed.length - 1] ?? model) : null;
		const cModel = cModelRaw === null ? null : this.withTipsSlot(cModelRaw, cols);
		// bi#208: hug rows (clamped to this geometry); a moved footer
		// erases its old rows first — two CUP+EL writes, never a clear.
		// hub#237: erase only when the old rows ARE the target rows. A
		// scroll recycles absolute numbers — the installed numbers now
		// hold transcript, and blanking them punches holes in it (the
		// overflow drill enshrined exactly that). A moved footer leaves
		// its buried paint as scrollback (same fossil class as the
		// pinned path) and installs at the target without erasing.
		const pr = this.paintRows(rows);
		if (this.installedRows !== rows || this.installedFrame !== pr.frame) {
			if (this.installedFrame === pr.frame) this.eraseRows();
			this.install(rows, cFrame, cModel, pr.frame);
		} else {
			if (this.lastFrame !== cFrame || this.lastModel !== cModel) this.paint(pr, cFrame, cModel);
		}
		this.ensureTipsTimer();
	}
	// Appends the right-aligned tips slot to the model row: the live hint
	// while one is set, else the rotating tip for this tick. Slot width is
	// the columns left after the left content minus one gap column; an
	// empty slot (narrow terminal, no corpus yet) returns the row
	// untouched. Styling is render-time chromeAnsi (bi#185): textMuted for
	// tips, primary for hints; BI_THEME=none / NO_COLOR yields plain text.
	private withTipsSlot(row: string, cols: number): string {
		const text =
			this.hint ??
			(this.tipsCorpus !== null ? tipsSlotText(this.tipsCorpus, this.tipTick, cols - HostTui.visibleWidth(row) - 1) : "");
		if (text === "") return row;
		const code = chromeAnsi(this.hint !== null ? "primary" : "text_muted");
		const styled = code === "" ? text : `${code}${text}\x1b[0m`;
		const pad = cols - HostTui.visibleWidth(row) - HostTui.visibleWidth(styled);
		if (pad < 1) return row;
		return row + " ".repeat(pad) + styled;
	}
	// Tips rotation timer: started once the footer is live on a TTY,
	// cleared by reset/dispose, unref'd so drills and one-shot runs never
	// hang on it. The guard is the bi#186 no-double-fire pin: repeated
	// renders never stack intervals. Each tick advances and repaints
	// through the normal differential path, so a rotation rewrites row N
	// only — never the frame row, never while piping.
	private ensureTipsTimer(): void {
		if (this.tipTimer || this.tipsCorpus === null || this.tipsCorpus.length === 0) return;
		this.tipTimer = setInterval(() => {
			this.tipTick += 1;
			this.render();
		}, this.tipsIntervalMs);
		this.tipTimer.unref();
	}
	private clearTipsTimer(): void {
		if (this.tipTimer) clearInterval(this.tipTimer);
		this.tipTimer = null;
	}
	// Live repaint source (bi#169): while a turn runs, a TTY-only 1s
	// timer re-renders through the normal differential path so context
	// pressure moves without waiting for turn end. The source returns
	// null once the turn settles and the timer releases itself; an
	// unchanged frame writes zero bytes, and pipes never start the
	// timer (byte-identical output by construction).
	private liveSource: (() => Promise<{ frame: string; model: string; fallback: string } | null>) | null = null;
	private liveTimer: ReturnType<typeof setInterval> | null = null;
	private liveBusy = false;
	setLiveSource(src: (() => Promise<{ frame: string; model: string; fallback: string } | null>) | null): void {
		this.liveSource = src;
		if (src) this.ensureLiveTimer();
		else this.clearLiveTimer();
	}
	private ensureLiveTimer(): void {
		if (this.liveTimer || !this.tty()) return;
		this.liveTimer = setInterval(() => void this.liveTick(), 1000);
		this.liveTimer.unref();
	}
	private clearLiveTimer(): void {
		if (this.liveTimer) clearInterval(this.liveTimer);
		this.liveTimer = null;
		this.liveBusy = false;
	}
	private async liveTick(): Promise<void> {
		const src = this.liveSource;
		if (!src || this.liveBusy) return;
		if (!this.tty()) {
			this.setLiveSource(null);
			return;
		}
		if (this.installedRows === 0) return;
		this.liveBusy = true;
		try {
			const next = await src();
			if (next === null) this.setLiveSource(null);
			else await this.showAsync(next.frame, next.model, next.fallback);
		} finally {
			this.liveBusy = false;
		}
	}
	// Tears down the footer and erases both rows; silent when the
	// footer was never installed (pipes stay escape-free).
	dispose(): void {
		if (liveFooter === this) liveFooter = null;
		this.reset();
	}
	// Homes the cursor above the footer rows so the next prompt draws
	// as part of the footer block. bi#208: with the gate set the row
	// is settled by DSR — the prompt stays at the content end (hug)
	// until the fold pins it; without the gate this is the legacy
	// jump to rows-2. No-op unless installed — pipes and short
	// screens keep today's inline prompt byte-identical.
	async homeInput(): Promise<void> {
		if (this.installedRows === 0) return;
		const { rows } = this.dims();
		if (!this.tty() || rows < 3) return;
		const h = await this.settleRows(rows);
		// hub#237: repaint at the fresh rows synchronously (the only
		// moment they are valid) so the footer sits below the prompt;
		// the move skips the erase when a scroll recycled the old
		// numbers (render's same-frame rule). Disarm before returning
		// — later timer paints pin.
		this.hugArmed = true;
		try {
			this.render();
		} finally {
			this.hugArmed = false;
		}
		this.write(`\x1b[${h.promptRow};1H`);
	}
	private install(rows: number, frame: string, model: string | null, frameRow: number): void {
		// Paint both rows behind save/restore — the transcript cursor
		// never moves. Absolute CUP is the only transport (bi#194: no
		// scroll region anywhere in the stack).
		this.write("\x1b[s");
		this.paintBody(frameRow, frame, model);
		this.write("\x1b[u");
		this.installedRows = rows;
		this.installedFrame = frameRow;
		this.lastFrame = frame;
		this.lastModel = model;
	}
	private paint(pr: { frame: number; model: number }, frame: string, model: string | null): void {
		this.write("\x1b[s");
		// Repaint changed rows (no clear, absolute CUP per row). A hidden
		// model (narrow viewport) erases the model row instead of writing
		// text. bi#194: a frame-row change means a turn just ran, and the
		// turn's bypass output may have scrolled the model row away —
		// with no region protecting it, the post-turn repaint re-pins
		// BOTH rows even when the model text matches. Model-only changes
		// (tips rotation, hints) still leave the frame row alone.
		const frameChanged = this.lastFrame !== frame;
		if (frameChanged) this.write(`\x1b[${pr.frame};1H\x1b[2K${frame}`);
		if (frameChanged || this.lastModel !== model) this.write(`\x1b[${pr.model};1H\x1b[2K${model ?? ""}`);
		this.write("\x1b[u");
		this.lastFrame = frame;
		this.lastModel = model;
	}
	private paintBody(frameRow: number, frame: string, model: string | null): void {
		this.write(`\x1b[${frameRow};1H\x1b[2K${frame}`);
		this.write(`\x1b[${frameRow + 1};1H\x1b[2K${model ?? ""}`);
	}
	// Erase the installed rows (a footer move's first half). Writes
	// only — timers and caches survive; reset() clears those too.
	private eraseRows(): void {
		if (this.installedRows === 0) return;
		this.write("\x1b[s");
		this.write(`\x1b[${this.installedFrame};1H\x1b[2K`);
		this.write(`\x1b[${this.installedFrame + 1};1H\x1b[2K`);
		this.write("\x1b[u");
	}
	private reset(): void {
		this.clearTipsTimer();
		this.clearLiveTimer();
		this.eraseRows();
		this.installedRows = 0;
		this.installedFrame = 0;
		this.lastFrame = null;
		this.lastModel = null;
	}
}

// bi#158: transcript search over session scrollback.
//
// The REPL prints turns as plain lines; /search renders the in-memory
// history (the same source /export serializes) into a TuiAltScreen
// viewport and opens pi-tui's own AltScreenSearchComponent — query,
// n/m counter, next/prev nav are all library-owned (bi#114 doctrine:
// pi-tui owns widgets, BAML owns content). Esc closes with the session
// byte-identical: history is only read, and the screen stops with
// preserveScreen so the library skips its scrollback replay (no
// transcript reprint). Teardown mirrors runModal (prompt.ts): drain
// input, then stop — drainInput pops the library's kitty flags itself,
// so no manual <u is written (disposeReplTui's manual pop only
// balances its own >5u suppression write, which this screen skips).
export const TRANSCRIPT_SEARCH_NOTE =
	"/search needs an interactive terminal — use /export [path] for a searchable markdown dump of this session";

// Gate for the search screen. Local (not promptAvailable): tui.ts is
// imported by prompt.ts, so importing prompt.js here would cycle.
export function searchScreenAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.BI_SCREEN === "0") return false;
	return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

// Pure transcript shaping (headless-testable): one header row per
// message plus its text lines. Plain rows — the library strips ANSI
// for matching itself, and bi stores no ANSI in history.
export function transcriptLines(history: Array<{ role?: unknown; text?: unknown }>): string[] {
	const out: string[] = [];
	for (const m of history) {
		const role = String((m as { role?: unknown } | null)?.role ?? "unknown");
		out.push(`### ${role}`);
		const text = String((m as { text?: unknown } | null)?.text ?? "");
		if (text.length > 0) for (const l of text.split("\n")) out.push(l);
	}
	return out;
}

export async function runTranscriptSearch(
	history: Array<{ role?: unknown; text?: unknown }>,
	logDir: string,
): Promise<void> {
	if (!searchScreenAvailable()) {
		console.error(TRANSCRIPT_SEARCH_NOTE);
		return;
	}
	// Library defaults plus the user's validated ~/.bi overrides, same
	// as runModal — the search/next/prev/close bindings stay remappable.
	setKeybindings(currentKeybindingsManager());
	const term = new ProcessTerminal();
	const ui = new TuiAltScreen(term, false, logDir);
	const lines = transcriptLines(history);
	const doc = new Text(lines.length > 0 ? lines.join("\n") : "(empty transcript — no turns yet)");
	ui.setLayoutRoot(new ScrollView(doc, { follow: "end", primary: true }));
	ui.start();
	// Programmatic openSearch: private in the .d.ts but the library's
	// own entry (tui-alt-screen.ts openSearch) — the same call the
	// Ctrl+Shift+F keybinding reaches. Esc closes via the library's
	// searchClose binding; the exit listener below only fires when no
	// overlay remains (first-consume-wins routing: the viewport
	// consumes the closing Esc first, so closing never exits).
	(ui as unknown as { openSearch(): void }).openSearch();
	const done = new Promise<void>((resolve) => {
		const off = ui.addInputListener((data: string) => {
			if (data === "\x03" || data === "\x04") {
				off();
				resolve();
				return { consume: true };
			}
			try {
				if (!ui.hasOverlay() && getKeybindings().matches(data, "tui.altScreen.searchClose")) {
					off();
					resolve();
					return { consume: true };
				}
			} catch {
				// Key matching never breaks the viewer.
			}
			return undefined;
		});
	});
	await done;
	await term.drainInput(500, chunkyLinkDrainIdleMs());
	// preserveScreen: replay would reprint the transcript into
	// scrollback — the acceptance forbids exactly that.
	ui.stop({ preserveScreen: true });
}

// bi#160: fullscreen frame contract (VStack mirror).
//
// The live alt-screen root (screen-fullscreen.ts) is a VStack with
// these same entries: the transcript grows, the prompt row collapses
// first, the footer never drops below 1 row. composeFullscreenFrame
// resolves the identical allocateStackSizes contract headlessly, so
// the drill proves dock pinning without a pty.
export interface FullscreenFrameInput {
	transcript: string[];
	promptRow: string;
	footer: string[];
}

export function fullscreenFrameEntries(input: FullscreenFrameInput): FrameRegion[] {
	return [
		{ lines: input.transcript, grow: 1, shrink: 1, minSize: 0 },
		{ lines: [input.promptRow], shrink: 1, minSize: 0 },
		{ lines: input.footer, minSize: 1, shrink: 0 },
	];
}

export function composeFullscreenFrame(input: FullscreenFrameInput, viewport: FrameViewport): string[] {
	return composeFrame(fullscreenFrameEntries(input), viewport);
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
