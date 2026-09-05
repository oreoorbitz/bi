// bi/scripts/edit-tui.mjs — modal editor Tab-provider conformance (slice 3).
// The provider is UI-free (pure BAML match + injected pools), so every
// case runs piped: (1) first word completes slash names with BAML
// descriptions, (2) second word completes the host pool, (3) free text
// and unknown commands complete nothing, (4) applyCompletion splices
// the word and fuses readline's trailing-space step, (5) the modal
// gate stays off pipes. Live submit/cancel/history/recall ride the pty.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { makeSlashProvider, editAvailable } = await import(join(ROOT, "..", "dist", "src", "edit.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const pool = {
	names: () => ["model", "move", "trust"],
	describe: (n) => (n === "model" ? "Pick a model" : null),
	argPool: async (cmd, prefix) => (cmd === "trust" ? ["allow", "deny", "session"] : []).filter((c) => c.startsWith(prefix)),
};
const provider = makeSlashProvider(pool);

// Hotkeys across encodings (BiEditor): raw bytes and kitty CSI u must
// both fire; releases (`:3`) must never fire. Direct handleInput needs
// no TTY. Live kitty proof rides /tmp/fake_term.py (kitty Esc/Ctrl-C/
// Ctrl-D fire, release does not). Red-check: raw compares reinstate
// trip the kitty cases (2 FAIL observed); live pre-fix kitty Ctrl-D
// hung (TIMEOUT) vs post-fix ERROR:EOF.
{
	const { BiEditor } = await import(join(ROOT, "..", "dist", "src", "edit.js"));
	const fire = (bytes) => {
		const ed = new BiEditor({}, { borderColor: (s) => s, selectList: {} });
		const out = [];
		ed.onEscape = () => out.push("esc");
		ed.onCtrlD = () => out.push("ctrld");
		ed.onSubmit = (t) => out.push(`submit:${t}`);
		ed.handleInput(bytes);
		return out.join(",");
	};
	check(fire("\x1b") === "esc", "raw Esc cancels");
	check(fire("\x1b[27u") === "esc", "kitty Esc cancels");
	check(fire("\x03") === "esc", "raw Ctrl-C cancels");
	check(fire("\x1b[99;5u") === "esc", "kitty Ctrl-C cancels");
	check(fire("\x04") === "ctrld", "raw Ctrl-D quits on empty");
	check(fire("\x1b[100;5u") === "ctrld", "kitty Ctrl-D quits on empty");
	check(fire("\x1b[100;5:3u") === "", "release never fires");
	check(fire("\x1b[A") === "", "arrows are not hotkeys");
	check(fire("a") === "", "text is not a hotkey");
}

// 1 — first word.
{
	const s = await provider.getSuggestions(["/mo"], 0, 3, { signal: AbortSignal.abort() });
	check(s !== null && s.prefix === "/mo", "first word returns the typed prefix");
	check(
		s !== null && s.items.map((i) => i.value).join(",") === "/model,/move",
		`first word completes names (got ${JSON.stringify(s && s.items)})`,
	);
	check(
		s !== null && s.items[0].description === "Pick a model" && s.items[1].description === undefined,
		"descriptions attach where BAML has them",
	);
}

// 2 — second word.
{
	const s = await provider.getSuggestions(["/trust "], 0, 7, { signal: AbortSignal.abort() });
	check(
		s !== null && s.items.map((i) => i.value).join(",") === "allow,deny,session",
		`second word completes the host pool (got ${JSON.stringify(s && s.items)})`,
	);
	const p = await provider.getSuggestions(["/trust s"], 0, 8, { signal: AbortSignal.abort() });
	check(p !== null && p.prefix === "s" && p.items.map((i) => i.value).join(",") === "session", "second word filters on the prefix");
}

// 3 — nothing cases.
check((await provider.getSuggestions(["hello"], 0, 5, { signal: AbortSignal.abort() })) === null, "free text completes nothing");
check((await provider.getSuggestions(["/nope "], 0, 6, { signal: AbortSignal.abort() })) === null, "unknown command completes nothing");
check((await provider.getSuggestions(["/zzz"], 0, 4, { signal: AbortSignal.abort() })) === null, "no match is null, not empty");

// 4 — applyCompletion.
{
	const r = provider.applyCompletion(["/mo"], 0, 3, { value: "/model", label: "/model" }, "/mo");
	check(r.lines[0] === "/model " && r.cursorCol === 7, `first-word pick fuses the trailing space (got ${JSON.stringify(r)})`);
	const q = provider.applyCompletion(["/trust s"], 0, 8, { value: "session", label: "session" }, "s");
	check(q.lines[0] === "/trust session" && q.cursorCol === 14, "second-word pick splices without space");
	const mid = provider.applyCompletion(["/mo plus"], 0, 3, { value: "/model", label: "/model" }, "/mo");
	check(mid.lines[0] === "/model  plus", "tail text survives the splice");
}

// 5 — gate.
check(!editAvailable(), "piped suite: modal gate off");

if (failures) process.exit(1);
console.log("edit-tui: all green");
