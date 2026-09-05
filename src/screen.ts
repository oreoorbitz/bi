// bi/src/screen.ts — generic pi-tui select-list primitive (slice 2).
// pi-tui owns the widget (SelectList + focus + keys + repaint); the
// caller owns the rows and maps the picked index through its existing
// numeric contract (same 1:1 split as renderSelectList). Null means
// "no pick made" (Esc/Ctrl-C): callers keep their list-only path.
// BI_SCREEN=0 opts out globally; pipes never qualify.
import {
	Container,
	Input,
	KeybindingsManager,
	ProcessTerminal,
	SelectList,
	Text,
	TuiMainScreen,
	TUI_KEYBINDINGS,
	setKeybindings,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { dirname } from "node:path";
import { getBiSessionsDir } from "./session.js";

export interface ScreenRow {
	label: string;
	description?: string;
}

// Identity theme for now: no chalk in bi's deps, so no color mapping
// yet — selection reads via the → prefix + scroll position.
const plainTheme: SelectListTheme = {
	selectedPrefix: (s) => s,
	selectedText: (s) => s,
	description: (s) => s,
	scrollInfo: (s) => s,
	noMatch: (s) => s,
};

export function screenAvailable(): boolean {
	if (process.env.BI_SCREEN === "0") return false;
	return (
		!!process.stdin.isTTY &&
		!!process.stdout.isTTY &&
		typeof (process.stdin as any).setRawMode === "function"
	);
}

// ANSI never reaches the widget: BAML-shaped rows carry SGR color (and
// pi-tui emits OSC hyperlinks) that would fight pi-tui's own selection
// styling. Indices are unaffected — callers map positionally.
function clean(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;;[^\x07]*\x07/g, "");
}

// Terminal responses a real emulator sends to pi-tui's per-modal kitty
// query (`CSI > flags u CSI ? u CSI c`): kitty flags (`CSI ? 7 u`),
// device attributes (`CSI ? 64;1;2 c`), cursor reports (`CSI r;c R`),
// OSC replies. Replies arriving AFTER ui.stop() would otherwise be
// eaten by readline as typed garbage ("7u64;1;2…" in the prompt).
// Only `?`/`>`-intermediate and CPR shapes are discarded — user keys
// (arrows, F-keys, enhanced `CSI n;m u` presses, bare Esc) never match
// and are preserved via unshift.
const RESPONSE_ONE =
	/(?:\x1b\[[?][0-9;]*u|\x1b\[[?>][0-9;]*c|\x1b\[[0-9]+;[0-9]+R|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

function readBuffered(): string {
	let out = "";
	try {
		for (;;) {
			const chunk = (process.stdin as any).read();
			if (chunk == null) break;
			out += String(chunk);
		}
	} catch {}
	return out;
}

// Discard late negotiation replies after a modal closes, preserving
// real input. stdin is paused here (ui.stop leaves it so); one grace
// wait (~2x a bad SSH RTT) catches stragglers, then anything unmatched
// goes back. A fixed window can't catch every terminal ever —
// stripTerminalResponses at submit covers the value in residual cases.
// Submit-time insurance for replies that outran the drain: strip
// complete terminal-response shapes from a submitted line. User keys
// never match (see RESPONSE_ONE); a pasted terminal dump could
// theoretically lose a DA-shaped run — meaningless bytes anyway.
export function stripTerminalResponses(line: string): string {
	return line.replace(RESPONSE_ONE, "");
}

export async function drainTerminalResponses(graceMs = 150): Promise<void> {
	try {
		process.stdin.pause();
	} catch {}
	let buf = readBuffered();
	await new Promise((r) => setTimeout(r, graceMs));
	buf += readBuffered();
	// Complete matches only — a trailing partial (e.g. bare Esc, the
	// most likely user byte here) is preserved, never eaten.
	buf = buf.replace(RESPONSE_ONE, "");
	if (buf) {
		try {
			(process.stdin as any).unshift(buf);
		} catch {}
	}
}

// Text prompt through the same modal host (slice 6: login code/URL
// entry). Null means cancelled (Esc): callers fall back to their
// line reader or abort, same as the legacy path.
export async function screenAskText(title: string, initial = ""): Promise<string | null> {
	if (!screenAvailable()) return null;
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), false, dirname(getBiSessionsDir()));
	const root = new Container();
	root.addChild(new Text(title));
	const input = new Input();
	if (initial) input.setValue(initial);
	root.addChild(input);
	ui.addChild(root);
	ui.setFocus(input);
	ui.start();
	try {
		return await new Promise<string | null>((resolve) => {
			input.onSubmit = (value) => resolve(value);
			input.onEscape = () => resolve(null);
		});
	} finally {
		ui.stop();
		await drainTerminalResponses();
	}
}

export async function screenPickList(title: string, rows: ScreenRow[], initial = 0): Promise<number | null> {
	if (!screenAvailable() || rows.length === 0) return null;
	const items: SelectItem[] = rows.map((r) => ({
		value: r.label,
		label: clean(r.label),
		description: r.description === undefined ? undefined : clean(r.description),
	}));
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	// ~/.bi log dir, never pi's: the screen's debug log must not leak
	// into the reference checkout's agent dir.
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), false, dirname(getBiSessionsDir()));
	const root = new Container();
	root.addChild(new Text(title));
	const list = new SelectList(items, 10, plainTheme);
	list.setSelectedIndex(Math.min(Math.max(initial, 0), items.length - 1));
	root.addChild(list);
	ui.addChild(root);
	ui.setFocus(list);
	ui.start();
	try {
		return await new Promise<number | null>((resolve) => {
			list.onSelect = (item) => {
				const at = items.indexOf(item);
				resolve(at === -1 ? null : at);
			};
			list.onCancel = () => resolve(null);
		});
	} finally {
		ui.stop();
		await drainTerminalResponses();
	}
}
