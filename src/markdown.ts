// bi/src/markdown.ts — transcript markdown via pi-tui (slice 4).
// TTY: pi-tui Markdown owns structure (headings, lists, tables,
// quotes, rules, links, fences); BAML keeps code color through the
// highlightCode hook (bi#27 lexical highlight survives). OSC8 links stay
// clickable when getCapabilities().hyperlinks is true and expand to
// "text (url)" only on incapable terminals (bi#164); width padding is
// trimmed for scrollback. Pipes and BI_SCREEN=0 keep the BAML shaper
// byte-identical to the old print path.
import { Markdown, type MarkdownTheme, getCapabilities } from "@earendil-works/pi-tui";
import { highlight_code_line, is_mermaid_fence, render_markdown_text_async, style_segment, text_attr } from "../baml_sdk/index.js";
import { termWidth } from "./tui.js";

const id = (s: string): string => s;
const plainTheme: MarkdownTheme = {
	heading: id, link: id, linkUrl: id, code: id, codeBlock: id,
	codeBlockBorder: id, quote: id, quoteBorder: id, hr: id,
	listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};

export function markdownTuiAvailable(): boolean {
	if (process.env.BI_SCREEN === "0") return false;
	// Pure render, no input: stdout TTY suffices, stdin raw not needed.
	return !!process.stdout.isTTY;
}

// OSC8 hyperlink open;;url ST text close ST → "text (url)".
export function expandLinks(line: string): string {
	return line.replace(/\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$2 ($1)");
}

// Mermaid degrade (bi#99, TTY leg): no diagram renderer is vendored, so
// mermaid fences print as labeled raw text — a marker line plus the plain
// code block. Detection is BAML (is_mermaid_fence, the pinned spec); the host
// only rewrites the fence opener. Unclosed fences degrade the same way.
// Non-mermaid input returns byte-identical.
export function expandMermaidFences(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (line.slice(0, 3) === "```") {
			if (!inFence && is_mermaid_fence(line.slice(3))) {
				out.push("··· mermaid (diagram not rendered on this terminal)");
				out.push("```");
				inFence = true;
				continue;
			}
			inFence = !inFence;
		}
		out.push(line);
	}
	return out.join("\n");
}

// Real MarkdownTheme through the BAML role path (bi#165): color fns
// resolve via style_segment (the same call diff-render.ts uses),
// emphasis fns via text_attr in render.baml; the palette stays
// BAML-owned so no host file hardcodes ANSI. codeBlock stays identity
// — the highlightCode hook owns fence color — and quote stays identity
// because the component already applies italic() to quote text itself.
function bamlMarkdownTheme(theme: string): MarkdownTheme {
	const role = (r: string): ((s: string) => string) => (s) => style_segment(s, r, theme);
	const attr = (a: string): ((s: string) => string) => (s) => text_attr(s, a, theme);
	return {
		heading: role("accent"),
		link: role("accent"),
		linkUrl: role("dim"),
		code: role("busy"),
		codeBlock: id,
		codeBlockBorder: role("dim"),
		quote: id,
		quoteBorder: role("dim"),
		hr: role("dim"),
		listBullet: role("accent"),
		bold: attr("bold"),
		italic: attr("italic"),
		strikethrough: attr("strikethrough"),
		underline: attr("underline"),
	};
}

export function renderMarkdownTui(text: string, width: number, theme: string | null): string[] {
	// Theme none and null both render identity: pipes stay byte-clean
	// and agent-parseable, humans get ANSI only from a real palette.
	const styled = theme === null || theme === "none" ? plainTheme : bamlMarkdownTheme(theme);
	const md = new Markdown(expandMermaidFences(text), 0, 0, {
		...styled,
		highlightCode: (code, lang) => {
			const out: string[] = [];
			let inBlock = false;
			for (const line of code.split("\n")) {
				const r = highlight_code_line(line, lang ?? "", theme, inBlock);
				out.push(r.text);
				inBlock = r.in_block;
			}
			return out;
		},
	});
	// Link fallback gate (bi#164): pi-tui already decides per terminal —
	// clickable OSC8 when getCapabilities().hyperlinks is true, inline
	// `text (url)` only when false. Expanding unconditionally would
	// flatten clickable links back to the fallback on capable terminals.
	const links = getCapabilities().hyperlinks ? id : expandLinks;
	return md.render(width).map((l) => links(l).trimEnd());
}

export async function printMarkdownText(text: string, theme?: string | null): Promise<void> {
	const t = theme ?? null;
	if (markdownTuiAvailable()) {
		for (const line of renderMarkdownTui(text, termWidth(), t)) console.log(line);
		return;
	}
	console.log(await render_markdown_text_async(text, { theme: t }));
}
