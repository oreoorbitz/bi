// bi/scripts/screen-drain.mjs — terminal-response hygiene (prompt garbage).
// pi-tui queries kitty support per modal (`CSI > flags u CSI ? u CSI c`);
// replies arriving after ui.stop() used to land in readline as typed text
// ("7u64;1;2…" = `CSI ? 7 u` + `CSI ? 64;1;2 c`). screen.ts drains those
// post-stop and stripTerminalResponses guards submits. Piped-safe: pure
// string cases only. The live leak/drain proof rides /tmp/fake_term.py
// (fake kitty terminal, delayed replies): before the fix LEFTOVER was
// "MARKER\\x1b[?7u\\x1b[?64;1;2c", after it is just the typed "abc".
// Red-check: neutering RESPONSE_ONE must trip every strip case below.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { stripTerminalResponses, drainTerminalResponses } = await import(
	join(ROOT, "..", "dist", "src", "screen.js")
);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Responses die.
check(stripTerminalResponses("a\x1b[?7ub") === "ab", "kitty flags reply strips");
check(stripTerminalResponses("\x1b[?64;1;2c") === "", "DA reply strips");
check(stripTerminalResponses("\x1b[>0;95;0c") === "", "secondary DA strips");
check(stripTerminalResponses("x\x1b[24;80Ry") === "xy", "cursor report strips");
check(stripTerminalResponses("\x1b]11;rgb:0000/0000/0000\x07") === "", "OSC reply strips");
check(
	stripTerminalResponses("go\x1b[?7u\x1b[?1;2c\x1b[5;10Rdone") === "godone",
	"interleaved responses all strip",
);

// User input survives.
check(stripTerminalResponses("hello") === "hello", "plain text untouched");
check(stripTerminalResponses("\x1b[A\x1b[B") === "\x1b[A\x1b[B", "arrows survive");
check(stripTerminalResponses("\x1b[Z") === "\x1b[Z", "shift-tab survives");
check(stripTerminalResponses("\x1bOP") === "\x1bOP", "F-keys survive");
check(stripTerminalResponses("\x1b[97;5u") === "\x1b[97;5u", "enhanced keypresses survive");
check(stripTerminalResponses("\x1b") === "\x1b", "bare Esc survives");
check(stripTerminalResponses("a\x1bb") === "a\x1bb", "esc-prefixed text survives");
check(stripTerminalResponses("/model \x1b[?7u") === "/model ", "trailing reply strips, text stays");

// Drain resolves piped with no TTY and no input (zero grace, no hang).
await drainTerminalResponses(0);
check(true, "drain resolves with nothing buffered");

if (failures) process.exit(1);
console.log("screen-drain: all green");
