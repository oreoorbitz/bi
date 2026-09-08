// bi/scripts/diff-color.mjs — diff tint conformance (bi#27).
// Drives the REAL host module (dist/src/diff-render.js) over a pinned unified
// diff and asserts: (1) theme null is byte-identical (pipes stay clean),
// (2) a real theme tints -/+ /@@/headers and leaves context + notes alone,
// (3) every source char survives tinting (strip escapes → original).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { colorizeDiffLines } = await import(join(ROOT, "..", "dist", "src", "diff-render.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const LINES = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "(no changes: s.txt)"];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// (1) pipes stay byte-clean.
const plain = await colorizeDiffLines(LINES, null);
check(JSON.stringify(plain) === JSON.stringify(LINES), "theme null is byte-identical");

// (2) themed roles per prefix.
const styled = await colorizeDiffLines(LINES, "default");
const esc = (s) => s.includes("\x1b[");
check(esc(styled[0]) && esc(styled[1]), "file headers tint");
check(esc(styled[2]), "hunk header tints");
check(esc(styled[4]) && esc(styled[5]), "removed/added lines tint");
check(styled[3] === " a" && styled[6] === " c", "context lines stay plain");
check(styled[7] === "(no changes: s.txt)", "notes stay plain");

// (3) tinting never eats source chars.
check(JSON.stringify(styled.map(strip)) === JSON.stringify(LINES), "stripped output equals the input lines");
check(styled[4] !== styled[5], "removed and added lines tint differently");

if (failures) process.exit(1);
console.log("diff-color: all green");
