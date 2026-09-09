// bi/scripts/response-text.mjs — settled response body reads the text
// token, chrome layers inside untouched (bi#207).
//
// printAssistantMessage wraps text blocks in chromeAnsi("text")
// (#E0E0E0): each emitted line opens with it and every inner full
// reset falls back to it, so dim/code/header spans keep their SGR
// while plain prose reads text. Suppressed (NO_COLOR/BI_THEME=none)
// or unpainted output is byte-identical to the unwrapped path;
// toolUse chrome never enters the wrap.
//
// Red-check (bi#57), 2026-09-09 (muse, bi#207): base dropped at the
// printAssistantMessage call — body-SGR + fallback arms FAIL;
// restored → green.
let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { printAssistantMessage, printMarkdownText } = await import(join(HERE, "..", "dist", "src", "markdown.js"));

const TEXT = "\x1b[38;2;224;224;224m";
// BAML six-role dim is the faint attribute (the chrome text_dim token
// is the host palette — a different SGR for the same read).
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BODY = "Hello world.\n\n```ts\nconst x = 1\n```\n\nafter the fence.";
const MSG = { role: "assistant", text: BODY };

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
	return lines;
};

const savedNoColor = process.env.NO_COLOR;
const savedTheme = process.env.BI_THEME;
delete process.env.NO_COLOR;
delete process.env.BI_THEME;
try {
	const lines = await capture(() => printAssistantMessage(MSG, "default", true));
	const out = lines.join("\n");
	check("body reads the text token", out.includes(TEXT), "no text SGR");
	check("prose line opens with text", lines[0].startsWith(TEXT), JSON.stringify(lines[0]).slice(0, 80));
	check("dim fence opener survives", out.includes(`${DIM}··· ts${RESET}`), "dim span lost");
	check(
		"reset falls back to text",
		out.includes(`${DIM}··· ts${RESET}${TEXT}`),
		"base not re-asserted after dim",
	);
	check("trailing prose re-opens text", lines[lines.length - 1].startsWith(`${TEXT}after the fence.${RESET}`), JSON.stringify(lines[lines.length - 1]));
	check(
		"every line self-closes",
		lines.every((l) => l.endsWith(RESET)),
		"color bleed across lines",
	);

	// Suppressed/shapeless output is byte-identical to the unwrapped path.
	for (const [tag, mod] of [["nocolor", { NO_COLOR: "1" }], ["none", { BI_THEME: "none" }]]) {
		if (mod.NO_COLOR) process.env.NO_COLOR = mod.NO_COLOR;
		else delete process.env.NO_COLOR;
		if (mod.BI_THEME) process.env.BI_THEME = mod.BI_THEME;
		else delete process.env.BI_THEME;
		const wrapped = await capture(() => printAssistantMessage(MSG, "default", true));
		const plain = await capture(() => printMarkdownText(BODY, "default"));
		check(`${tag} byte-identical to today`, wrapped.join("\n") === plain.join("\n"), "suppression changed bytes");
	}
} finally {
	if (savedNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = savedNoColor;
	if (savedTheme === undefined) delete process.env.BI_THEME;
	else process.env.BI_THEME = savedTheme;
}

if (failures) process.exit(1);
console.log("response-text: all green");
