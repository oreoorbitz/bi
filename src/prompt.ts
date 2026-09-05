// bi/src/prompt.ts — one-shot pi-tui prompts, copied from Pi's patterns.
//
// Pi's coding-agent never subclasses input handling around the library:
// releases never reach components (Tui.handleInput drops them centrally
// unless a component opts in via wantsKeyRelease — none does), the
// Terminal consumes kitty/DA negotiation replies, and shutdown drains
// input BEFORE stopping (interactive-mode: drainInput then stop) so late
// bytes never land in whatever reads stdin next. This module does exactly
// that and nothing else — the homegrown release guards, reply regexes,
// and sync stdin reads/sweeps that caused the junk-text bugs are gone.
//
// Widgets are stock pi-tui: Input (askText, same shape as pi's
// ExtensionInputComponent minus the chrome), SelectList (pickList), and
// a stock Editor with pi's CustomEditor shape (keybinding intercepts
// first, super.handleInput owns the rest). BAML still owns completion
// shaping through the same matchers as readline.
import {
	CancellableLoader,
	Container,
	Editor,
	Input,
	Loader,
	KeybindingsManager,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	TUI_KEYBINDINGS,
	getKeybindings,
	matchesKey,
	setKeybindings,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Component,
	type EditorTheme,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { complete_arg, complete_slash } from "../baml_sdk/index.js";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBiSessionsDir } from "./session.js";
import { termWidth } from "./tui.js";

export interface ScreenRow {
	label: string;
	description?: string;
}

// Identity theme for now: no chalk in bi's deps, so no color mapping
// yet — selection reads via the → prefix + scroll position.
const plainSelectList = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};
const plainEditorTheme: EditorTheme = { borderColor: (s) => s, selectList: plainSelectList };
const plainListTheme: SelectListTheme = { ...plainSelectList };

export function promptAvailable(): boolean {
	if (process.env.BI_SCREEN === "0") return false;
	return (
		!!process.stdin.isTTY &&
		!!process.stdout.isTTY &&
		typeof (process.stdin as any).setRawMode === "function"
	);
}

// Stock Editor with pi CustomEditor's shape: app-level hotkeys first,
// everything else to super. Escape/Ctrl-C cancels only when the
// autocomplete list is closed (open: super dismisses the list);
// Ctrl-D quits only on an empty buffer (non-empty: super handles it).
// No release handling here — Tui drops releases before components run.
export class PromptEditor extends Editor {
	onEscape?: () => void;
	onCtrlD?: () => void;
	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") && !this.isShowingAutocomplete()) {
			this.onEscape?.();
			return;
		}
		if (matchesKey(data, "ctrl+d") && this.getText().length === 0) {
			this.onCtrlD?.();
			return;
		}
		super.handleInput(data);
	}
}

export interface SlashPool {
	// Slash names without the leading "/" (builtins + skills).
	names: () => string[];
	describe: (name: string) => string | null;
	argPool: (cmd: string, prefix: string) => Promise<string[]>;
}

// Tab completion through the same BAML matchers as readline: first
// word completes slash names, second word the host's per-command pool.
// Free text and unknown commands complete nothing — never guess.
export function makeSlashProvider(pool: SlashPool): AutocompleteProvider {
	return {
		triggerCharacters: ["/", " ", "\t"],
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
		): Promise<AutocompleteSuggestions | null> {
			const line = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const second = line.match(/^\/(\S+)[ \t]+(\S*)$/);
			if (second) {
				const [, cmd, prefix] = second;
				if (!pool.names().includes(cmd)) return null;
				const matches = complete_arg(prefix, await pool.argPool(cmd, prefix));
				if (matches.length === 0) return null;
				return {
					items: matches.map((m): AutocompleteItem => ({ value: m, label: m })),
					prefix,
				};
			}
			if (!line.startsWith("/") || /[ \t]/.test(line)) return null;
			const matches = complete_slash(line, pool.names());
			if (matches.length === 0) return null;
			return {
				items: matches.map((m): AutocompleteItem => ({
					value: m,
					label: m,
					description: pool.describe(m.replace(/^\//, "")) ?? undefined,
				})),
				prefix: line,
			};
		},
		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		): { lines: string[]; cursorLine: number; cursorCol: number } {
			// bi#115: refuse stale accepts. Suggestions resolve async, so
			// the recorded prefix may predate the current line (slow BAML
			// round vs typing cadence) — splicing then mangles submits
			// (`/qu` suggestions accepted into `/quit`). When the text
			// before the cursor no longer IS the prefix, return the line
			// untouched: Enter submits what the user typed, Tab no-ops
			// until a fresh round. Fresh accepts are unaffected.
			const cur = lines[cursorLine] ?? "";
			const at = cursorCol - prefix.length;
			if (at < 0 || cur.slice(at, cursorCol) !== prefix) return { lines, cursorLine, cursorCol };
			const next = lines.slice();
			const head = cur.slice(0, at);
			const tail = cur.slice(cursorCol);
			// First-word picks append the trailing space so the next Tab
			// reaches the argument pool (readline's bare-exact step, fused).
			const firstWord = prefix.startsWith("/") && !prefix.includes(" ");
			const insert = firstWord ? item.value + " " : item.value;
			next[cursorLine] = head + insert + tail;
			return { lines: next, cursorLine, cursorCol: head.length + insert.length };
		},
	};
}

// Long drain window over chunking links, mirroring pi-tui's SSH-gated
// escape timeout (resolveEscapeTimeoutMs: 100ms SSH vs 10ms local).
// Direct local links process the kitty pop in ~1ms, so pending
// releases never get generated; anything that chunks escape traffic —
// SSH, tmux (escape-time), screen, emulator batching — needs the wait.
// Detection is env-based (same signals pi-tui itself uses, plus
// multiplexer markers); plain local terminals keep 50ms and pay no
// added latency.
function chunkyLinkDrainIdleMs(): number {
	const env = process.env;
	return env.SSH_CONNECTION || env.SSH_TTY || env.TMUX || env.STY || env.ZELLIJ ? 250 : 50;
}

// Debug tap: BI_TUI_DEBUG=/path.log records timestamped raw stdin
// chunks plus modal markers for the whole process. Observe-only (never
// consumes or alters bytes); unset by default, zero cost. This is how
// split-sequence junk gets diagnosed on terminals we cannot see:
// the log shows exactly which bytes arrived in which chunk and when,
// so prefix-eating (negotiation flush, StdinBuffer reassembly) vs
// value-printing vs tty echo can be told apart after the fact.
let tapArmed = false;
function tapEvent(marker: string): void {
	const path = process.env.BI_TUI_DEBUG;
	if (!path) return;
	try {
		appendFileSync(path, `${Date.now()} ${marker}\n`);
	} catch {}
}
function tapOut(tag: string, chunk: unknown): void {
	const path = process.env.BI_TUI_DEBUG;
	if (!path) return;
	try {
		appendFileSync(path, `${Date.now()} ${tag} ${JSON.stringify(String(chunk).slice(0, 160))}\n`);
	} catch {}
}
function ensureTap(): void {
	const path = process.env.BI_TUI_DEBUG;
	if (!path || tapArmed) return;
	tapArmed = true;
	try {
		appendFileSync(path, `${Date.now()} tap-armed\n`);
		process.stdin.on("data", (chunk: Buffer) => {
			try {
				appendFileSync(path, `${Date.now()} raw ${JSON.stringify(chunk.toString("utf8"))}\n`);
			} catch {}
		});
		// Wrap stdout/stderr to attribute displayed glyphs: if a junk
		// line was written by bi (dirty value print) it shows here as
		// `out`/`err`; if it arrived via tty echo while cooked, only a
		// `raw` line precedes it. Observe-only passthrough.
		for (const [stream, tag] of [
			[process.stdout, "out"],
			[process.stderr, "err"],
		] as const) {
			const orig = stream.write.bind(stream);
			(stream as any).write = (chunk: any, ...args: any[]) => {
				tapOut(tag, chunk);
				return orig(chunk, ...args);
			};
		}
	} catch {}
}
// Arm at import so load-time prints (before the first modal) are
// covered too. Env-gated: unset means zero listeners, zero wrapping.
ensureTap();

// Negotiation settle. Proven in a pty: when a kitty/DA reply straddles
// pi-tui's 150ms negotiation-fragment flush (slow/SSH links), the
// flushed `ESC[?` prefix vanishes but the tail (`7u`, `64;…;52c`) is
// typed into the focused widget — byte-for-byte the chronic junk
// report. While nothing is focused the Tui drops input, so focus waits
// until the handshake settles: a reply flips kittyProtocolActive (kitty)
// or modifyOtherKeysActive (DA-only) within ms on fast links, then a
// quiet window covers the trailing second reply (DA stalling behind
// kitty flags) — tails still arriving hold focus off. A fixed window
// cannot cover an unboundedly late reply; quiet adapts. Bytes in the
// window (tails and early typeahead alike) are dropped; the cap bounds
// the cost on mute terminals. Every modal settles: each start()
// re-queries, so a "live once" shortcut would re-open the race.
async function settleNegotiation(term: ProcessTerminal): Promise<void> {
	const step = 5;
	const quietNeeded = 100;
	// 450ms covers the slow-link band (every reply byte within ~450ms
	// of the query, mid-reply stalls included); stalls past it are
	// accepted residual risk, tracked on the junk issue. Mute terminals
	// pay the cap per modal — near-empty population, so no skip logic.
	const cap = 450;
	let quiet = 0;
	let waited = 0;
	let signal = false;
	const bump = () => {
		quiet = 0;
	};
	process.stdin.on("data", bump);
	try {
		for (;;) {
			if (term.kittyProtocolActive || term.modifyOtherKeysActive) signal = true;
			if (signal && quiet >= quietNeeded) break;
			if (waited >= cap) break;
			await new Promise((r) => setTimeout(r, step));
			waited += step;
			quiet += step;
		}
	} finally {
		process.stdin.removeListener("data", bump);
	}
}

// One modal on a fresh main-screen TUI. Focus waits for the negotiation
// settle (above); teardown copies pi's interactive-mode shutdown order:
// terminal.drainInput() BEFORE ui.stop(), while stdin still flows —
// late kitty replies and release events are consumed by the library
// instead of landing in readline as typed junk.
// ~/.bi log dir, never pi's: the screen's debug log must not leak
// into the reference checkout's agent dir.
async function runModal<T>(build: (ui: TUI, root: Container) => { wait: Promise<T>; focus: Component }): Promise<T> {
	if (!promptAvailable()) throw new Error("prompt modal: no TTY");
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const term = new ProcessTerminal();
	const ui: TUI = new TuiMainScreen(term, false, dirname(getBiSessionsDir()));
	const root = new Container();
	ui.addChild(root);
	const { wait, focus } = build(ui, root);
	ensureTap();
	tapEvent("modal-start");
	ui.start();
	// Suppress event-type reporting (kitty flag 2): the library pushes
	// flags 1+2+4, but no pi-tui component consumes presses/releases/
	// repeats distinctly (no wantsKeyRelease opt-ins, no isKeyRepeat
	// readers) — and every release is a junk vector on a chunking link
	// (`3u` tails) with zero benefit here. Flags 1+4 keep disambiguated
	// presses, modifiers, and alternate keys; held keys degrade to
	// legacy repeated presses, which is correct for a text editor.
	// Kitty enhancement flags stack: the library's push is underneath,
	// ours is balanced by the explicit pop in the finally below (the
	// drain pops the library's; stop then sees cleared flags and
	// skips). Non-kitty terminals ignore both writes.
	term.write("\x1b[>5u");
	await settleNegotiation(term);
	tapEvent(`focus kitty=${term.kittyProtocolActive} modkeys=${term.modifyOtherKeysActive}`);
	ui.setFocus(focus);
	try {
		const result = await wait;
		tapEvent("resolve");
		return result;
	} finally {
		// Post-submit net: stragglers generated while the pop is in
		// flight would otherwise land in readline mangled ("3u" —
		// readline cannot parse CSI-u). During the drain the library
		// drops everything, so stall here long enough to eat a slow
		// finger lift. Chunking links (SSH, multiplexers) get the long
		// window; direct local links pop instantly, so they keep the
		// short one and pay no latency. Cost: keys typed in the window
		// are dropped and a precisely-timed Ctrl-C is swallowed — same
		// semantics as pi's own drainInput, which also drops.
		tapEvent("drain-start");
		await ui.terminal.drainInput(500, chunkyLinkDrainIdleMs());
		tapEvent("drain-end");
		term.write("\x1b[<u");
		ui.stop();
		tapEvent("stopped");
	}
}

// One prompt through the modal editor. Resolves text | "\x03" on
// Esc/Ctrl-C, rejects EOF on Ctrl-D at empty — ReplReader.ask
// byte-for-byte. History is oldest-first (file order); the caller
// persists submissions as before.
export async function askEdit(prompt: string, history: string[], pool: SlashPool): Promise<string> {
	return runModal<string>((ui, root) => {
		root.addChild(new Text(prompt));
		const ed = new PromptEditor(ui, plainEditorTheme);
		for (const h of history) ed.addToHistory(h);
		ed.setAutocompleteProvider(makeSlashProvider(pool));
		root.addChild(ed);
		const wait = new Promise<string>((resolve, reject) => {
			ed.onSubmit = (t) => {
				ed.addToHistory(t);
				resolve(t);
			};
			ed.onEscape = () => resolve("\x03");
			ed.onCtrlD = () => reject(new Error("EOF"));
		});
		return { wait, focus: ed };
	});
}

// Text prompt through the same modal host (login code/URL entry).
// Null means cancelled (Esc): callers fall back to their line reader
// or abort, same as the legacy path.
export async function askText(title: string, initial = ""): Promise<string | null> {
	return runModal<string | null>((ui, root) => {
		root.addChild(new Text(title));
		const input = new Input();
		if (initial) input.setValue(initial);
		root.addChild(input);
		const wait = new Promise<string | null>((resolve) => {
			input.onSubmit = (value) => resolve(value);
			input.onEscape = () => resolve(null);
		});
		return { wait, focus: input };
	});
}

// ANSI never reaches the widget: BAML-shaped rows carry SGR color (and
// pi-tui emits OSC hyperlinks) that would fight pi-tui's own selection
// styling. Indices are unaffected — callers map positionally.
function clean(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;;[^\x07]*\x07/g, "");
}

// bi#108: dialog chrome primitives, ported from pi's coding-agent
// components (dynamic-border / visual-truncate / bordered-loader).
// Styling stays identity (no chalk in deps) like the rest of bi's
// chrome — selection reads via prefix + scroll position.

// DynamicBorder: a viewport-width rule. Rendered per-frame at the live
// width, so resizes reframe for free (pi's jiti note doesn't apply —
// bi passes the color explicitly at each use site anyway).
export class DynamicBorder {
	constructor(private color: (s: string) => string = (s) => s) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

// Wide codepoint ranges (W/F per UAX #11, BMP only — lone surrogates
// count 2, which safely overestimates emoji). Mirrors what pi's
// paint-layer truncate assumes; ASCII fast-path first.
function charVisualWidth(cp: number): number {
	if (cp < 0x1100) return 1;
	if (cp <= 0x115f) return 2; // Hangul Jamo
	if (cp === 0x2329 || cp === 0x232a) return 2;
	if (cp >= 0x2e80 && cp <= 0x303e) return 2; // CJK radicals/punct
	if (cp >= 0x3041 && cp <= 0x33ff) return 2; // Hiragana/Katakana/CJK compat
	if (cp >= 0x3400 && cp <= 0x4dbf) return 2; // CJK ext A
	if (cp >= 0x4e00 && cp <= 0xa4cf) return 2; // CJK unified + Yi
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul syllables
	if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compat ideographs
	if (cp >= 0xfe30 && cp <= 0xfe4f) return 2; // CJK compat forms
	if (cp >= 0xff00 && cp <= 0xff60) return 2; // Fullwidth ASCII/forms
	if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
	if (cp > 0xffff) return 2; // astral (emoji) via surrogate halves
	return 1;
}

export function visualWidth(text: string): number {
	let w = 0;
	for (const ch of clean(text)) w += charVisualWidth(ch.codePointAt(0) ?? 0);
	return w;
}

// Width-safe row cap for select lists (pi's visual-truncate, host
// paint-layer edition): overlong rows get … instead of wrapping the
// frame. BAML frames keep truncate_chars (char-count); modal rows come
// through here.
export function truncateVisual(text: string, max: number): string {
	const plain = clean(text);
	if (visualWidth(plain) <= max) return plain;
	let w = 0;
	let out = "";
	for (const ch of plain) {
		const cw = charVisualWidth(ch.codePointAt(0) ?? 0);
		if (w + cw + 1 > max) break; // +1 reserves the …
		w += cw;
		out += ch;
	}
	return out + "…";
}

// BorderedLoader: pi's loader-with-borders for async waits (login
// bi#94, refresh bi#89 wire it when they land). Structural contract:
// border / loader / [spacer + cancel hint] / spacer / border.
// Lifecycle: constructing the loader starts its tick — the hosting
// modal must stop() it on teardown or the interval outlives the dialog.
export function makeBorderedLoader(ui: TUI, message: string, opts: { cancellable?: boolean } = {}): Container {
	const cancellable = opts.cancellable ?? true;
	const border = new DynamicBorder();
	const root = new Container();
	root.addChild(border);
	if (cancellable) {
		root.addChild(new CancellableLoader(ui, (s) => s, (s) => s, message));
	} else {
		root.addChild(new Loader(ui, (s) => s, (s) => s, message));
	}
	if (cancellable) {
		root.addChild(new Spacer(1));
		root.addChild(new Text("esc — cancel", 1, 0));
	}
	root.addChild(new Spacer(1));
	root.addChild(border);
	return root;
}

// Select-list prompt. Null means "no pick made" (Esc/Ctrl-C): callers
// keep their list-only path. Pipes and BI_SCREEN=0 never reach here.
export async function pickList(title: string, rows: ScreenRow[], initial = 0): Promise<number | null> {
	if (rows.length === 0) return null;
	return runModal<number | null>((ui, root) => {
		// bi#108: every modal picker shares one frame — DynamicBorder
		// top/bottom (live width per render) and a width-capped title.
		// Row bodies are width-safe inside SelectList itself.
		const border = new DynamicBorder();
		root.addChild(border);
		const items: SelectItem[] = rows.map((r) => ({
			value: r.label,
			label: clean(r.label),
			description: r.description === undefined ? undefined : clean(r.description),
		}));
		root.addChild(new Text(truncateVisual(title, termWidth())));
		const list = new SelectList(items, 10, plainListTheme);
		list.setSelectedIndex(Math.min(Math.max(initial, 0), items.length - 1));
		root.addChild(list);
		root.addChild(border);
		const wait = new Promise<number | null>((resolve) => {
			list.onSelect = (item) => {
				const at = items.indexOf(item);
				resolve(at === -1 ? null : at);
			};
			list.onCancel = () => resolve(null);
		});
		return { wait, focus: list };
	});
}
