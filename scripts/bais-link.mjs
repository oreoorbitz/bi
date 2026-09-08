// bi/scripts/bais-link.mjs — bi#111: link issues without hand-editing TOML.
//
// Drives the real CLI (`bi bais new/link/check`) inside a sandbox
// .bais/issues (project tt, so ids are tt#NN) and asserts the write-time
// contract: birth edges verify under `bais check`, links append to the
// FROM file, and self-links / missing ends / bad kinds / duplicates /
// cycles refuse loudly with a nonzero exit and no half-written file.
// Red-check (bi#57): dropping the self-link guard in linkBaisIssues
// fails the `self-link refuses` check below (exit 0, file written).
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
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

const home = mkdtempSync(join(tmpdir(), "bi-link-"));
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
const files = () => readdirSync(join(home, ".bais", "issues")).sort();
const read = (id) => readFileSync(join(home, ".bais", "issues", `${id}.toml`), "utf8");

// 1 — two plain issues.
check(run(["bais", "new", "alpha"]).code === 0, "new alpha files tt#01");
check(run(["bais", "new", "beta"]).code === 0, "new beta files tt#02");

// 2 — birth edges (repeatable flags) verify under check.
const birth = run(["bais", "new", "gamma", "--blocks", "tt#01", "--depends-on", "tt#02"]);
check(birth.code === 0 && birth.out.includes("tt#03"), "new with --blocks/--depends-on files tt#03");
check(read("tt#03").includes('from = "tt#03"') && read("tt#03").includes('to = "tt#01"') && read("tt#03").includes("Blocks"), "birth Blocks edge lands in the FROM file");
check(read("tt#03").includes("DependsOn") && read("tt#03").includes('to = "tt#02"'), "birth DependsOn edge lands in the FROM file");
check(run(["bais", "check"]).code === 0, "new-with-edges verifies under bais check");

// 3 — link appends to the FROM file (delta is cycle-free: nothing flows
// back to tt#04, so tt#04 Blocks tt#01 links clean).
check(run(["bais", "new", "delta"]).code === 0, "new delta files tt#04");
const link = run(["bais", "link", "tt#04", "Blocks", "tt#01"]);
check(link.code === 0 && link.out.includes("linked\ttt#04\tBlocks\ttt#01"), "link tt#04 Blocks tt#01 reports linked");
check(read("tt#04").includes("Blocks") && read("tt#04").includes('to = "tt#01"'), "link appends the edge to the FROM file");
check(!read("tt#01").includes('from = "tt#04"'), "link writes nothing to the TO file");
check(run(["bais", "check"]).code === 0, "linked graph still verifies under bais check");

// 4 — closing a cycle refuses WITH the cycle path, file untouched.
// (tt#01 Blocks tt#02 would close tt#01 -> tt#02 -> tt#03 -> tt#01 via
// gamma's birth edges: tt#02 DependsOn tt#03, tt#03 Blocks tt#01.)
const before = read("tt#01");
const cyc = run(["bais", "link", "tt#01", "Blocks", "tt#02"]);
check(cyc.code !== 0 && cyc.out.includes("cycle") && cyc.out.includes("tt#01 -> tt#02 -> tt#03 -> tt#01"), "cycle refuses with the cycle path");
check(read("tt#01") === before, "refused cycle writes nothing");

// 5 — DependsOn closes a precedence cycle the other way round
// (tt#02 DependsOn tt#03 orders tt#03 -> tt#02 over the existing
// tt#02 -> tt#03 DependsOn precedence).
const cyc2 = run(["bais", "link", "tt#02", "DependsOn", "tt#03"]);
check(cyc2.code !== 0 && cyc2.out.includes("cycle") && cyc2.out.includes("tt#03 -> tt#02 -> tt#03"), "DependsOn back-path refuses as a cycle");

// 6 — a non-ordering kind across the same pair is fine (Related never orders).
check(run(["bais", "link", "tt#02", "Related", "tt#01"]).code === 0, "Related across a Blocks pair links fine");
check(run(["bais", "check"]).code === 0, "Related link keeps check green");

// 7 — self-link refuses.
const self = run(["bais", "link", "tt#01", "Blocks", "tt#01"]);
check(self.code !== 0 && self.out.includes("itself"), "self-link refuses");

// 8 — missing ends fail loudly.
const missTo = run(["bais", "link", "tt#01", "Blocks", "tt#99"]);
check(missTo.code !== 0 && missTo.out.includes("tt#99"), "missing TO end fails loudly");
const missFrom = run(["bais", "link", "tt#99", "Blocks", "tt#01"]);
check(missFrom.code !== 0 && missFrom.out.includes("tt#99"), "missing FROM end fails loudly");

// 9 — unknown kind names the valid set.
const kind = run(["bais", "link", "tt#01", "Bogus", "tt#02"]);
check(kind.code !== 0 && kind.out.includes("Blocks"), "unknown kind refuses naming valid kinds");

// 10 — exact duplicate refuses.
const dup = run(["bais", "link", "tt#04", "Blocks", "tt#01"]);
check(dup.code !== 0 && dup.out.includes("already linked"), "duplicate edge refuses");

// 11 — birth with a missing end refuses with no half-written file.
const nBefore = files().length;
const badBirth = run(["bais", "new", "epsilon", "--blocks", "tt#99"]);
check(badBirth.code !== 0 && badBirth.out.includes("tt#99"), "birth with missing end refuses loudly");
check(files().length === nBefore, "refused birth writes no file");

// 12 — graph shows the linked edge.
const graph = run(["bais", "graph", "--from", "tt#04"]);
check(graph.code === 0 && graph.out.includes("tt#01"), "graph reaches the linked issue");

console.log(failures === 0 ? "bais-link: all green" : `bais-link: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
