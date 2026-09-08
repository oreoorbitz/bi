// bi/scripts/bais-epic-mirror.mjs — hub#225: epic exclusion in the serving paths.
//
// hub#223 routed epics out of the BAML definition and bais/dist, but the CLI
// still seated them: bi/src/bais.ts filterReadyIssues (hand-mirror, no isEpic
// conjunct), bais/src/store.ts storeReady SQL (no SubtaskOf exclusion), and no
// dispatch warning call site. This drill pins all three on a sandbox board.
//
// Red-check (bi#57, performed live 2026-09-08 by the hub#225 author).
// Hunk 1 — bi filterReadyIssues conjunct dropped: drill fails exactly
// `ready drops the epic`, `store path drops the epic` (the store join
// re-filters through the mirror), `pack seats leaves only`, `human pack
// seats leaves only` — 4 failures, epic seated in ready rows and slot0.
// Hunk restored, rebuilt, drill re-run green.
// Hunk 2 — storeReady SubtaskOf NOT EXISTS dropped: the drill stays green
// (the store join re-filters through the hand-mirror, masking it), so this
// hunk red-checks against the live store one-liner instead — observed:
// neutered → store-ready `[ 'bi#189', 'bi#26' ]`; restored + re-ingest →
// `[]`. The SQL conjunct keeps cross-check §3 (store-vs-scan) green.
// Dropping either warn call site fails the warning checks — observed: FAIL,
// warnings array / stderr name no epic. Hunks restored, drill re-run green.
//
// Drives the real built CLIs (bi/dist, bais/dist) inside a sandbox
// .bais/issues (project tt) and asserts the contract above.
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BI = join(ROOT, "..", "dist", "src", "cli.js");
const BAIS = join(ROOT, "..", "..", "bais", "dist", "src", "cli.js");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const home = mkdtempSync(join(tmpdir(), "bi-epic-"));
mkdirSync(join(home, ".bais", "issues"), { recursive: true });
writeFileSync(join(home, ".bais", "config.toml"), 'project = "tt"\n');

const run = (args, cli = BI) => {
	const r = spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 120000, cwd: home });
	const out = r.stdout ?? "";
	const err = r.stderr ?? "";
	return { code: r.status ?? -1, out, err, all: out + err };
};

// 1 — fixture: epic + two declared children + one declared leaf.
check(run(["bais", "new", "epic work", "--body", "Coordinates.\n\nFiles: tt/epic.ts"]).code === 0, "new epic files tt#01");
check(run(["bais", "new", "child one", "--body", "One.\n\nFiles: tt/one.ts"]).code === 0, "new child one files tt#02");
check(run(["bais", "new", "child two", "--body", "Two.\n\nFiles: tt/two.ts"]).code === 0, "new child two files tt#03");
check(run(["bais", "new", "lone leaf", "--body", "Leaf.\n\nFiles: tt/leaf.ts"]).code === 0, "new leaf files tt#04");
check(run(["bais", "link", "tt#02", "SubtaskOf", "tt#01"]).code === 0, "link tt#02 SubtaskOf tt#01");
check(run(["bais", "link", "tt#03", "SubtaskOf", "tt#01"]).code === 0, "link tt#03 SubtaskOf tt#01");

// 2 — scan path: ready drops the epic, keeps children + leaf.
const ready = run(["bais", "ready"]);
check(ready.code === 0, "ready exits 0");
const readyIds = ready.out.split("\n").map((l) => l.split("\t")[0]);
check(!readyIds.includes("tt#01"), "ready drops the epic");
check(readyIds.includes("tt#02") && readyIds.includes("tt#03") && readyIds.includes("tt#04"), "ready keeps children and leaf");

// 3 — store path: ingest via the bais CLI, then ready still drops the epic.
const ingest = run(["ingest"], BAIS);
check(ingest.code === 0, "ingest exits 0");
const ready2 = run(["bais", "ready"]);
const ready2Ids = ready2.out.split("\n").map((l) => l.split("\t")[0]);
check(!ready2Ids.includes("tt#01"), "store path drops the epic");
check(ready2Ids.includes("tt#02") && ready2Ids.includes("tt#03") && ready2Ids.includes("tt#04"), "store path keeps children and leaf");

// 4 — dispatch: no epic slot, epic named in warnings (json) and stderr (human).
const dj = run(["bais", "dispatch", "--agents", "4", "--json"]);
check(dj.code === 0, "dispatch --json exits 0");
const pack = JSON.parse(dj.out);
check(!pack.slots.map((s) => s.issue.id).includes("tt#01"), "pack seats leaves only");
check((pack.warnings ?? []).some((w) => w.includes("tt#01") && w.includes("epic")), "json warnings name the epic");
const dh = run(["bais", "dispatch", "--agents", "4"]);
check(dh.code === 0, "dispatch human exits 0");
check(!dh.out.split("\n").some((l) => l.startsWith("slot") && l.includes("tt#01")), "human pack seats leaves only");
check(dh.err.includes("tt#01") && dh.err.includes("epic"), "human stderr names the epic");

// 5 — warning-text parity: bi mirror matches bais/dist word for word.
const parity = await (async () => {
	try {
		const bi = await import(join(ROOT, "..", "dist", "src", "bais.js"));
		const bais = await import(join(ROOT, "..", "..", "bais", "dist", "src", "graph.js"));
		return bi.warnEpicWithheld(["tt#01"]) === bais.warnEpicWithheld(["tt#01"]);
	} catch {
		return false;
	}
})();
check(parity, "warnEpicWithheld text identical bi vs bais");

if (failures) {
	console.error(`bais-epic-mirror: ${failures} failure(s)`);
	process.exit(1);
}
console.log("bais-epic-mirror: all green");
