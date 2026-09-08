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
const { makeSlashProvider, promptAvailable, PromptEditor, inlineSlashTokenAt, FilterList, rowSearchTexts, DynamicBorder, visualWidth, truncateVisual, makeBorderedLoader } = await import(
	join(ROOT, "..", "dist", "src", "prompt.js")
);
const { rank_selector_rows } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

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

// 7 — bi#69 FilterList: filter-as-you-type atop stock widgets, headless.
// Rows resolve to ORIGINAL indices (callers map positionally); typing
// narrows, Enter confirms the filtered top row, Esc cancels, clearing
// restores the kept selection, empty query lists all.
// Red-check (bi#57): delete the `this.filter.handleInput(data)` forward
// in FilterList.handleInput and these fail as `filter narrows as you
// type` / `enter confirms the filtered row's original index` (typing
// stops reaching the filter); restore for green.
{
	const mk = (resolved) => {
		const items = ["grok-4.6", "claude-haiku-4-5", "gpt-5"].map((label) => ({ value: label, label }));
		const all = items.map((item, i) => ({ item, orig: i, haystack: labelHaystack(item.label) }));
		return new FilterList(all, 0, (q) => (q.length === 0 ? all : all.filter((r) => r.haystack.includes(q.toLowerCase()))), (o) => resolved.push(o));
	};
	const labelHaystack = (s) => s.toLowerCase();
	// Typing narrows; Enter confirms the ORIGINAL index.
	{
		const resolved = [];
		const fl = mk(resolved);
		check(JSON.stringify(fl.visibleOriginals()) === "[0,1,2]", "empty query lists all");
		fl.handleInput("g");
		check(fl.getFilterValue() === "g", "typing reaches the filter row");
		check(JSON.stringify(fl.visibleOriginals()) === "[0,2]", "filter narrows as you type");
		fl.handleInput("\r");
		check(JSON.stringify(resolved) === "[0]", "enter confirms the filtered row's original index");
	}
	// Esc cancels to null; arrows never touch the filter text.
	{
		const resolved = [];
		const fl = mk(resolved);
		fl.handleInput("c");
		check(JSON.stringify(fl.visibleOriginals()) === "[1]", "second row narrows on its letter");
		fl.handleInput("\x1b[A");
		check(fl.getFilterValue() === "c", "arrows are not filter text");
		fl.handleInput("\x1b");
		check(JSON.stringify(resolved) === "[null]", "esc cancels the pick");
	}
	// Clearing restores the kept selection; no-match Enter is a no-op.
	{
		const resolved = [];
		const fl = mk(resolved);
		fl.handleInput("\x1b[B");
		fl.handleInput("\x7f");
		check(fl.getFilterValue() === "", "backspace on empty filter stays empty");
		check(JSON.stringify(fl.visibleOriginals()) === "[0,1,2]", "empty query restores all rows");
		fl.handleInput("zzz");
		check(JSON.stringify(fl.visibleOriginals()) === "[]", "no match lists none");
		fl.handleInput("\r");
		check(resolved.length === 0, "enter on empty matches nothing");
	}
}

// 8 — bi#85 host wiring: haystack defaults + BAML rank delegation.
// rowSearchTexts prefers the per-row override (/model search texts),
// else cleaned label + description (/resume display lines need no
// caller change). rank_selector_rows is the pickList rank core: empty
// lists all, provider-prefixed ranks first, pipes never reach it
// (pickList only runs behind promptAvailable).
// Red-check (bi#57): point rowSearchTexts at the raw label (skip the
// override) and `override wins` fails; make the BAML rank return []
// and `baml rank narrows` fails. Restore for green.
{
	check(
		JSON.stringify(rowSearchTexts([{ label: "grok-4.6", description: "xai · 200 ctx", searchText: "xai xai/grok-4.6" }])) === JSON.stringify(["xai xai/grok-4.6"]),
		"override wins",
	);
	check(
		JSON.stringify(rowSearchTexts([{ label: "1  abc123 my task" }])) === JSON.stringify(["1  abc123 my task"]),
		"label-only rows pass through",
	);
	check(
		JSON.stringify(rowSearchTexts([{ label: "\x1b[31mgrok\x1b[0m", description: "xai" }])) === JSON.stringify(["grok xai"]),
		"ansi cleaned from the default haystack",
	);
	const texts = ["xai xai/grok-4.6 xai grok-4.6 Grok 4.6", "openrouter openrouter/openai/gpt-5 openrouter openai/gpt-5"];
	check(JSON.stringify(rank_selector_rows("", texts)) === "[0,1]", "baml rank lists all on empty");
	check(JSON.stringify(rank_selector_rows("xai/grok", texts)) === "[0]", "baml rank narrows to the provider row");
}

// 9 — bi#154 paste-burst guard: rapid multi-line pastes on terminals
// without bracketed-paste markers must not self-submit. Thresholds
// (8 chars / 8ms interval / 30ms active idle / 120ms enter-suppress)
// are asserted at the unit level with fake timestamps; the editor
// level drives PromptEditor.handleInput headless (single-char feeds
// arrive <8ms apart in a tight loop, so Date.now() needs no mocks).
// Red-check (bi#57): route burst-Enter to super.handleInput (drop the
// insertTextAtCursor newline branch) and `burst Enter inserts newline`
// fails with `submit:line1...`; drop the onPlainChar feed and both
// burst cases fail (counter never trips). Restore for green.
{
	const { PasteBurst } = await import(join(ROOT, "..", "dist", "src", "paste-burst.js"));
	// Unit: exact threshold boundary with fake timestamps.
	{
		const p = new PasteBurst();
		let t = 1000;
		for (let i = 0; i < 7; i++) { p.onPlainChar(t); t += 2; }
		check(p.shouldInsertNewlineInsteadOfSubmit(t) === false, "burst: 7 rapid chars do not trip the guard");
		p.onPlainChar(t);
		check(p.shouldInsertNewlineInsteadOfSubmit(t + 1) === true, "burst: 8th rapid char trips the guard");
		check(p.shouldInsertNewlineInsteadOfSubmit(t + 200) === false, "burst: suppress window expires after 120ms");
	}
	// Unit: slow cadence never trips, even past 8 chars.
	{
		const p = new PasteBurst();
		let t = 2000;
		for (let i = 0; i < 12; i++) { p.onPlainChar(t); t += 50; }
		check(p.shouldInsertNewlineInsteadOfSubmit(t) === false, "burst: 12 slow chars stay a submit");
	}
	// Unit: a control key resets the run (kimi handleInput behavior).
	{
		const p = new PasteBurst();
		let t = 3000;
		for (let i = 0; i < 7; i++) { p.onPlainChar(t); t += 2; }
		p.reset();
		p.onPlainChar(t);
		check(p.shouldInsertNewlineInsteadOfSubmit(t + 1) === false, "burst: reset breaks the run");
	}
	// Editor: simulated 20-char burst + Enter inserts \n, no submit.
	{
		const ed = new PromptEditor({}, { borderColor: (s) => s, selectList: {} });
		const submitted = [];
		ed.onSubmit = (t) => submitted.push(t);
		for (const ch of "line1-line2-line3-4567") ed.handleInput(ch);
		ed.handleInput("\r");
		check(submitted.length === 0, "burst Enter inserts newline instead of submitting");
		check(ed.getText().includes("\n"), `burst newline lands in the buffer (got ${JSON.stringify(ed.getText())})`);
		// The trailing-newline window: a second fast Enter also newlines.
		ed.handleInput("\r");
		check(submitted.length === 0, "burst trailing Enter still newlines inside the suppress window");
	}
	// Editor: normal-speed typing + Enter still submits.
	{
		const ed = new PromptEditor({}, { borderColor: (s) => s, selectList: {} });
		const submitted = [];
		ed.onSubmit = (t) => submitted.push(t);
		for (const ch of "hi!") ed.handleInput(ch);
		ed.handleInput("\r");
		check(submitted.join() === "hi!", `typed Enter still submits (got ${JSON.stringify(submitted)})`);
	}
	// Editor: a multi-char chunk (bracketed-paste shape) never feeds the
	// counter — only single printable chars do — so Enter still submits.
	{
		const ed = new PromptEditor({}, { borderColor: (s) => s, selectList: {} });
		const submitted = [];
		ed.onSubmit = (t) => submitted.push(t);
		ed.handleInput("pasted-line1\npasted-line2-chunk");
		ed.handleInput("\r");
		check(submitted.length === 1, "chunked paste path unaffected by the burst guard");
	}
	// Editor: autocomplete-open Enter is untouched (list owns Enter).
	{
		const ed = new PromptEditor({}, { borderColor: (s) => s, selectList: {} });
		ed.isShowingAutocomplete = () => true;
		const submitted = [];
		ed.onSubmit = (t) => submitted.push(t);
		for (const ch of "0123456789abcdef") ed.handleInput(ch);
		ed.handleInput("\r");
		check(submitted.length === 1, "autocomplete-open Enter still reaches super (submit path intact)");
	}
}

// 10 — bi#155 inline slash/skill completion mid-prompt. The trigger
// detector is pure (token after whitespace, or opening a later line;
// prose slashes never match); the provider reuses BAML complete_slash
// against the skills-only pool; inline accepts keep the slash plus a
// trailing space so argument completion follows; first-word behavior
// is byte-identical and the bi#115 stale guard covers inline accepts.
// Enter-without-submit is verified by recording what reaches stock:
// inline-token Enter arrives as Tab (apply, no submit), every other
// open-list Enter arrives unchanged.
// Red-check (bi#57): drop the inline branch in getSuggestions and the
// `mid-line trigger` / `later-line trigger` cases fail (null); force
// the Enter translation off and `inline Enter translates to Tab` fails
// (records \r). Restore for green.
{
	const liveSkills = [{ name: "review" }];
	const ipool = {
		names: () => ["model", "move", "trust", ...liveSkills.map((s) => s.name)],
		skillNames: () => liveSkills.map((s) => s.name),
		describe: (n) => (n === "review" ? "Review code" : null),
		argPool: async () => [],
	};
	const iprovider = makeSlashProvider(ipool);
	// Detector: triggers.
	check(inlineSlashTokenAt(["hello /re"], 0, 9) === "/re", "inline detector fires after whitespace");
	check(inlineSlashTokenAt(["hello /"], 0, 7) === "/", "inline detector fires on the bare slash");
	check(inlineSlashTokenAt(["first", "/re"], 1, 3) === "/re", "inline detector fires at a later line start");
	check(inlineSlashTokenAt(["first", "x /skill:re"], 1, 11) === "/skill:re", "inline token keeps the colon shape");
	check(inlineSlashTokenAt(["hello /repaused "], 0, 16) === null, "cursor past the token end does not trigger");
	// Detector: prose slashes never trigger.
	check(inlineSlashTokenAt(["src/foo"], 0, 7) === null, "path slash does not trigger");
	check(inlineSlashTokenAt(["1/2"], 0, 3) === null, "fraction slash does not trigger");
	check(inlineSlashTokenAt(["/mo"], 0, 3) === null, "first-word slash is not inline (provider path unchanged)");
	check(inlineSlashTokenAt(["hello"], 0, 5) === null, "plain prose does not trigger");
	// Provider: mid-line + later-line triggers list skills only.
	{
		const s = await iprovider.getSuggestions(["hello /re"], 0, 9, { signal: AbortSignal.abort() });
		check(s !== null && s.prefix === "/re", "mid-line trigger returns the inline prefix");
		check(s !== null && s.items.map((i) => i.value).join(",") === "/review", `mid-line lists skills only (got ${JSON.stringify(s && s.items)})`);
		check(s !== null && s.items[0].description === "Review code", "inline descriptions attach");
		const l = await iprovider.getSuggestions(["first", "/re"], 1, 3, { signal: AbortSignal.abort() });
		check(l !== null && l.items.map((i) => i.value).join(",") === "/review", "later-line trigger lists skills only");
		// Later-line "/" is the inline (skills-only) menu, not the
		// first-word menu: no skill matches "m", so builtins stay out.
		check((await iprovider.getSuggestions(["first", "/m"], 1, 2, { signal: AbortSignal.abort() })) === null, "later-line slash excludes first-word builtins");
		const n = await iprovider.getSuggestions(["hello /re paused"], 0, 9, { signal: AbortSignal.abort() });
		check(n !== null && n.prefix === "/re", "cursor-inside-token still triggers with trailing prose");
	}
	// Provider: prose slashes + first-word path unchanged.
	check((await iprovider.getSuggestions(["src/foo"], 0, 7, { signal: AbortSignal.abort() })) === null, "provider ignores path slashes");
	check((await iprovider.getSuggestions(["1/2"], 0, 3, { signal: AbortSignal.abort() })) === null, "provider ignores fraction slashes");
	{
		const s = await iprovider.getSuggestions(["/mo"], 0, 3, { signal: AbortSignal.abort() });
		check(s !== null && s.items.map((i) => i.value).join(",") === "/model,/move", `first-word menu keeps builtins (got ${JSON.stringify(s && s.items)})`);
	}
	// Provider: inline accept preserves slash + trailing space; stale refuses.
	{
		const r = iprovider.applyCompletion(["hello /re"], 0, 9, { value: "/review", label: "/review" }, "/re");
		check(r.lines[0] === "hello /review " && r.cursorCol === 14, `inline accept appends the trailing space (got ${JSON.stringify(r)})`);
		const stale = iprovider.applyCompletion(["hello /review"], 0, 14, { value: "/review", label: "/review" }, "/re");
		check(stale.lines[0] === "hello /review" && stale.cursorCol === 14, "stale inline prefix refuses the splice");
	}
	// Pool freshness: skills added after the provider is built (the
	// /trust reload path — same live array, no second list) appear inline.
	{
		liveSkills.push({ name: "retro" });
		const s = await iprovider.getSuggestions(["hello /re"], 0, 9, { signal: AbortSignal.abort() });
		check(s !== null && s.items.map((i) => i.value).sort().join(",") === "/retro,/review", `inline picker follows pool reloads (got ${JSON.stringify(s && s.items)})`);
		liveSkills.pop();
	}
	// Enter routing: record what reaches stock with the list open.
	{
		const { Editor } = await import("@earendil-works/pi-tui");
		const orig = Editor.prototype.handleInput;
		const seen = [];
		Editor.prototype.handleInput = function (d) { seen.push(d); };
		try {
			const theme = { borderColor: (s) => s, selectList: {} };
			const inlineEd = new PromptEditor({}, theme);
			inlineEd.isShowingAutocomplete = () => true;
			inlineEd.getLines = () => ["hello /re"];
			inlineEd.getCursor = () => ({ line: 0, col: 9 });
			inlineEd.handleInput("\r");
			check(seen.join(",") === "\t", `inline Enter translates to Tab (got ${JSON.stringify(seen)})`);
			seen.length = 0;
			const firstEd = new PromptEditor({}, theme);
			firstEd.isShowingAutocomplete = () => true;
			firstEd.getLines = () => ["/mo"];
			firstEd.getCursor = () => ({ line: 0, col: 3 });
			firstEd.handleInput("\r");
			check(seen.join(",") === "\r", `first-word Enter passes through untouched (got ${JSON.stringify(seen)})`);
			seen.length = 0;
			const proseEd = new PromptEditor({}, theme);
			proseEd.isShowingAutocomplete = () => true;
			proseEd.getLines = () => ["hello world"];
			proseEd.getCursor = () => ({ line: 0, col: 11 });
			proseEd.handleInput("\r");
			check(seen.join(",") === "\r", "non-token Enter passes through untouched");
		} finally {
			Editor.prototype.handleInput = orig;
		}
	}
}

if (failures) process.exit(1);
console.log("prompt: all green");
