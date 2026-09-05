// bi/scripts/check-evidence.mjs — bi#84 follow-through: bi consumes the
// bais close-evidence gate (bi#83) instead of reimplementing it.
// Proves checkBaisIssues delegates: a Done with a resolvable ref is
// clean, prose-only and bad-ref closes surface verbatim from bais dist,
// and the gate stays Done-only. Self-contained tmpdirs (offline) so live
// bi/.bais content can never flip these assertions.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { checkBaisIssues } = await import(join(ROOT, "..", "dist", "src", "bais.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const issue = (id, status, body) =>
	`id = "${id}"\ntitle = "${id} fixture"\nstatus = "${status}"\nkind = "Feat"\nbody = """\n${body}\n"""\n`;
const mkTree = (tag, files) => {
	const root = mkdtempSync(join(tmpdir(), `bi-check-ev-${tag}-`));
	const issues = join(root, ".bais", "issues");
	mkdirSync(issues, { recursive: true });
	for (const [name, content] of files) writeFileSync(join(issues, name), content);
	return issues;
};

// NOTE: scriptsDirFor(<tmp>/.bais/issues) is <tmp>/scripts (absent), so
// only fault-drill letters resolve here — stems need a real project tree.
const dir = mkTree("mix", [
	["good.toml", issue("t#01", "Done", "Evidence: drill(b)")],
	["bare.toml", issue("t#02", "Done", "just prose, no refs")],
	["badref.toml", issue("t#03", "Done", "Evidence: drill(nonexistent)")],
	["open.toml", issue("t#04", "Open", "just prose, no refs")],
	["vfour.toml", issue("t#05", "Done", "Evidence: verdict(t#01)")],
]);
const res = await checkBaisIssues(dir);
check(Array.isArray(res.evidence), "checkBaisIssues returns an evidence array (bais_check tool shape)");
const byId = new Map(res.evidence.map((p) => [p.id, p]));
check(!byId.has("t#01"), "resolvable drill ref is clean");
check(!byId.has("t#04"), "gate is Done-only (Open without refs is clean)");
check(!byId.has("t#05"), "resolvable verdict ref (same-dir issue) is clean");
check(byId.get("t#02")?.reason === "missing-close-evidence" && byId.get("t#02")?.status === "Missing",
	`prose-only Done is missing-close-evidence (got ${JSON.stringify(byId.get("t#02"))})`);
check(byId.get("t#03")?.reason === "unresolvable-drill" && byId.get("t#03")?.status === "Missing",
	`bad drill ref is unresolvable-drill (got ${JSON.stringify(byId.get("t#03"))})`);
// Delegation proof: bi holds no local copy of the rule — the reason
// strings arrive verbatim from bais dist. A reimplementation that
// drifted (or a broken import falling back silent) cannot produce these.
check(res.evidence.every((p) => ["missing-close-evidence", "unresolvable-drill", "unresolvable-verdict"].includes(p.reason)),
	"every reason is a bais-gate verdict, none invented locally");

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("check evidence: all green");
