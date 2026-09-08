// bi/scripts/theme-chrome.mjs — bi#185 chrome palette conformance.
// Pins: (1) the host's DEFAULT_CHROME_TOKENS mirror the BAML dark
// palette exactly (one-test→one-impl tracer), (2) render-time token →
// truecolor ANSI + the BAML level mapping, (3) BI_THEME=none / NO_COLOR
// suppression stays escape-free, (4) an unknown BI_THEME warns once with
// the setting named and keeps dark (warn-first), (5) override-file
// loading: valid partials merge, bad rows warn with the token named and
// reset to defaults — never fail-closed, never half-applied (bi#55).
//
// Red-check (bi#57): dropping the token name from the loadChromePalette
// warning path (bi/src/theme-files.ts) fails `bad hex warns with the
// token named`. Verified 2026-09-07: reverted →
// `FAIL bad hex warns with the token named`, restored → green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const tf = await import(join(ROOT, "..", "dist", "src", "theme-files.js"));
const { chrome_palette_async, chrome_token_for_level_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// 1 — host defaults mirror the BAML dark palette exactly.
{
	const p = await chrome_palette_async("dark");
	check(
		p.text === tf.DEFAULT_CHROME_TOKENS.text &&
			p.text_dim === tf.DEFAULT_CHROME_TOKENS.text_dim &&
			p.text_muted === tf.DEFAULT_CHROME_TOKENS.text_muted &&
			p.primary === tf.DEFAULT_CHROME_TOKENS.primary &&
			p.border === tf.DEFAULT_CHROME_TOKENS.border,
		"DEFAULT_CHROME_TOKENS mirror the BAML dark palette",
	);
}

// 2 — render-time ANSI: truecolor from hex; levels resolve via BAML.
{
	check(tf.chromeAnsi("text_muted", {}) === "\x1b[38;2;107;107;107m", "textMuted renders #6B6B6B truecolor");
	check(tf.chromeAnsi("primary", {}) === "\x1b[38;2;79;168;255m", "primary renders #4FA8FF truecolor");
	check((await chrome_token_for_level_async("hint")) === "text_muted", "hint level maps to textMuted");
	check((await chrome_token_for_level_async("accent")) === "primary", "accent level maps to primary");
}

// 3 — suppression: BI_THEME=none and NO_COLOR are escape-free.
{
	check(tf.chromeAnsi("text", { BI_THEME: "none" }) === "", "BI_THEME=none suppresses chrome color");
	check(tf.chromeAnsi("text", { NO_COLOR: "1" }) === "", "NO_COLOR suppresses chrome color");
	check(tf.chromeSuppressed({}) === false, "default env keeps chrome color");
}

// 4 — unknown BI_THEME warns once with the setting named, keeps dark.
{
	const errs = [];
	const orig = console.error;
	console.error = (m) => errs.push(String(m));
	try {
		check(tf.chromeAnsi("text", { BI_THEME: "solarized" }) !== "", "unknown BI_THEME falls back to dark");
	} finally {
		console.error = orig;
	}
	check(errs.length === 1 && errs[0].includes('BI_THEME="solarized"'), `unknown BI_THEME warns once, named (got ${JSON.stringify(errs)})`);
}

// 5 — override file: valid partials merge; bad rows warn named + reset.
{
	const dir = mkdtempSync(join(tmpdir(), "bi-chrome-"));
	const warns = [];
	const warn = (m) => warns.push(String(m));

	await tf.loadChromePalette(join(dir, "nope.json"), warn);
	check(warns.length === 0, "missing override file is silent");

	writeFileSync(join(dir, "good.json"), JSON.stringify({ primary: "#FF0000" }));
	const merged = await tf.loadChromePalette(join(dir, "good.json"), warn);
	check(merged.primary === "#FF0000" && merged.text === "#E0E0E0", "valid partial override merges over defaults");
	check(warns.length === 0, "valid override is silent");

	writeFileSync(join(dir, "bad.json"), JSON.stringify({ text_dim: "gray", border: "#12345" }));
	const after = await tf.loadChromePalette(join(dir, "bad.json"), warn);
	check(
		warns.some((w) => w.includes("text_dim:") && w.includes("gray")),
		`bad hex warns with the token named (got ${JSON.stringify(warns)})`,
	);
	check(warns.some((w) => w.includes("border:")), "second bad row is also named");
	check(after.primary === "#4FA8FF" && after.text_dim === "#888888", "bad file resets to defaults, never half-applies");

	writeFileSync(join(dir, "junk.json"), "not json{");
	await tf.loadChromePalette(join(dir, "junk.json"), warn);
	check(warns.some((w) => w.includes("not JSON")), "non-JSON warns with a named reason");
	check(tf.chromeTokens().primary === "#4FA8FF", "defaults stay live after every bad file");
}

if (failures) process.exit(1);
console.log("theme-chrome: all green");
