// bi/scripts/action-log.mjs — bi#75 probe (offline, no network).
// The host loop holds the pen: every record() appends one
// `<ts> <session> <code> <detail>` line shaped by BAML. Asserts the
// codebook holds (unknown codes drop, never throw), details cap,
// and write failures never break the caller.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { ActionLog } = await import(join(ROOT, "..", "dist", "src", "actionlog.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const tmp = join(tmpdir(), `bi-actions-${process.pid}.log`);
try {
	rmSync(tmp);
} catch {}
const log = new ActionLog("probe-session", tmp);
log.record("turn.start", "hello");
log.record("tool.call", 'bais_move {"id":"bi#75"}');
log.record("edit.write", "bi/src/cli.ts");
log.record("bais.move", "bi#75 -> Doing");
log.record("lease.claim", "task-1 fencing=9");
log.record("agent.gossip", "forged"); // not in the codebook: dropped
log.record("turn.end", "ok");

const lines = readFileSync(tmp, "utf8").split("\n").filter((l) => l.length > 0);
check(lines.length === 6, `six codebook lines appended (got ${lines.length})`);
const shape = /^\S+ probe-session (turn\.start|turn\.end|tool\.call|edit\.write|bais\.move|lease\.claim) /;
check(lines.every((l) => shape.test(l)), "every line is <ts> <session> <code> <detail>");
check(lines.some((l) => l.includes("tool.call bais_move")), "tool call replays from the log alone");
check(lines.some((l) => l.includes("lease.claim task-1 fencing=9")), "lease claim replays from the log alone");
check(log.counters().droppedCodes === 1, `forged code dropped+counted (got ${JSON.stringify(log.counters())})`);

// Long details cap at 200 chars so one blob cannot bloat the file.
log.record("tool.call", `echo ${"x".repeat(500)}`);
const capped = readFileSync(tmp, "utf8").split("\n").filter((l) => l.length > 0).at(-1);
check(capped.length < lines[0].length + 250 && capped.endsWith("…"), "long detail capped with ellipsis");

// Write failures never break the caller (unwritable path, no throw).
const bad = new ActionLog("probe-session", "/definitely-not-here-xyz/actions.log");
let threw = false;
try {
	bad.record("turn.start", "hello");
} catch {
	threw = true;
}
check(!threw && bad.counters().writeFailures === 1, "unwritable log swallowed+counted");

try {
	rmSync(tmp);
} catch {}
console.log(failures === 0 ? "action-log: all green" : `action-log: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
