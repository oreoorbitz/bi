// bi/scripts/bais-show.mjs — bi#197: `bais show <id>` single-issue read.
//
// `bi bais list <id>` used to silently ignore its positional filter and
// list the whole board (exit 0) — the bi#55 silent-do-something-else shape.
// The fix is one behavior with named errors: `list` takes no positionals
// (refuses loudly, naming `show`), and `bais show <id>` prints the full
// record (body + edges + holder/lease), failing closed on unknown ids.
// Bare `list` output is byte-identical to before.
//
// Drives the real CLI (`bi bais new/link/move/show/list`) inside a sandbox
// .bais/issues (project tt) and asserts the contract above.
//
// Red-check (bi#57): removing the positional guard in cli.ts (`list`
// silently lists again) fails the `list with id refuses loudly` check
// below — observed: FAIL + `list tt#01` exits 0 with the full board on
// stdout. Removing the unknown-id exit in `show` fails the
// `unknown id names itself` check — observed: FAIL, exit 0, empty render.
// Hunk restored, drill re-run green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, "..", "dist", "src", "cli.js");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const home = mkdtempSync(join(tmpdir(), "bi-show-"));
mkdirSync(join(home, ".bais", "issues"), { recursive: true });
writeFileSync(join(home, ".bais", "config.toml"), 'project = "tt"\n');

const run = (args) => {
	try {
		const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120000, cwd: home });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};

// 1 — fixture board: alpha (declared footprint), beta (plain), gamma (linked).
check(run(["bais", "new", "alpha", "--body", "Alpha scope line.\n\nFiles: bi/src/cli.ts"]).code === 0, "new alpha files tt#01");
check(run(["bais", "new", "beta"]).code === 0, "new beta files tt#02");
check(run(["bais", "new", "gamma"]).code === 0, "new gamma files tt#03");
check(run(["bais", "link", "tt#03", "Blocks", "tt#01"]).code === 0, "link tt#03 Blocks tt#01");
check(run(["bais", "move", "tt#01", "Doing", "--as", "tester", "--for", "60m"]).code === 0, "claim tt#01 as tester");

// 2 — show known renders the full record.
const show = run(["bais", "show", "tt#01"]);
check(show.code === 0, "show tt#01 exits 0");
check(show.out.includes("alpha"), "show renders the title");
check(show.out.includes("Alpha scope line."), "show renders the body");
check(show.out.includes("tester"), "show renders the holder");
check(show.out.includes("lease:"), "show renders the lease");
const gamma = run(["bais", "show", "tt#03"]);
check(gamma.code === 0 && gamma.out.includes("Blocks") && gamma.out.includes("tt#03 -> tt#01"), "show renders edges (Blocks tt#03 -> tt#01)");
const beta = run(["bais", "show", "tt#02"]);
check(beta.code === 0 && beta.out.includes("unclaimed"), "show renders unclaimed holder");

// 3 — show unknown fails closed with a named reason.
const miss = run(["bais", "show", "tt#99"]);
check(miss.code !== 0 && miss.out.includes("tt#99"), "unknown id names itself and exits nonzero");
const noarg = run(["bais", "show"]);
check(noarg.code !== 0 && noarg.out.includes("requires <id>"), "show without id refuses loudly");

// 4 — list with a positional refuses loudly, never silently lists.
const lpos = run(["bais", "list", "tt#01"]);
check(lpos.code !== 0 && lpos.out.includes("show"), "list with id refuses and names show");
check(!lpos.out.includes("beta"), "refused list prints no board rows");

// 5 — bare list is unchanged: all three rows, exit 0, stable across runs.
const bare1 = run(["bais", "list"]);
const bare2 = run(["bais", "list"]);
check(bare1.code === 0 && bare1.out === bare2.out, "bare list is stable across runs");
check(
	bare1.out.includes("tt#01\tDoing\tFeat\talpha") && bare1.out.includes("tt#02\tOpen\tFeat\tbeta") && bare1.out.includes("tt#03\tOpen\tFeat\tgamma"),
	"bare list keeps the exact id/status/kind/title rows",
);
check(!bare1.out.includes("takes no positional"), "bare list carries no guard text");

// 6 — list --json still parses.
const lj = run(["bais", "list", "--json"]);
let parsed = null;
try { parsed = JSON.parse(lj.out); } catch {}
check(lj.code === 0 && Array.isArray(parsed?.issues) && parsed.issues.length === 3, "list --json keeps the issues array");

console.log(failures === 0 ? "bais-show: all green" : `bais-show: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
