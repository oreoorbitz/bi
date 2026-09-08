// bi/scripts/keys.mjs — bi#69 slice 1 probe (offline).
// Byte fixtures through parseKeys: arrows (CSI + SS3), editing keys,
// ctrl/alt chords, printables incl. multi-byte, and degenerate input
// (lone ESC, truncated CSI) that must parse, never stall.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { parseKeys } = await import(join(ROOT, "..", "dist", "src", "keys.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const names = (b) => parseKeys(Buffer.from(b)).map((k) => k.name).join(",");

check(names("\x1b[A\x1b[B\x1b[C\x1b[D") === "up,down,right,left", "CSI arrows");
check(names("\x1bOA\x1bOB") === "up,down", "SS3 application arrows");
check(names("\x1b[H\x1b[F\x1b[3~\x1b[5~") === "home,end,delete,page-up", "home/end/edit keys");
check(names("\r") === "enter" && names("\t") === "tab" && names("\x7f") === "backspace", "editing keys");
check(names("\x03") === "ctrl-c" && names("\x04") === "ctrl-d", "ctrl chords");
check(names("\x1bx") === "alt-x", "alt chord");
check(names("hié") === "h,i,é", "printables incl multi-byte");
check(names("\x1b") === "esc", "lone ESC is escape, not a stall");
check(names("\x1b[") === "esc,[", "truncated CSI degrades to esc + literal");
check(names("\x1b[1;5A") === "up", "modified arrows still navigate");
console.log(failures === 0 ? "keys: all green" : `keys: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
