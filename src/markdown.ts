// bi/src/markdown.ts — transcript markdown via pi-tui (slice 4).
// TTY: pi-tui Markdown owns structure (headings, lists, tables,
// quotes, rules, links, fences); BAML keeps code color through the
// highlightCode hook (bi#27 lexical highlight survives). OSC8 links stay
// clickable when getCapabilities().hyperlinks is true and expand to
// "text (url)" only on incapable terminals (bi#164); width padding is
// trimmed for scrollback. Pipes and BI_SCREEN=0 keep the BAML shaper
// byte-identical to the old print path.
import { Markdown, type MarkdownTheme, getCapabilities } from "@earendil-works/pi-tui";
import { format_tool_start_async, highlight_code_line, is_mermaid_fence, render_markdown_text_async, style_segment, text_attr } from "../baml_sdk/index.js";
import { chromeToolLine, chromeWrap, type ChromeTokenName } from "./theme-files.js";
import { termWidth } from "./tui.js";

const id = (s: string): string => s;
// bi#193: named markdown elements render through the chrome palette
// (host wraps known segments at paint time — the former identity
// passthroughs were the hook): headers pop primary, inline code and
// fence chrome tint text_dim. chromeWrap is a byte-identical passthrough
// under BI_THEME=none / NO_COLOR, so the escape-free posture holds by
// construction; this path only runs on a TTY (markdownTuiAvailable).
const chromeToken = (token: ChromeTokenName): ((s: string) => string) => (s) => chromeWrap(token, s);
const plainTheme: MarkdownTheme = {
	heading: chromeToken("primary"), link: id, linkUrl: id, code: chromeToken("text_dim"), codeBlock: id,
	codeBlockBorder: chromeToken("text_dim"), quote: id, quoteBorder: id, hr: id,
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
// bi#193: the three NAMED elements (heading, inline code, fence border)
// swap from BAML roles to chrome tokens, same as plainTheme above — the
// chrome palette governs them at every theme, the six-role theme keeps
// the rest (links, bullets, rules, emphasis).
function bamlMarkdownTheme(theme: string): MarkdownTheme {
	const role = (r: string): ((s: string) => string) => (s) => style_segment(s, r, theme);
	const attr = (a: string): ((s: string) => string) => (s) => text_attr(s, a, theme);
	return {
		heading: chromeToken("primary"),
		link: role("accent"),
		linkUrl: role("dim"),
		code: chromeToken("text_dim"),
		codeBlock: id,
		codeBlockBorder: chromeToken("text_dim"),
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
				// bi#193: fence blocks tint text_dim. A BAML-highlighted line
				// already carries lexical SGR (the six-role theme owns it);
				// only plain lines (theme null/none) take the chrome tint —
				// wrapping styled output would fight the inner resets.
				out.push(r.text.includes("\x1b") ? r.text : chromeWrap("text_dim", r.text));
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

// bi#209: one assistant-message renderer for every transcript site.
//
// Single-text messages print exactly as before (the Anthropic path is
// byte-identical); content-block messages (openai-chat and every tool
// turn) render text parts through the bi#27 markdown path and toolUse
// parts as the same tool-start chrome the live turn prints — never
// raw JSON. Unknown block types are skipped; the turn itself is never
// dropped from history, only unrenderable bytes from the transcript.
export async function printAssistantMessage(msg: unknown, theme?: string | null): Promise<void> {
	const m = msg as { text?: unknown; content?: unknown } | null;
	if (typeof m?.text === "string") {
		await printMarkdownText(m.text, theme);
		return;
	}
	if (Array.isArray(m?.content)) {
		for (const b of m.content) {
			const block = b as { type?: unknown; text?: unknown; name?: unknown; args?: unknown } | null;
			if (block?.type === "text" && typeof block.text === "string") await printMarkdownText(block.text, theme);
			else if (block?.type === "toolUse" && typeof block.name === "string")
				console.log(
					chromeToolLine(await format_tool_start_async(block.name, JSON.stringify(block.args), { theme: theme ?? null }), block.name, !!process.stdout.isTTY),
				);
		}
	}
}
