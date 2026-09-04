// bi/scripts/leased-flags.mjs — bi#62: leased-mode CLI validation, offline.
// --hub without --task (and vice versa) must exit 1 with the pairing
// error BEFORE any network; both flags against an unreachable hub must
// exit 1 having ATTEMPTED the claim (proves wiring runs, not just parses).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, "..", "dist", "src", "cli.js");
let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const run = (args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 60000 });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};

const soloHub = run(["run", "hello", "--hub", "http://127.0.0.1:1", "--print"]);
check(soloHub.code === 1 && soloHub.out.includes("go together"), "--hub without --task exits 1 with pairing error");
const soloTask = run(["run", "hello", "--task", "bi#99", "--print"]);
check(soloTask.code === 1 && soloTask.out.includes("go together"), "--task without --hub exits 1 with pairing error");
const badTtl = run(["run", "hello", "--hub", "http://127.0.0.1:1", "--task", "bi#99", "--ttl", "nope", "--print"]);
check(badTtl.code === 1 && badTtl.out.includes("--ttl"), "bad --ttl exits 1 before claiming");
const unreachable = run(["run", "hello", "--hub", "http://127.0.0.1:1", "--task", "bi#99", "--print"]);
check(unreachable.code === 1 && unreachable.out.includes("claim failed"), "unreachable hub exits 1 having attempted the claim");
const plain = run(["bais", "ready"]);
check(plain.code === 0, "unrelated commands unaffected by leased flags");

console.log(failures === 0 ? "leased-flags: all green" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
