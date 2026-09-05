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

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

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
	styled.join("\n").includes("link (https://x.io)") && !styled.some((l) => l.includes("]8;;")),
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

if (failures) process.exit(1);
console.log("markdown-tui: all green");
