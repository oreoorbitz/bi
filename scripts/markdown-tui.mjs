// bi/scripts/markdown-tui.mjs — pi-tui Markdown transcript conformance (slice 4).
// Asserts (1) structure pi's way: tables box-draw, nested lists indent,
// quotes/hr/headings shape, markers strip; (2) OSC8 links expand to
// "text (url)" with zero escapes left at theme null; (3) no line keeps
// width padding; (4) BAML lexical highlight survives inside fences at a
// real theme; (5) the pipe fallback is byte-identical to the legacy
// render_markdown_text print path.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { renderMarkdownTui, expandLinks, markdownTuiAvailable } = await import(
	join(ROOT, "..", "dist", "src", "markdown.js")
);
const { render_markdown_text_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { setCapabilities, resetCapabilitiesCache } = await import("@earendil-works/pi-tui");
// Sections 1–5 pin the incapable-terminal contract (fallback links, zero
// escapes at theme null), so force hyperlinks off: the runner's own TERM
// env must not leak into the fixture (bi#164 makes render env-sensitive).
setCapabilities({ images: null, trueColor: false, hyperlinks: false });

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const stripSgr = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");

const SRC = [
	"# Title",
	"",
	"Some **bold** and a [link](https://x.io).",
	"",
	"- alpha",
	"  - nested",
	"",
	"1. one",
	"",
	"> quote here",
	"",
	"---",
	"",
	"```ts",
	"const x: number = 42; // hi",
	"```",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"",
].join("\n");

const plain = renderMarkdownTui(SRC, 80, null);
const text = plain.join("\n");

// 1 — structure.
check(text.includes("Title") && !text.includes("# Title"), "heading loses its marker");
check(text.includes("Some bold and a"), "bold markers strip");
check(!plain.some((l) => l.includes("**")), "no bold markers survive");
check(plain.some((l) => l === "  - nested" || l === "    - nested"), "nested list indents");
check(plain.some((l) => l.startsWith("1. one")), "ordered list keeps markers");
check(plain.some((l) => l.includes("│ quote here")), "quote gets its border");
check(plain.some((l) => /^─+$/.test(l)), "rule draws");
check(plain.some((l) => l.includes("┌") && l.includes("┐")), "table draws box corners");
check(plain.some((l) => l.includes("│ a │ b │")), "table aligns cells");

// 2 — links expand, zero escapes at theme null.
check(text.includes("link (https://x.io)"), "OSC8 link expands to text (url)");
check(!plain.some((l) => l.includes("\x1b")), "theme null leaves zero escapes");

// 3 — no width padding.
check(!plain.some((l) => l !== l.trimEnd() || l.length > 80), "no trailing padding, width capped");

// 4 — BAML highlight survives inside fences at a real theme.
const styled = renderMarkdownTui(SRC, 80, "default");
check(styled.some((l) => l.includes("\x1b[") && l.includes("const")), "ts fence highlights at theme default");
check(
	stripSgr(styled.join("\n")).includes("link (https://x.io)") &&
		!styled.some((l) => l.includes("]8;;")),
	"styled output still expands links",
);

// 5 — pipe fallback is the legacy path byte-identical.
check(!markdownTuiAvailable(), "suite runs piped: TTY path off");
const { execFileSync } = await import("node:child_process");
const probe = (theme) =>
	execFileSync(process.execPath, ["--input-type=module", "-e", `
import(${JSON.stringify(join(ROOT, "..", "dist", "src", "markdown.js"))}).then(async (m) => {
	const lines = [];
	const orig = console.log;
	console.log = (s) => lines.push(s);
	await m.printMarkdownText(${JSON.stringify(SRC)}, ${JSON.stringify(theme)});
	orig(lines.join("\\n"));
});`], { encoding: "utf8" });
const legacy = await render_markdown_text_async(SRC, { theme: null });
check(probe(null) === legacy + "\n" || probe(null) === legacy, "piped fallback is byte-identical to render_markdown_text");
const legacyStyled = await render_markdown_text_async(SRC, { theme: "default" });
check(probe("default") === legacyStyled + "\n" || probe("default") === legacyStyled, "piped fallback passes theme through");

// expandLinks unit edge: plain text untouched, empty url tolerated.
check(expandLinks("no links here") === "no links here", "expandLinks leaves plain lines alone");

// 6 — bi#164: OSC8 gate follows pi-tui capabilities (simulated both ways).
const LINK_SRC = "A [t](https://x) here.";
setCapabilities({ images: null, trueColor: false, hyperlinks: true });
const clickable = renderMarkdownTui(LINK_SRC, 80, null);
check(clickable.some((l) => l.includes("]8;;")), "capable terminal keeps clickable OSC8");
check(!clickable.join("\n").includes("(https://x)"), "capable terminal omits the inline url");
setCapabilities({ images: null, trueColor: false, hyperlinks: false });
const expanded = renderMarkdownTui(LINK_SRC, 80, null);
check(expanded.join("\n").includes("t (https://x)"), "incapable terminal expands to text (url)");
check(!expanded.some((l) => l.includes("]8;;")), "incapable terminal leaves no OSC8 behind");
resetCapabilitiesCache();

// 7 — bi#165: real MarkdownTheme on the TTY path, none stays clean.
// Expected codes derive from BAML style_segment (same role path the
// host uses), never hardcoded palettes in this script.
const { style_segment } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const openCode = (role, theme) => {
	const wrapped = style_segment("QXZ", role, theme);
	return wrapped.slice(0, wrapped.indexOf("QXZ"));
};
const THEME_SRC = ["# h", "", "A **b** word with `c`.", "", "> q", "", "---", ""].join("\n");
const themed = renderMarkdownTui(THEME_SRC, 80, "default");
const themedText = themed.join("\n");
check(themedText.includes("\x1b["), "theme default emits ANSI on the TTY path");
check(themed.some((l) => l.includes("\x1b[1m") && l.includes("b")), "bold uses SGR bold");
check(
	themed.some((l) => l.includes(openCode("accent", "default")) && l.includes("h")),
	"heading uses the theme accent",
);
check(
	themed.some((l) => l.includes(openCode("busy", "default")) && l.includes("c")),
	"codespan uses the theme busy role",
);
check(themed.some((l) => l.includes("│") && l.includes("\x1b[")), "quote keeps a styled border");
check(
	themed.some((l) => /^─+$/.test(stripSgr(l)) && l.includes("\x1b[")),
	"hr draws with theme styling",
);
// plain was pinned under forced incapable capabilities; re-force before
// comparing so the runner's TERM env cannot leak in via detection.
setCapabilities({ images: null, trueColor: false, hyperlinks: false });
check(
	JSON.stringify(renderMarkdownTui(SRC, 80, "none")) === JSON.stringify(plain),
	"theme none is byte-identical to theme null",
);
resetCapabilitiesCache();

if (failures) process.exit(1);
console.log("markdown-tui: all green");
