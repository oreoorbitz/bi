// bi/src/markdown.ts — transcript markdown via pi-tui (slice 4).
// TTY: pi-tui Markdown owns structure (headings, lists, tables,
// quotes, rules, links, fences); BAML keeps code color through the
// highlightCode hook (bi#27 lexical highlight survives). OSC8 links
// expand to "text (url)" — fallback semantics — and width padding is
// trimmed for scrollback. Pipes and BI_SCREEN=0 keep the BAML shaper
// byte-identical to the old print path.
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { highlight_code_line, render_markdown_text_async } from "../baml_sdk/index.js";
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

export function renderMarkdownTui(text: string, width: number, theme: string | null): string[] {
	const md = new Markdown(text, 0, 0, {
		...plainTheme,
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
	return md.render(width).map((l) => expandLinks(l).trimEnd());
}

export async function printMarkdownText(text: string, theme?: string | null): Promise<void> {
	const t = theme ?? null;
	if (markdownTuiAvailable()) {
		for (const line of renderMarkdownTui(text, termWidth(), t)) console.log(line);
		return;
	}
	console.log(await render_markdown_text_async(text, { theme: t }));
}
