// bi/src/screen.ts — generic pi-tui select-list primitive (slice 2).
// pi-tui owns the widget (SelectList + focus + keys + repaint); the
// caller owns the rows and maps the picked index through its existing
// numeric contract (same 1:1 split as renderSelectList). Null means
// "no pick made" (Esc/Ctrl-C): callers keep their list-only path.
// BI_SCREEN=0 opts out globally; pipes never qualify.
import {
	Container,
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
	}
}
