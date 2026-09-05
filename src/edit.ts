// bi/src/edit.ts — REPL line editor on pi-tui (slice 3).
// A modal Editor per prompt: Enter submits, Esc/Ctrl-C cancels to
// "\x03" (ReplReader.ask contract), Ctrl-D on empty rejects EOF,
// Ctrl-J is newline, Up recalls preloaded history on an empty buffer
// (pi semantics — with a draft Up moves the cursor). Tab completes
// slashes + second-word args through BAML matchers. Pipes and
// BI_SCREEN=0 never reach here: readline stays the fallback and the
// pick suspend/resume dance (bi#69) is reused around the modal.
import {
	Container,
	Editor,
	KeybindingsManager,
	ProcessTerminal,
	Text,
	TuiMainScreen,
	TUI_KEYBINDINGS,
	setKeybindings,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { complete_arg, complete_slash } from "../baml_sdk/index.js";
import { dirname } from "node:path";
import { getBiSessionsDir } from "./session.js";
import { drainTerminalResponses } from "./screen.js";

const plainSelectList = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};
const plainEditorTheme: EditorTheme = { borderColor: (s) => s, selectList: plainSelectList };

export function editAvailable(): boolean {
	if (process.env.BI_SCREEN === "0") return false;
	return (
		!!process.stdin.isTTY &&
		!!process.stdout.isTTY &&
		typeof (process.stdin as any).setRawMode === "function"
	);
}

export class BiEditor extends Editor {
	onEscape?: () => void;
	onCtrlD?: () => void;
	handleInput(data: string): void {
		// Raw-mode Ctrl-C arrives as data: cancel like Esc (readline's
		// SIGINT-at-prompt resolves "\x03", same outcome one layer down).
		if ((data === "\x1b" || data === "\x03") && !this.isShowingAutocomplete()) {
			this.onEscape?.();
			return;
		}
		if (data === "\x04" && this.getText().length === 0) {
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
			const next = lines.slice();
			const cur = next[cursorLine] ?? "";
			const head = cur.slice(0, cursorCol - prefix.length);
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

// One prompt through the modal editor. Resolves text | "\x03" on
// Esc/Ctrl-C, rejects EOF on Ctrl-D at empty — ReplReader.ask
// byte-for-byte. History is oldest-first (file order); the caller
// persists submissions as before.
export async function screenAskEdit(prompt: string, history: string[], pool: SlashPool): Promise<string> {
	if (!editAvailable()) throw new Error("screenAskEdit: no TTY");
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), false, dirname(getBiSessionsDir()));
	const root = new Container();
	root.addChild(new Text(prompt));
	const ed = new BiEditor(ui, plainEditorTheme);
	for (const h of history) ed.addToHistory(h);
	ed.setAutocompleteProvider(makeSlashProvider(pool));
	root.addChild(ed);
	ui.addChild(root);
	ui.setFocus(ed);
	ui.start();
	try {
		return await new Promise<string>((resolve, reject) => {
			ed.onSubmit = (t) => {
				ed.addToHistory(t);
				resolve(t);
			};
			ed.onEscape = () => resolve("\x03");
			ed.onCtrlD = () => reject(new Error("EOF"));
		});
	} finally {
		ui.stop();
		await drainTerminalResponses();
	}
}
