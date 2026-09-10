// bi/scripts/user-echo.mjs — bi#221 pi-style user-echo shapes.
// Pure helpers live in dist/src/tui.js (cli.ts runs main() on import,
// so the harness cannot import it); the TTY gate + leftover reclaim
// stay in cli's printUserEcho and are proven live-pty, not here.
// Cases: (1) body is blank/echo/blank with a one-space pad, no `bi>`
// prefix, no box; (2) multiline echoes every row; (3) fits() admits
// only rows that provably occupy one terminal row (ASCII, 4-wide
// label inside cols) — tabs, wide chars, wrap-length, and cols<=0
// all refuse so the caller keeps the legacy leftover, never a fossil.
// Red-check: shorten any failing row to the boundary and it flips.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { userEchoBody, userEchoFits } = await import(join(ROOT, "..", "dist", "src", "tui.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Body: pi framing — blank line, ` line`, blank line.
check(userEchoBody("hi") === "\n hi\n", "single line echoes padded with surrounding blanks");
check(userEchoBody("a\nb") === "\n a\n b\n", "multiline echoes every row padded");
// Red-check: dropping the pad or a blank breaks the exact match.
check(userEchoBody("hi") !== "hi\n" && userEchoBody("hi") !== "\nhi\n", "unpadded variants do not match");
check(!userEchoBody("hi").includes("bi>") && !userEchoBody("hi").includes("─"), "no prompt prefix, no box rule");

// Fits: exact single-row geometry only.
check(userEchoFits("hi", 80) === true, "short ascii fits a roomy width");
check(userEchoFits("a\nb", 80) === true, "multiline fits when every row fits");
check(userEchoFits("x".repeat(76), 80) === true, "4-wide label + 76 chars fills 80 exactly");
check(userEchoFits("x".repeat(77), 80) === false, "one char over the width refuses");
check(userEchoFits("ok\n" + "x".repeat(77), 80) === false, "one long row fails the whole echo");
check(userEchoFits("a\tb", 80) === false, "tab refuses (rendered width unknowable)");
check(userEchoFits("héllo", 80) === false, "non-ascii refuses");
check(userEchoFits("hi 👋", 80) === false, "emoji refuses");
check(userEchoFits("hi", 0) === false, "unknown width (cols 0) refuses");
check(userEchoFits("hi", -1) === false, "negative width refuses");
// Red-check: the 77-char refusal flips when shortened to the boundary.
check(userEchoFits("x".repeat(77).slice(0, 76), 80) === true, "red-check: boundary row flips refusal to fit");

if (failures) process.exit(1);
console.log("user-echo: all green");
