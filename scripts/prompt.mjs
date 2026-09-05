// bi/scripts/prompt.mjs — prompt.ts conformance (pi-pattern port).
// The provider is UI-free (pure BAML match + injected pools), so every
// case runs piped: (1) first word completes slash names with BAML
// descriptions, (2) second word completes the host pool, (3) free text
// and unknown commands complete nothing, (4) applyCompletion splices
// the word and fuses readline's trailing-space step, (5) the modal
// gate stays off pipes, (6) PromptEditor hotkeys fire across encodings
// (raw bytes and kitty CSI u) and route everything else to super.
// Release handling is pi-tui's (central Tui filter), teardown is pi's
// drainInput-before-stop — neither lives here, so neither is tested
// here; the live kitty proof rides a pty, not this suite.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { makeSlashProvider, promptAvailable, PromptEditor, DynamicBorder, visualWidth, truncateVisual, makeBorderedLoader } = await import(
	join(ROOT, "..", "dist", "src", "prompt.js")
);

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

// Hotkeys across encodings: raw bytes and kitty CSI u must both fire.
// Direct handleInput needs no TTY. Red-check: raw compares reinstate
// trip the kitty cases.
{
	const fire = (bytes) => {
		const ed = new PromptEditor({}, { borderColor: (s) => s, selectList: {} });
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
// bi#115 — stale accept: suggestions computed for "/qu" must not splice
// once the line moved on to "/quit" (Enter-accept of a slow round).
const stale = provider.applyCompletion(["/quit"], 0, 5, { value: "/quit", label: "/quit" }, "/qu");
	check(stale.lines[0] === "/quit" && stale.cursorCol === 5, `stale prefix refuses the splice (got ${JSON.stringify(stale)})`);
const staleSecond = provider.applyCompletion(["/trust session"], 0, 14, { value: "session", label: "session" }, "s");
	check(staleSecond.lines[0] === "/trust session" && staleSecond.cursorCol === 14, "stale second-word prefix refuses too");
}

// 5 — gate.
check(!promptAvailable(), "piped suite: modal gate off");

// 6 — bi#108 dialog chrome primitives.
// DynamicBorder renders a live-width rule, min 1.
{
	const b = new DynamicBorder();
	check(b.render(10)[0] === "─".repeat(10), "border fills the viewport width");
	check(b.render(0)[0] === "─", "border clamps to min 1");
	check(b.render(4)[0] === "────" && new DynamicBorder((s) => `<${s}>`).render(2)[0] === "<──>", "border color fn applies");
}
// visualWidth counts CJK/emoji double, strips ANSI first.
check(visualWidth("hello") === 5, "ascii width");
check(visualWidth("日本") === 4, "cjk counts double");
check(visualWidth("😀") === 2, "astral emoji counts double");
check(visualWidth("\x1b[31mhi\x1b[0m") === 2, "ansi stripped before measuring");
// truncateVisual caps by width with … reserve.
check(truncateVisual("hello", 10) === "hello", "short rows pass through");
check(truncateVisual("hello world", 8) === "hello w…", "ascii truncates with ellipsis");
check(truncateVisual("日本語テスト", 7) === "日本語…", "cjk truncates by width not chars");
check(truncateVisual("\x1b[31mhello world\x1b[0m", 8) === "hello w…", "ansi cleaned before capping");
// makeBorderedLoader shares one frame: border/loader/[spacer+hint]/spacer/border.
{
	const stubUi = { requestRender() {} };
	const frames = {
		true: makeBorderedLoader(stubUi, "waiting", { cancellable: true }),
		false: makeBorderedLoader(stubUi, "waiting", { cancellable: false }),
	};
	const kinds = (root) => root.children.map((c) => c.constructor.name);
	check(JSON.stringify(kinds(frames.true)) === JSON.stringify(["DynamicBorder", "CancellableLoader", "Spacer", "Text", "Spacer", "DynamicBorder"]), "cancellable loader frame shape");
	check(JSON.stringify(kinds(frames.false)) === JSON.stringify(["DynamicBorder", "Loader", "Spacer", "DynamicBorder"]), "plain loader frame shape");
	// Loader ctor starts its tick interval — stop both or the suite hangs.
	for (const root of Object.values(frames)) for (const c of root.children) c.stop?.();
}

if (failures) process.exit(1);
console.log("prompt: all green");
