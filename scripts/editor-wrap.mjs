// bi/scripts/editor-wrap.mjs — bi#153 narrow-terminal word-wrap guard (plain node).
//
// Stock upstream pi-tui wordWrapLine recurses forever when one indivisible
// grapheme is wider than the wrap width: `wordWrapLine('你', 1)` throws
// `RangeError: Maximum call stack size exceeded`, killing the whole REPL in
// a 1-3-column tmux/SSH pane. The fix is host-side (bi#114 "depend, don't
// rebuild"): PromptEditor.render widens the width handed to super just
// enough that no single grapheme exceeds the layout, then truncates back —
// no vendoring or patching of node_modules/@earendil-works/pi-tui.
//
// The guard is grapheme-count-based (Intl.Segmenter), not code-unit
// `.length`: the ZWJ case below is ONE grapheme but many UTF-16 units, so a
// length-based floor would misjudge it.
//
// Red-check (bi#57): reverting the PromptEditor.render guard (delete the
// override in bi/src/prompt.ts, rebuild) makes the CJK width-1 case fail
// with `RangeError: Maximum call stack size exceeded`; restoring it goes
// green. Verified 2026-09-06: reverted → `FAIL renders CJK at width 1
// without throwing — RangeError: Maximum call stack size exceeded`,
// restored → all green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { PromptEditor } = await import(join(ROOT, "..", "dist", "src", "prompt.js"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const theme = { borderColor: (s) => s, selectList: {} };
// Headless render needs only terminal.rows (layout budget); no TTY.
const tui = { terminal: { rows: 24 }, requestRender() {} };

function renderCase(text, width) {
	const ed = new PromptEditor(tui, theme);
	ed.setText(text);
	try {
		const lines = ed.render(width);
		return { lines };
	} catch (e) {
		return { error: e };
	}
}

function checkWidth(text, label, width) {
	const { lines, error } = renderCase(text, width);
	check(error === undefined, `${label} renders at width ${width} without throwing${error ? ` — ${error.constructor.name}: ${String(error.message).slice(0, 60)}` : ""}`);
	if (lines) {
		const over = lines.filter((l) => visibleWidth(l) > width);
		check(over.length === 0, `${label} every line fits width ${width}${over.length ? ` — over: ${JSON.stringify(over[0])}` : ""}`);
	}
}

// Oracle for the comment above (not the guard): the stock function the
// guard protects against still crashes on an indivisible grapheme.
{
	const { wordWrapLine } = await import(
		join(ROOT, "..", "node_modules", "@earendil-works", "pi-tui", "dist", "components", "editor.js")
	);
	let threw = null;
	try {
		wordWrapLine("你", 1);
	} catch (e) {
		threw = e;
	}
	check(threw instanceof RangeError, `oracle: stock wordWrapLine('你', 1) throws RangeError (got ${threw ? threw.constructor.name : "no throw"})`);
}

// CJK at 1-3 columns: the reported crash (tmux split / SSH resize).
for (const w of [1, 2, 3]) checkWidth("你好世界测试", "CJK line", w);

// ZWJ emoji: one grapheme, many code units — a `.length`-based guard
// misjudges it. Grapheme count first, so the test pins the basis.
{
	const zwj = "👨‍👩‍👧‍👦";
	const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(zwj)].length;
	check(graphemes === 1 && zwj.length > 1, `ZWJ case is one grapheme but ${zwj.length} code units (grapheme-count basis)`);
	for (const w of [1, 2, 3]) checkWidth(`修复${zwj}完成`, "CJK+ZWJ line", w);
}

// No regression at normal widths: content still lays out, ASCII still wraps.
checkWidth("hello narrow terminal world", "ASCII line", 1);
{
	const { lines, error } = renderCase("hello world", 20);
	check(error === undefined, "ASCII renders at width 20 without throwing");
	check(!!lines && lines.some((l) => l.includes("hello")), "width-20 render keeps content");
}
{
	const { lines, error } = renderCase("", 1);
	check(error === undefined, "empty buffer renders at width 1 without throwing");
	check(!!lines && lines.every((l) => visibleWidth(l) <= 1), "empty buffer lines fit width 1");
}

if (failures) process.exit(1);
console.log("editor-wrap: all green");
