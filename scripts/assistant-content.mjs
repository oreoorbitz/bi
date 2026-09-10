// bi/scripts/assistant-content.mjs — assistant content blocks never dump
// raw JSON (bi#209).
//
// The settle print was printMarkdownText(m.text ??
// JSON.stringify(m.content)): every non-Anthropic tool turn printed
// the wire shape. printAssistantMessage (bi/src/markdown.ts) renders
// text parts through the bi#27 path and toolUse parts as tool-start
// chrome — one renderer for the REPL settle and the run dump.
//
// Red-check (bi#57), 2026-09-09 (muse, bi#209): helper reverted to
// the stringify fallback — content arms FAIL naming the
// `[{"type":` prefix; restored → green.
let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { printAssistantMessage, printMarkdownText } = await import(join(HERE, "..", "dist", "src", "markdown.js"));

process.env.NO_COLOR = "1";

const capture = async (fn) => {
	const lines = [];
	const real = console.log;
	console.log = (...a) => {
		lines.push(a.join(" "));
	};
	try {
		await fn();
	} finally {
		console.log = real;
	}
	return lines.join("\n");
};

// Fixture: openai-chat-shaped turn (text + toolUse blocks, no .text).
const NON_ANTHROPIC = {
	role: "assistant",
	content: [
		{ type: "text", text: "Listing the directory first." },
		{ type: "toolUse", id: "t1", name: "bash", args: { cmd: "ls" } },
	],
};
const out = await capture(() => printAssistantMessage(NON_ANTHROPIC, null));
check("content renders prose", out.includes("Listing the directory first."), JSON.stringify(out.slice(0, 120)));
check("content renders tool chrome", out.includes("bash"), "no tool line");
check("content never raw JSON", !out.includes('[{"type":'), JSON.stringify(out.slice(0, 160)));

// Tool-use-only turn (no text block at all).
const TOOL_ONLY = { role: "assistant", content: [{ type: "toolUse", id: "t2", name: "bash", args: { cmd: "pwd" } }] };
const outTool = await capture(() => printAssistantMessage(TOOL_ONLY, null));
check("tool-only renders chrome", outTool.includes("bash"));
check("tool-only never raw JSON", !outTool.includes('[{"type":'));

// Anthropic path byte-identical: single-text output equals the direct
// printMarkdownText bytes.
const ANTHROPIC = { role: "assistant", text: "Plain anthropic text." };
const viaHelper = await capture(() => printAssistantMessage(ANTHROPIC, null));
const viaDirect = await capture(() => printMarkdownText(ANTHROPIC.text, null));
check("anthropic byte-identical", viaHelper === viaDirect, `${JSON.stringify(viaHelper)} vs ${JSON.stringify(viaDirect)}`);

// Unknown block types skip without crashing or leaking.
const ODD = { role: "assistant", content: [{ type: "reasoning", summary: "hmm" }] };
const outOdd = await capture(() => printAssistantMessage(ODD, null));
check("unknown blocks skipped silently", outOdd === "", JSON.stringify(outOdd));

if (failures) process.exit(1);
console.log("assistant-content: all green");
