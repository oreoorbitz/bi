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
	SelectList,
	Spacer,
	Text,
	getKeybindings,
	matchesKey,
	setKeybindings,
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Component,
	type EditorOptions,
	type EditorTheme,
	type Focusable,
	type OverlayAnchor,
	type OverlayMargin,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { complete_arg, complete_slash, editor_side_border, prompt_glyph, rank_selector_rows, render_editor_bottom_border, render_editor_top_border, style_segment } from "../baml_sdk/index.js";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentKeybindingsManager } from "./keybindings.js";
import { PasteBurst } from "./paste-burst.js";
import { splitSecondWord } from "./paths.js";
import { getBiSessionsDir } from "./session.js";
import { chromeWrap } from "./theme-files.js";
import { disposeReplTui, ensureReplTui, replTuiLeased, termWidth } from "./tui.js";

export interface ScreenRow {
	label: string;
	description?: string;
	// bi#85: per-row fuzzy haystack (BAML model_selector_search_text for
	// /model). Absent: cleaned "label description", so /resume display
	// lines narrow on their id/label/cwd text with no caller change.
	searchText?: string;
}

// Pure haystack builder (headless-testable): the override wins,
// otherwise the cleaned label plus description.
export function rowSearchTexts(rows: ScreenRow[]): string[] {
	return rows.map((r) => {
		if (r.searchText !== undefined) return r.searchText;
		const label = clean(r.label);
		return r.description === undefined ? label : `${label} ${clean(r.description)}`;
	});
}

// bi#193: select rows color through the chrome palette (host wraps known
// segments at paint time — these identity passthroughs were the hook):
// the selected row pops primary, the description column (session picker
// timestamps/ids ride it) and scroll/no-match chrome recede. chromeWrap
// is a byte-identical passthrough under BI_THEME=none / NO_COLOR, and
// every consumer is a TTY-only modal, so pipes never see a byte.
// Row labels stay plain through clean(): per-row SGR would fight the
// whole-row selectedText wrap, so meta dimming lives in the description
// channel, which pi-tui styles per row without a selection conflict.
const chromeSelectList = {
	selectedPrefix: (s: string) => chromeWrap("primary", s),
	selectedText: (s: string) => chromeWrap("primary", s),
	description: (s: string) => chromeWrap("text_dim", s),
	scrollInfo: (s: string) => chromeWrap("text_muted", s),
	noMatch: (s: string) => chromeWrap("text_muted", s),
};
const plainEditorTheme: EditorTheme = { borderColor: (s) => s, selectList: chromeSelectList };
const plainListTheme: SelectListTheme = { ...chromeSelectList };

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
// bi#153: narrow-terminal word-wrap guard. Stock upstream wordWrapLine
// recurses forever when one indivisible grapheme is wider than the wrap
// width (`wordWrapLine('你', 1)` → RangeError: Maximum call stack size
// exceeded), killing the REPL in a 1-3-column tmux/SSH pane. Kimi's fork
// guards inside wordWrapLine (editor.ts:170-180: single-grapheme check,
// keep the chunk, let paint truncate); bi depends on stock pi-tui (bi#114
// "depend, don't rebuild": no vendoring/patching of node_modules), so the
// guard lives here: render() widens the width handed to super just enough
// that no single grapheme exceeds the layout, then truncates the laid-out
// lines back to the real width — degrade via truncate, same as the fork.
// Indivisibility is grapheme-count-based (Intl.Segmenter, not code-unit
// `.length`: ZWJ emoji is one grapheme but many UTF-16 units).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

// Grapheme count, capped at 2 (only the 1-vs-many distinction matters).
function graphemeCount(text: string): number {
	let n = 0;
	for (const _ of graphemeSegmenter.segment(text)) {
		n += 1;
		if (n > 1) return n;
	}
	return n;
}

// Wrap-width floor for a buffer: every indivisible (single-grapheme) word
// unit must fit, else stock wordWrapLine recurses on it. Multi-grapheme
// units re-split at grapheme granularity inside wordWrapLine, so they never
// recurse and set no floor. Widths come from pi-tui visibleWidth — the same
// measure wordWrapLine uses. Minimum 2 (CJK needs 2 cells).
function editorWrapFloor(text: string): number {
	let floor = 2;
	for (const { segment } of wordSegmenter.segment(text)) {
		if (graphemeCount(segment) > 1) continue;
		const w = visibleWidth(segment);
		if (w > floor) floor = w;
	}
	return floor;
}

// bi#181: editor border color roles (BAML theme roles via style_segment
// — the existing theme mechanism; activeTheme() gating in cli.ts already
// resolves null on pipes/NO_COLOR, and null renders byte-identical
// plain). bi#185 wiring note: when the palette token system lands
// (theme.baml/theme-files.ts, sibling-owned), swap these role names for
// palette tokens (kimi: primary for `/`-command input, muted otherwise;
// a third token for modal/approval-owns-focus) — the only call sites
// are these constants and PromptEditor.render below. Do not edit the
// theme files from here.
const EDITOR_BORDER_ROLE_IDLE = "dim";
const EDITOR_BORDER_ROLE_COMMAND = "accent";

// Strip SGR spans (kimi stripSgr) — border detection measures the
// visible row, styling is reapplied by the paint fn.
function stripSgr(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

// bi#181: post-process pi-tui's editor output into kimi's rounded box
// (custom-editor.ts wrapWithSideBorders :807-857 port). Dash-rule rows
// become ╭╮/╰╯ borders (the BAML-shaped label splices into the top
// border; scroll-indicator rows keep their middle text), content rows
// get │ side bars — only over LITERAL SPACES, so the SGR inverse
// cursor cell (including the cursor-overflow-into-padding case) is
// never overwritten. Render-only: no stdin ownership (bi#162/179).
function wrapEditorLines(lines: string[], paint: (s: string) => string, label: string): string[] {
	const side = editor_side_border();
	let seenTop = false;
	return lines.map((line) => {
		const plain = stripSgr(line);
		if (plain.length > 0 && plain[0] === "─") {
			const isTop = !seenTop;
			seenTop = true;
			if (plain.length === 1) return paint(isTop ? "╭" : "╰");
			const middle = plain.slice(1, -1);
			if (/^─+$/.test(middle)) {
				return paint(isTop ? render_editor_top_border(label, plain.length) : render_editor_bottom_border(plain.length));
			}
			return paint((isTop ? "╭" : "╰") + middle + (isTop ? "╮" : "╯"));
		}
		if (line.length === 0) return line;
		const firstCh = line[0];
		const lastCh = line[line.length - 1];
		const head = firstCh === " " ? paint(side) : firstCh ?? "";
		const tail = line.length > 1 && lastCh === " " ? paint(side) : lastCh ?? "";
		if (line.length === 1) return head;
		return head + line.slice(1, -1) + tail;
	});
}

// bi#181: overlay the `>` glyph on the first content line at column 2
// (kimi injectPromptSymbol :792-803 port). Column 0 is the left side
// bar (overlaid by wrapEditorLines), column 1 a gap, column 3 separates
// the glyph from content. Relies on the editor being constructed with
// paddingX >= 4 so the line starts with four literal spaces; returns
// the line unchanged otherwise — the cursor cell is never overwritten.
function injectPromptGlyph(line: string, glyph: string): string {
	if (line.length < 4) return line;
	for (let i = 0; i < 4; i++) {
		if (line[i] !== " ") return line;
	}
	return "  " + glyph + " " + line.slice(4);
}

export class PromptEditor extends Editor {
	onEscape?: () => void;
	onCtrlD?: () => void;
	// bi#181: the BAML-shaped prompt label (format_prompt_label, e.g.
	// "bi[0]>") rendered INTO the rounded top border, and the active
	// theme name for border colors (null = plain). Set by askEdit.
	promptLabel = "";
	borderTheme: string | null = null;
	constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
		super(tui, theme, options);
	}
	// bi#90: Ctrl+P model cycling (pi's app.model.cycleForward). Fires only
	// when the autocomplete list is closed (open: the list owns control keys)
	// and never inserts into the buffer. Unset (readline fallback callers):
	// ctrl+p falls through to the Editor, which ignores it.
	onCycleForward?: () => void;
	// bi#154: paste-burst guard (kimi paste-burst.ts port). While the
	// autocomplete list is closed, an Enter arriving inside a burst
	// window inserts a newline instead of submitting; printable input
	// feeds the detector, anything else (arrows, Tab, edits) resets it.
	// Autocomplete-open input is untouched — the list owns Enter there.
	private pasteBurst = new PasteBurst();
	// bi#183: negotiation-straggler suppression. Indicted path (drill:
	// scripts/paint-chain-junk.mjs, RED record in its header): a kitty/DA
	// reply split across pi-tui's 150ms negotiation-fragment flush
	// (terminal.js KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS) has its
	// `\x1b[?…` prefix forwarded as input and its tail (`u`,
	// `4;1;…;52c`) delivered as PLAIN TEXT — and StdinBuffer emits plain
	// text ONE CHARACTER per sequence, so the tail arrives as a digit/
	// semicolon run closed by a lone `u`/`c`. super.handleInput would
	// insert the run into the buffer — the bi-cli-latest.png junk-glyph
	// class (proposals/14). Draining before focus cannot cover an
	// unboundedly late straggler, so the suppression lives at the
	// insertion point as a small state machine: a flushed prefix arms a
	// 500ms window; inside it, `[\d;]` chars are buffered speculatively
	// and a closing `u`/`c` drops the whole run; any other input flushes
	// the buffer as real text (fail-open — never eat typing). Bounded
	// and named (bi#55); every drop/flush is tap-logged.
	private negotiationTailUntil = 0;
	private negotiationTailBuf = "";
	// Returns null when the chunk is fully consumed (a straggler), else
	// the chunk to process normally.
	private suppressNegotiationStragglers(data: string, now: number): string | null {
		// Whole late reply that leaked the Terminal's negotiation parser
		// (defense-in-depth: the parser consumes these when they arrive
		// complete, e.g. after a drain/pop cycle).
		if (/^\x1b\[\?[\d;]*[uc]$/.test(data)) {
			tapEvent(`suppress-neg whole ${JSON.stringify(data.slice(0, 40))}`);
			return null;
		}
		// Flushed fragment prefix: drop it and arm the tail window — the
		// tail follows as plain text within a link's jitter bound.
		if (/^\x1b\[\?[\d;]*$/.test(data)) {
			this.negotiationTailUntil = now + 500;
			this.negotiationTailBuf = "";
			tapEvent(`suppress-neg prefix ${JSON.stringify(data.slice(0, 40))}`);
			return null;
		}
		if (this.negotiationTailUntil === 0) return data;
		if (now >= this.negotiationTailUntil) {
			// Window expired with an unterminated run: fail-open, the
			// buffered chars are emitted as real input below.
			this.negotiationTailUntil = 0;
			return this.flushNegotiationTail(data, "expire");
		}
		if (/^[\d;]+$/.test(data)) {
			this.negotiationTailBuf += data;
			return null;
		}
		if (/^[\d;]*[uc]$/.test(data)) {
			tapEvent(`suppress-neg tail ${JSON.stringify((this.negotiationTailBuf + data).slice(0, 40))}`);
			this.negotiationTailBuf = "";
			this.negotiationTailUntil = 0;
			return null;
		}
		// Not tail-shaped: the run was typing (or a truncated tail) —
		// fail-open and process the current chunk normally.
		this.negotiationTailUntil = 0;
		return this.flushNegotiationTail(data, "mismatch");
	}
	private flushNegotiationTail(data: string, why: string): string {
		const pending = this.negotiationTailBuf;
		this.negotiationTailBuf = "";
		if (pending) {
			tapEvent(`suppress-neg flush-${why} ${JSON.stringify(pending.slice(0, 40))}`);
			for (const ch of pending) super.handleInput(ch);
		}
		return data;
	}
	handleInput(data: string): void {
		const suppressed = this.suppressNegotiationStragglers(data, Date.now());
		if (suppressed === null) return;
		data = suppressed;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") && !this.isShowingAutocomplete()) {
			this.onEscape?.();
			return;
		}
		if (matchesKey(data, "ctrl+d") && this.getText().length === 0) {
			this.onCtrlD?.();
			return;
		}
		// bi#156: app-level model cycle through the manager (remappable via
		// keybindings.json like every tui.* id) — never a hardcoded matcher.
		if (!this.isShowingAutocomplete() && this.onCycleForward && kb.matches(data, "bi.model.cycleForward")) {
			this.onCycleForward();
			return;
		}
		// bi#155: confirming an inline skill with Enter applies the
		// highlighted completion WITHOUT submitting (kimi divergence 8,
		// host-side: stock AutocompleteItem carries no `data` marker, so
		// the inline-token position decides). Stock Tab already applies
		// without submitting, so Enter is translated to Tab. First-word
		// slash and second-word arg Enters never match the inline token
		// and keep stock behavior exactly (bi#115 guard intact).
		const showing = this.isShowingAutocomplete();
		if (showing && kb.matches(data, "tui.select.confirm")) {
			const cur = this.getCursor();
			if (inlineSlashTokenAt(this.getLines(), cur.line, cur.col) !== null) {
				super.handleInput("\t");
				return;
			}
		}
		const now = Date.now();
		const isEnter =
			kb.matches(data, "tui.input.submit") ||
			kb.matches(data, "tui.select.confirm") ||
			kb.matches(data, "tui.input.newLine");
		if (!showing && isEnter && this.pasteBurst.shouldInsertNewlineInsteadOfSubmit(now)) {
			this.pasteBurst.extendWindow(now);
			this.insertTextAtCursor("\n");
			return;
		}
		if (!showing) {
			if (data.length === 1 && data.charCodeAt(0) >= 32) this.pasteBurst.onPlainChar(now);
			else if (!isEnter) this.pasteBurst.reset();
		}
		super.handleInput(data);
	}
	// bi#153: clamp the effective wrap width. Unpadded layout reserves one
	// cursor column (layoutWidth = width - 1), so super needs at least
	// floor + 1; laid-out lines are truncated back to the real width so no
	// painted line exceeds the terminal.
	// bi#181: the laid-out lines are then post-processed into kimi's
	// rounded box — the BAML-shaped label splices into the top border,
	// the `>` glyph lands at column 2 of the first content row, and the
	// border paint flips role when the buffer is a `/`-command.
	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const need = editorWrapFloor(this.getText()) + 1;
		const base = need <= w ? super.render(w) : super.render(need).map((line) => truncateToWidth(line, w));
		const role = this.getText().startsWith("/") ? EDITOR_BORDER_ROLE_COMMAND : EDITOR_BORDER_ROLE_IDLE;
		const paint = (s: string) => style_segment(s, role, this.borderTheme);
		let glyphDone = false;
		const withGlyph = base.map((line) => {
			// First content row only: dash-rule rows and short/padded
			// variants fall through untouched (narrow terminals degrade
			// to no glyph, never a clobbered cursor).
			if (!glyphDone && !stripSgr(line).startsWith("─")) {
				const next = injectPromptGlyph(line, prompt_glyph());
				if (next !== line) glyphDone = true;
				return next;
			}
			return line;
		});
		return wrapEditorLines(withGlyph, paint, this.promptLabel);
	}
}

export interface SlashPool {
	// Slash names without the leading "/" (builtins + skills).
	names: () => string[];
	// bi#155: skills-only view over the SAME live pool (no second list
	// to drift — the closure reads the same array `names()` does).
	// The inline mid-prompt picker lists skills only; absent: inline
	// falls back to `names()`.
	skillNames?: () => string[];
	describe: (name: string) => string | null;
	argPool: (cmd: string, prefix: string) => Promise<string[]>;
}

// bi#155: inline slash token at the cursor (kimi `isAtInlineSlashTrigger`
// + `isInInlineSlashContext`, host-side). A `/`-token counts when it
// follows whitespace on any line, or opens a later line of a
// multi-line draft. Token chars mirror kimi (`[A-Za-z0-9._-:]` — `:`
// covers `/skill:<name>` tokens). Prose slashes (`src/foo`, `1/2`)
// have no whitespace boundary and never match. Returns the token
// (slash included) or null. Pure — headless-tested.
export function inlineSlashTokenAt(lines: string[], cursorLine: number, cursorCol: number): string | null {
	const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
	const mid = before.match(/[ \t](\/[A-Za-z0-9._:-]*)$/);
	if (mid) return mid[1]!;
	if (cursorLine > 0) {
		const late = before.match(/^(\/[A-Za-z0-9._:-]*)$/);
		if (late) return late[1]!;
	}
	return null;
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
		// bi#159: plain and quoted second words split in one helper (the
		// match key keeps its quote so quoted values survive BAML
		// ranking). Path values carry their own suffix (dir `/`, file
		// space), so the shared splice below needs no change; directory
		// continuation re-enters through this same branch.
		const split = splitSecondWord(line);
		if (split) {
			if (!pool.names().includes(split.cmd)) return null;
			const matches = complete_arg(split.token, await pool.argPool(split.cmd, split.token));
			if (matches.length === 0) return null;
			return {
				items: matches.map((m): AutocompleteItem => ({ value: m, label: m })),
				prefix: split.token,
			};
		}
		// bi#155: inline `/`-token mid-prompt (after whitespace, or
		// opening a later line) completes loaded skills only through
		// the same BAML `complete_slash` matcher. First-word behavior
		// below is byte-identical to before.
		const inline = inlineSlashTokenAt(lines, cursorLine, cursorCol);
		if (inline !== null) {
			const skillPool = pool.skillNames ? pool.skillNames() : pool.names();
			const inlineMatches = complete_slash(inline, skillPool);
			if (inlineMatches.length === 0) return null;
			return {
				items: inlineMatches.map((m): AutocompleteItem => ({
					value: m,
					label: m,
					description: pool.describe(m.replace(/^\//, "")) ?? undefined,
				})),
				prefix: inline,
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
//
// bi#183 soft/hard cap: the original flat 450ms cap focused the modal
// EVEN WITH BYTES STILL LANDING — bytewise/tmux delivery of one reply
// spans past the cap (29 bytes × 5-30ms ≈ 500ms+), so the remaining
// tail typed into the freshly focused widget (pty proof: the trust
// picker's filter read `;21;22;52c` and the chain wedged on "No
// matching commands"). The soft cap now requires the quiet window too
// — an active link holds focus off — and a 3s hard cap bounds a
// pathological input stream (named residual risk, same as before).
async function settleNegotiation(term: { kittyProtocolActive: boolean; modifyOtherKeysActive: boolean }): Promise<void> {
	const step = 5;
	const quietNeeded = 100;
	// 450ms covers the slow-link band on links that have gone quiet
	// (every reply byte within ~450ms of the query, mid-reply stalls
	// included). Bytes still arriving AT the soft cap extend the wait
	// (per the header comment); the 3s hard cap is the named bound.
	const cap = 450;
	const hardCap = 3000;
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
			if (waited >= cap && quiet >= quietNeeded) break;
			if (waited >= hardCap) break;
			await new Promise((r) => setTimeout(r, step));
			waited += step;
			quiet += step;
		}
	} finally {
		process.stdin.removeListener("data", bump);
	}
}

// One modal as an overlay on the REPL-lifetime host (bi#162, kimi
// tui.ts:552-661 mirror): showOverlay records preFocus and centers
// with margins; hide() restores focus and repaints the base frame —
// no terminal re-init, no kitty re-query per dialog. Only the first
// modal on a host settles the negotiation (bi#119 envelope, kept as
// defense-in-depth); later modals skip it, and BI_MODAL_SETTLE=0
// skips even the first for the drill proof that the overlay path
// removed the re-query. Per-modal teardown is just the overlay hide:
// drainInput per modal would pop the SHARED kitty flags (it pops one
// stack level) and re-open the release storm for the next modal, so
// the drain/pop/stop envelope runs once at host dispose instead.
// ~/.bi log dir, never pi's: the screen's debug log must not leak
// into the reference checkout's agent dir.
async function runModal<T>(
	build: (ui: TUI, root: Container) => { wait: Promise<T>; focus: Component },
	overlayOpts: { anchor?: OverlayAnchor; margin?: OverlayMargin | number } = {},
): Promise<T> {
	if (!promptAvailable()) throw new Error("prompt modal: no TTY");
	// bi#91: library defaults plus the user's validated ~/.bi overrides
	// (currentKeybindingsManager) — still the library's matching, no
	// homegrown input handling.
	setKeybindings(currentKeybindingsManager());
	const host = ensureReplTui(dirname(getBiSessionsDir()));
	const { ui } = host;
	ensureTap();
	tapEvent("modal-start");

	const overlay = new Container();
	const { wait, focus } = build(ui, overlay);
	// Full-viewport overlay (not the library's default centered
	// min(80)-col box): pre-162 modals owned a fresh fullscreen TUI
	// with the root laid out top-left at terminal width. margin 0 +
	// width 100% + top-left anchor reproduces that geometry, so wide
	// terminals get full-width frames instead of a floating box.
	// Callers may bottom-anchor instead (the main editor): the box
	// shrink-wraps content and the clamp keeps it inside the margins,
	// so bottom margin 2 glues it above the pinned footer rows.
	const handle = ui.showOverlay(overlay, {
		margin: overlayOpts.margin ?? 0,
		width: "100%",
		anchor: overlayOpts.anchor ?? "top-left",
	});
	// bi#179: turn output bypasses TUI composition (console.log), so a
	// remounted overlay at the same geometry diffs equal on rows the
	// previous modal already painted and the prompt mounts invisibly
	// (input alive, second bi[0]> never painted: pty proof showed the
	// mount render painting only rows the guess height covered while
	// the prompt Text row diffed equal against the stale prev-frame —
	// the bypass output had scrolled the physical screen without the
	// library knowing). Dirty the overlay span so the pending render
	// repaints exactly the box and skips everything else (transcript +
	// footer survive — a full repaint would blank them, and extending
	// prev would punch holes that crash the renderer's image scan).
	// Geometry mirrors the compositor (resolveAnchorRow: bottom-*
	// anchors sit at marginTop + availHeight - height). The editor box
	// measures up to 4 rows tall (bi#181: rounded top border with the
	// label spliced in + content + bottom border — the separate Text
	// label row is gone), so resolve with height 4 for a true top row
	// and dirty the top 3 functional rows — never the bottom-most row
	// (footer-divider ownership is ambiguous and a stale rule there is
	// cosmetic, while a forced repaint of a model-empty footer row
	// would blank it). Over-resolving by one row is deliberate: the top
	// border carries the per-turn label (bi[0]> → bi[1]>), so it must
	// always be inside the dirtied span on remount. Other (top-anchored)
	// modals keep the conservative 3-row span from row 0.
	try {
		const prev = (ui as unknown as { previousLines?: unknown }).previousLines;
		const resolveLayout = (ui as unknown as {
			resolveOverlayLayout?: (o: unknown, h: number, w: number, hh: number) => { width: number; row: number; col: number };
		}).resolveOverlayLayout;
		const termW = (host.term as unknown as { columns?: number }).columns ?? process.stdout.columns ?? 80;
		const termH = (host.term as unknown as { rows?: number }).rows ?? process.stdout.rows ?? 24;
		const base = { margin: overlayOpts.margin ?? 0, width: "100%", anchor: overlayOpts.anchor ?? "top-left" };
		if (Array.isArray(prev) && typeof resolveLayout === "function") {
			const anchoredBottom = (overlayOpts.anchor ?? "top-left").startsWith("bottom");
			const box = resolveLayout.call(ui, base, anchoredBottom ? 4 : 2, termW, termH);
			const H = 3;
			if (Number.isInteger(box.row) && box.row >= 0 && box.row + H <= prev.length) {
				for (let i = box.row; i < box.row + H; i++) prev[i] = "\u2060";
			}
		}
	} catch {
		// Dirtying failed — fall back to the plain differential.
	}
	if (process.env.BI_MODAL_SETTLE !== "0") await settleNegotiation(host.term);
	host.settled = true;
	tapEvent(`focus kitty=${host.term.kittyProtocolActive} modkeys=${host.term.modifyOtherKeysActive}`);
	ui.setFocus(focus);
	// bi#179 reset step: whoever owned stdin before this modal leaves
	// it unusable for TUI input — readline's suspendLineInput closes
	// the interface, and node readline's close pauses stdin and
	// restores cooked mode. The shared host's start() ran once, so
	// nothing re-asserts: the modal would idle on a dead stdin and
	// the loop drains (silent exit 0, the post-picker vanish).
	// Fresh-host-per-modal never saw this because every start()
	// re-asserted raw + resume. Re-assert here, after settle (whose
	// .on also resumes, but only while it lives) and before input.
	if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
	process.stdin.resume();
	try {
		const result = await wait;
		tapEvent("resolve");
		return result;
	} finally {
		handle.hide();
		tapEvent("overlay-hide");
		// Leased flows (REPL, login) share the host across modals;
		// one-shot users hold no lease, so dispose here or the live
		// stdin listener outlives their modal and hangs the exit.
		if (!replTuiLeased()) await disposeReplTui();
	}
}

// One prompt through the modal editor. Resolves text | "\x03" on
// Esc/Ctrl-C, rejects EOF on Ctrl-D at empty — ReplReader.ask
// byte-for-byte. History is oldest-first (file order); the caller
// persists submissions as before. opts.onCycleForward (bi#90) wires the
// Ctrl+P model-cycle binding; without it the key falls through.
//
// bi#180: staged base-layer content (welcome entry frame + ready BAIS).
// The welcome must render INTO the modal host's base layer, but creating
// the host fires the kitty negotiation — that must only ever happen
// inside the modal envelope (readline suspended, raw asserted before
// the query, settle before focus): staging here and mounting in askEdit
// below keeps it so. Outside the envelope a reply races readline's
// listener, which echoes it as caret-notation keypresses (the
// `^[[?64;1;2…52c` leak, e2e-pty no-reply-bytes invariant).
let stagedBaseLines: string[] | null = null;
export function stageBaseFrame(lines: string[]): void {
	stagedBaseLines = lines;
}
export async function askEdit(
	prompt: string,
	history: string[],
	pool: SlashPool,
	opts: { onCycleForward?: () => void; theme?: string | null } = {},
): Promise<string> {
	// Bottom-anchored above the two pinned footer rows (bi#67): the
	// box shrink-wraps prompt + editor and the overlay clamp keeps it
	// inside the margins, so the input draws glued to the footer and
	// grows upward as it wraps — never over the footer. All other
	// modals keep the top-left geometry (runModal default).
	return runModal<string>((ui, root) => {
		// bi#180: mount staged base-layer content (welcome frame) into the
		// host root first — it composites under this and every later
		// modal. Runs inside the modal envelope, so a host created for
		// this modal negotiates with readline already detached.
		if (stagedBaseLines) {
			ui.addChild(new Text(stagedBaseLines.join("\n"), 0, 0));
			stagedBaseLines = null;
		}
		// bi#181: no separate label row — the BAML-shaped prompt label
		// lives IN the editor's rounded top border and the `>` glyph at
		// column 2 inside the box (kimi CustomEditor composition).
		// paddingX 4 makes room for the glyph (kimi's injectPromptSymbol
		// precondition).
		const ed = new PromptEditor(ui, plainEditorTheme, { paddingX: 4 });
		ed.promptLabel = prompt;
		ed.borderTheme = opts.theme ?? null;
		for (const h of history) ed.addToHistory(h);
		ed.setAutocompleteProvider(makeSlashProvider(pool));
		if (opts.onCycleForward) ed.onCycleForward = opts.onCycleForward;
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
	}, { anchor: "bottom-left", margin: { top: 0, left: 0, right: 0, bottom: 2 } });
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

// bi#195: masked single-line input for API keys — the same Input widget
// and modal envelope as askText (one runModal, Esc resolves null), but
// render() swaps the buffer for bullets before painting and restores it
// after, so the real key never reaches the pty byte stream. The modal
// keeps no history (never persisted, unlike the editor's). Cursor math
// is untouched: bullets are width-1 and map 1:1 to buffer chars, so
// super.render's scrolling/cursor columns stay exact. Debug note:
// BI_TUI_DEBUG's observe-only raw-stdin tap still records typed bytes
// (it wraps the process, not the widget) — same opt-in exposure as any
// typing under the tap; the store/echo/history guarantees stand.
class SecretInput extends Input {
	render(width: number): string[] {
		const self = this as unknown as { value: string };
		const real = self.value;
		self.value = "•".repeat(real.length);
		try {
			return super.render(width);
		} finally {
			self.value = real;
		}
	}
}

// Hidden-secret prompt (interactive /login key entry, bi#195). Null
// means cancelled (Esc): callers store nothing. Empty submit resolves
// "" — the caller's empty check treats it as cancel too. Pipes and
// BI_SCREEN=0 never reach here (runModal throws on no TTY; the caller
// guards with promptAvailable for a named refusal first).
export async function askSecret(title: string): Promise<string | null> {
	return runModal<string | null>((ui, root) => {
		root.addChild(new Text(title));
		const input = new SecretInput();
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

// bi#69: filter-as-you-type atop stock pi-tui widgets. FilterList is a
// pi ModelSelector-shaped composite (stock Input filter row + stock
// SelectList, focus propagated to the input for the cursor) — no
// homegrown key parsing: nav/confirm/cancel route by library
// getKeybindings().matches, everything else falls into the Input and
// refilters. SelectList itself only does prefix-on-value setFilter, so
// the composite owns the subset and rebuilds the list per keystroke.
// Resolution is ALWAYS the caller's original row index (callers map
// positionally: /resume list[pick], screen-model models[at]), never the
// filtered position. Non-empty queries reset to the top row (pi's
// selector does the same); clearing restores the kept selection.
// The rank core is BAML fuzzy (bi#85); bi#90 owns Ctrl+P cycling
// (until then Ctrl+P lands in the filter text, which ignores it).
export interface FilterRow {
	item: SelectItem;
	orig: number;
	haystack: string;
}

export class FilterList extends Container implements Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.filter.focused = value;
	}
	private filter = new Input();
	private holder = new Container();
	private list: SelectList | null = null;
	private visible: FilterRow[] = [];
	private keptOrig = 0;

	constructor(
		private all: FilterRow[],
		initial: number,
		private rank: (query: string) => FilterRow[],
		private onResolve: (orig: number | null) => void,
	) {
		super();
		this.keptOrig = Math.min(Math.max(initial, 0), Math.max(0, all.length - 1));
		this.addChild(this.filter);
		this.addChild(this.holder);
		this.refilter(true);
	}

	// Test hooks (headless: no TTY needed, same as PromptEditor cases).
	getFilterValue(): string {
		return this.filter.getValue();
	}
	visibleOriginals(): number[] {
		return this.visible.map((r) => r.orig);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm")
		) {
			this.list?.handleInput(data);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onResolve(null);
			return;
		}
		this.filter.handleInput(data);
		this.refilter(false);
	}

	private refilter(first: boolean): void {
		const q = this.filter.getValue();
		const cur = this.list?.getSelectedItem() ?? null;
		if (cur) {
			const kept = this.visible.find((r) => r.item === cur);
			if (kept) this.keptOrig = kept.orig;
		}
		this.visible = this.rank(q);
		const next = new SelectList(
			this.visible.map((r) => r.item),
			10,
			plainListTheme,
		);
		next.onSelect = (item) => {
			const hit = this.visible.find((r) => r.item === item);
			this.onResolve(hit ? hit.orig : null);
		};
		next.onSelectionChange = (item) => {
			const hit = this.visible.find((r) => r.item === item);
			if (hit) this.keptOrig = hit.orig;
		};
		this.holder.clear();
		this.holder.addChild(next);
		this.list = next;
		if (first) {
			next.setSelectedIndex(Math.min(this.keptOrig, Math.max(0, this.visible.length - 1)));
		} else if (q.length > 0) {
			next.setSelectedIndex(0);
		} else {
			const at = this.visible.findIndex((r) => r.orig === this.keptOrig);
			next.setSelectedIndex(at < 0 ? 0 : at);
		}
	}
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
		// bi#85 rank core: BAML fuzzy over per-row search texts
		// (rowSearchTexts above). BAML returns ranked ORIGINAL indices —
		// the empty query lists all, pipes never reach here.
		const texts = rowSearchTexts(rows);
		const all: FilterRow[] = items.map((item, i) => ({
			item,
			orig: i,
			haystack: texts[i],
		}));
		const rank = (query: string): FilterRow[] => {
			const out: FilterRow[] = [];
			for (const o of rank_selector_rows(query, texts) as number[]) {
				const r = all[o];
				if (r !== undefined) out.push(r);
			}
			return out;
		};
		let list!: FilterList;
		const wait = new Promise<number | null>((resolve) => {
			list = new FilterList(all, initial, rank, resolve);
		});
		root.addChild(list);
		root.addChild(border);
		return { wait, focus: list };
	});
}

// Select-list prompt with a live preview pane (bi#105 theme selector —
// pi's ThemeSelectorComponent shape: onSelectionChange repaints the
// preview, Enter commits, Esc keeps). previewFor maps the highlighted
// ORIGINAL row index to preview text; a sequence guard keeps a slow
// preview from overwriting a newer highlight. Short lists only (no
// filter row — theme catalogs are a handful of rows). Null means "no
// pick made" (Esc/Ctrl-C): callers keep their list-only path. Pipes
// and BI_SCREEN=0 never reach here.
export async function pickListWithPreview(
	title: string,
	rows: ScreenRow[],
	initial = 0,
	previewFor: (index: number) => Promise<string>,
): Promise<number | null> {
	if (rows.length === 0) return null;
	return runModal<number | null>((ui, root) => {
		const border = new DynamicBorder();
		root.addChild(border);
		const items: SelectItem[] = rows.map((r) => ({
			value: r.label,
			label: clean(r.label),
			description: r.description === undefined ? undefined : clean(r.description),
		}));
		root.addChild(new Text(truncateVisual(title, termWidth())));
		const list = new SelectList(items, 8, plainListTheme);
		root.addChild(list);
		const preview = new Text("");
		root.addChild(preview);
		root.addChild(border);
		// Live preview: every highlight (including the initial one)
		// repaints the pane below the list before commit.
		let seq = 0;
		const show = (index: number) => {
			seq += 1;
			const at = seq;
			void previewFor(index).then((text) => {
				if (at !== seq) return;
				preview.setText(text);
				ui.invalidate();
			});
		};
		const wait = new Promise<number | null>((resolve) => {
			list.onSelect = (item) => resolve(items.indexOf(item));
			list.onCancel = () => resolve(null);
			list.onSelectionChange = (item) => {
				const at = items.indexOf(item);
				if (at >= 0) show(at);
			};
		});
		const first = Math.max(0, Math.min(initial, items.length - 1));
		list.setSelectedIndex(first);
		show(first);
		return { wait, focus: list };
	});
}
