// bi/scripts/bais-ready-verbose.mjs — bi#198: `ready --verbose` footprint.
//
// Answering "what is pending and what does each item touch" needed
// scripting; now `bi bais ready --verbose` appends the declared footprint
// per row: `Files:` basenames, `unknown` when no Files: line, `-` when the
// Files: line is bare. Default `ready` rows stay byte-identical and
// `--json` is untouched (bodies already ride it).
//
// Drives the real CLI inside a sandbox .bais/issues (project tt) with one
// fixture per shape (declared / no-Files: / bare-Files:) and pins all
// three verbose rows plus default-output stability.
//
// Red-check (bi#57): breaking filesCol in cli.ts (e.g. always returning
// `unknown`) fails the `declared row shows basenames` and `bare row shows
// -` checks below — observed: FAIL on both, `unknown` on every verbose
// row. Hunk restored, drill re-run green.
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

const home = mkdtempSync(join(tmpdir(), "bi-ready-verbose-"));
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

// 1 — one fixture per shape, all Open and unblocked (all ready).
check(run(["bais", "new", "declared", "--body", "Scope.\n\nFiles: bi/src/cli.ts, bi/scripts/x.mjs"]).code === 0, "new declared files tt#01");
check(run(["bais", "new", "nodecl", "--body", "No footprint here."]).code === 0, "new nodecl files tt#02");
check(run(["bais", "new", "bare", "--body", "Scope TBD.\n\nFiles:"]).code === 0, "new bare files tt#03");

const rowFor = (out, id) => out.split("\n").find((l) => l.startsWith(id + "\t")) ?? "";

// 2 — default ready is byte-stable and carries no footprint column.
const def1 = run(["bais", "ready"]);
const def2 = run(["bais", "ready"]);
check(def1.code === 0 && def1.out === def2.out, "default ready is stable across runs");
check(!def1.out.includes("files:"), "default ready carries no footprint column");
check(rowFor(def1.out, "tt#01") === "tt#01\tdeclared\tbr=0", "default declared row is exactly id/title/br");
check(rowFor(def1.out, "tt#02") === "tt#02\tnodecl\tbr=0", "default unknown row is exactly id/title/br");
check(rowFor(def1.out, "tt#03") === "tt#03\tbare\tbr=0", "default bare row is exactly id/title/br");

// 3 — verbose pins all three shapes.
const verb = run(["bais", "ready", "--verbose"]);
check(verb.code === 0, "ready --verbose exits 0");
check(rowFor(verb.out, "tt#01") === "tt#01\tdeclared\tbr=0\tfiles: cli.ts,x.mjs", "declared row shows basenames");
check(rowFor(verb.out, "tt#02") === "tt#02\tnodecl\tbr=0\tfiles: unknown", "no-Files: row shows unknown");
check(rowFor(verb.out, "tt#03") === "tt#03\tbare\tbr=0\tfiles: -", "bare-Files: row shows -");

// 4 — verbose is strictly additive: stripping the suffix recovers default.
const stripped = verb.out.split("\n").map((l) => l.replace(/\tfiles: .*$/, "")).join("\n");
check(stripped === def1.out, "verbose minus the files column equals default output");

// 5 — --json untouched.
const rj = run(["bais", "ready", "--json"]);
let parsed = null;
try { parsed = JSON.parse(rj.out); } catch {}
check(rj.code === 0 && Array.isArray(parsed?.ready) && parsed.ready.length === 3, "ready --json keeps the ready array");

console.log(failures === 0 ? "bais-ready-verbose: all green" : `bais-ready-verbose: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
