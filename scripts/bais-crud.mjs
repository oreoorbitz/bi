// bi/scripts/bais-crud.mjs — bi#215: complete BAIS CRUD tools.
//
// The bais_* family could not do full CRUD (no show, no edges at birth,
// anonymous-only moves, no link/renew/reap). This drill drives the REAL
// host executors (handleTool, the exact function the agent loop calls)
// through the full lifecycle on a fixture board (project tc):
//   new with edges → show → claim-move → renew → link → reap expired,
// plus every fail-closed refusal (unknown show, bad edge kind, missing
// ends, self-links, dups, cycles, stranger renew, invalid --for).
//
// Red-check record (bi#57, observed live 2026-09-09):
//   R1 (remove the `case "bais_show"` executor hunk from bi/src/tools.ts,
//     rebuild): drill crashes at the first show call with
//     `Error: unknown tool bais_show` — exit non-zero, never green.
//     Restored (byte-identical), rebuilt, re-ran => all green.
//   R2 (delist _tool_bais_show/link/renew/reap from BAML ListTools, specs
//     kept): `baml test` => 6 FAILs (count + GetTool + 4 description
//     tests), exit 2. Relisted, re-ran => 506 passed, 0 failed.
// A passing suite that cannot go red is camouflage, not coverage.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // bi/scripts
const DIST = join(ROOT, "..", "dist");
const CAP = 60000;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const bytes = (s) => Buffer.byteLength(s, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- sandbox board (project tc), real executors, cwd-jail like prod ---
const home = mkdtempSync(join(tmpdir(), "bi-crud-"));
mkdirSync(join(home, ".bais", "issues"), { recursive: true });
writeFileSync(join(home, ".bais", "config.toml"), 'project = "tc"\n');

const { handleTool } = await import(join(DIST, "src", "tools.js"));
const { ListTools_async } = await import(join(DIST, "baml_sdk", "index.js"));
process.chdir(home);

// NOTE: claim-moves run the epic/scope gate (bais/dist graph module is
// built), so claimed bodies carry a `Files:` footprint line — the same
// discipline a real agent follows. Without it the claim refuses loud.

// --- (0) ToolSpec schemas advertise the CRUD contract ---
const byName = Object.fromEntries((await ListTools_async()).map((t) => [t.name, t]));
for (const n of ["bais_show", "bais_link", "bais_renew", "bais_reap"]) {
	check(byName[n] != null, `${n} is advertised in ListTools`);
}
check(byName.bais_new?.input_schema?.properties?.edges?.type === "array", "bais_new schema advertises edges:array");
check(byName.bais_move?.input_schema?.properties?.as?.type === "string", "bais_move schema advertises as:string");
check(byName.bais_move?.input_schema?.properties?.for?.type === "string", "bais_move schema advertises for:string");
check(byName.bais_renew?.input_schema?.properties?.as?.type === "string", "bais_renew schema advertises as:string");
check(
	(byName.bais_link?.input_schema?.required ?? []).sort().join(",") === "from,kind,to",
	"bais_link schema requires from/kind/to",
);

// --- (1) new (plain) + new with edges at birth ---
const alpha = JSON.parse(await handleTool("bais_new", { title: "alpha", body: "Alpha body.\nFiles: bi/scripts/bais-crud.mjs" }));
check(alpha.issue.id === "tc#01", "first issue is tc#01");
const beta = JSON.parse(await handleTool("bais_new", { title: "beta", body: "Beta body.\nFiles: bi/scripts/bais-crud.mjs" }));
check(beta.issue.id === "tc#02", "second issue is tc#02");
const gamma = JSON.parse(
	await handleTool("bais_new", {
		title: "gamma",
		body: "Gamma body.\nFiles: bi/scripts/bais-crud.mjs",
		edges: [{ kind: "Related", to: "tc#01" }],
	}),
);
check(
	gamma.edges.length === 1 && gamma.edges[0].from === "tc#03" && gamma.edges[0].to === "tc#01" && gamma.edges[0].kind === "Related",
	"new with edges lands linked at birth (tc#03 Related tc#01)",
);
check(!JSON.stringify(gamma).includes("\n  "), "bais_new result is compact JSON");

// --- (2) new edge validation fails closed (CLI parity, nothing half-written) ---
const badNew = async (args, needle, label) => {
	let err = null;
	try {
		await handleTool("bais_new", args);
	} catch (e) {
		err = String(e?.message ?? e);
	}
	check(err !== null && err.includes(needle), label + (err === null ? " (no refusal!)" : ` [${err}]`));
};
await badNew({ title: "bad kind", edges: [{ kind: "Nope", to: "tc#01" }] }, "unknown edge kind", "new with unknown edge kind refuses loud");
await badNew({ title: "bad end", edges: [{ kind: "Blocks", to: "tc#999" }] }, "tc#999", "new with missing end refuses naming it");
await badNew(
	{ title: "bad shape", edges: [{ kind: "Blocks" }] },
	"edges[0] needs string kind/to",
	"new with malformed edge entry refuses at the tool boundary",
);
await badNew(
	{ title: "bad dup", edges: [{ kind: "Related", to: "tc#01" }, { kind: "Related", to: "tc#01" }] },
	"already linked",
	"new with duplicate birth edges refuses",
);
const afterBad = JSON.parse(await handleTool("bais_list", { include_bodies: true }));
check(afterBad.issues.length === 3, "refused births write nothing (still 3 issues)");

// --- (3) show: full record, unknown fails closed naming itself ---
const shown = JSON.parse(await handleTool("bais_show", { id: "tc#03" }));
check(shown.issue?.body === "Gamma body.\nFiles: bi/scripts/bais-crud.mjs", "show returns the full body");
check(shown.edges.length === 1 && shown.edges[0].kind === "Related", "show returns edges");
check("holder" in shown && "lease" in shown, "show returns holder/lease");
const showRaw = await handleTool("bais_show", { id: "tc#01" });
check(!showRaw.includes("\n"), "show result is compact JSON (single line)");
check(bytes(showRaw) < CAP, "show stays under the byte cap");
let showErr = null;
try {
	await handleTool("bais_show", { id: "tc#nope" });
} catch (e) {
	showErr = String(e?.message ?? e);
}
check(showErr !== null && showErr.includes("tc#nope"), "show unknown fails closed naming itself" + (showErr === null ? " (no refusal!)" : ` [${showErr}]`));

// --- (4) claim-move (as+for) vs bare move (today's contract) ---
const claimed = JSON.parse(await handleTool("bais_move", { id: "tc#01", status: "Doing", as: "lane-drill", for: "1h" }));
check(claimed.issue.status === "Doing" && claimed.holder === "lane-drill", "claim-move holds Doing with the owner");
check(typeof claimed.lease === "string" && claimed.lease.endsWith("Z"), "claim-move sets a UTC lease");
const showClaimed = JSON.parse(await handleTool("bais_show", { id: "tc#01" }));
check(showClaimed.holder === "lane-drill", "show surfaces the live claim");
const bare = JSON.parse(await handleTool("bais_move", { id: "tc#02", status: "Doing" }));
check(bare.issue.status === "Doing" && bare.holder === null && bare.lease === null, "bare move keeps the anonymous-but-stale contract");
let forErr = null;
try {
	await handleTool("bais_move", { id: "tc#02", status: "Doing", as: "lane-drill", for: "forever" });
} catch (e) {
	forErr = String(e?.message ?? e);
}
check(forErr !== null && forErr.includes("forever"), "move with invalid --for refuses loud naming the value");

// --- (5) renew: holder heartbeat, strangers refused ---
const before = JSON.parse(await handleTool("bais_show", { id: "tc#01" })).lease;
await sleep(1100);
const renewed = JSON.parse(await handleTool("bais_renew", { id: "tc#01", as: "lane-drill", for: "2h" }));
check(renewed.holder === "lane-drill", "renew keeps the holder");
check(Date.parse(renewed.lease) > Date.parse(before), "renew extends the lease (heartbeat moves it forward)");
let strangerErr = null;
try {
	await handleTool("bais_renew", { id: "tc#01", as: "intruder", for: "1h" });
} catch (e) {
	strangerErr = String(e?.message ?? e);
}
check(
	strangerErr !== null && strangerErr.includes("lane-drill") && strangerErr.includes("intruder"),
	"stranger renew refuses naming both holders",
);
let renewOpenErr = null;
try {
	await handleTool("bais_renew", { id: "tc#03", as: "lane-drill", for: "1h" });
} catch (e) {
	renewOpenErr = String(e?.message ?? e);
}
check(renewOpenErr !== null && renewOpenErr.includes("not Doing"), "renew on a non-Doing issue refuses");
let renewForErr = null;
try {
	await handleTool("bais_renew", { id: "tc#01", as: "lane-drill", for: "soon" });
} catch (e) {
	renewForErr = String(e?.message ?? e);
}
check(renewForErr !== null && renewForErr.includes("soon"), "renew with invalid --for refuses loud naming the value");

// --- (6) link over linkBaisIssues + validation parity ---
const linked = JSON.parse(await handleTool("bais_link", { from: "tc#02", kind: "Related", to: "tc#03" }));
check(linked.edges.some((e) => e.from === "tc#02" && e.to === "tc#03" && e.kind === "Related"), "link lands the edge in the FROM file");
const badLink = async (args, needle, label) => {
	let err = null;
	try {
		await handleTool("bais_link", args);
	} catch (e) {
		err = String(e?.message ?? e);
	}
	check(err !== null && err.includes(needle), label + (err === null ? " (no refusal!)" : ` [${err}]`));
};
await badLink({ from: "tc#02", kind: "Related", to: "tc#03" }, "already linked", "duplicate link refuses");
await badLink({ from: "tc#02", kind: "Related", to: "tc#02" }, "itself", "self-link refuses");
await badLink({ from: "tc#02", kind: "Nope", to: "tc#03" }, "unknown edge kind", "unknown link kind refuses");
await badLink({ from: "tc#02", kind: "Related", to: "tc#999" }, "tc#999", "link to a missing end refuses naming it");
await badLink({ from: "tc#999", kind: "Related", to: "tc#03" }, "tc#999", "link from a missing end refuses naming it");
// Cycle: tc#01 Blocks tc#02, then tc#02 Blocks tc#01 must close loud.
await handleTool("bais_link", { from: "tc#01", kind: "Blocks", to: "tc#02" });
await badLink({ from: "tc#02", kind: "Blocks", to: "tc#01" }, "cycle", "cycle-closing link refuses naming the cycle");
const linkCheck = JSON.parse(await handleTool("bais_show", { id: "tc#02" }));
check(!linkCheck.edges.some((e) => e.kind === "Blocks" && e.to === "tc#01"), "refused cycle-link writes nothing");

// --- (7) reap expired-only (same predicate as the CLI reap) ---
// tc#03 Doing on a 1s lease; tc#02 bare (no lease = expired on sight);
// tc#01 live 2h claim must survive.
await handleTool("bais_move", { id: "tc#03", status: "Doing", as: "lane-drill", for: "1s" });
await sleep(1500);
const reaped = JSON.parse(await handleTool("bais_reap", {}));
const reapedIds = (reaped.reaped ?? []).map((r) => r.id).sort();
check(JSON.stringify(reapedIds) === JSON.stringify(["tc#02", "tc#03"]), `reap takes exactly the expired claims (got ${JSON.stringify(reapedIds)})`);
check(!reapedIds.includes("tc#01"), "reap never touches a live claim");
const afterReap = JSON.parse(await handleTool("bais_show", { id: "tc#03" }));
check(afterReap.issue.status === "Open" && afterReap.holder === null && afterReap.lease === null, "reaped issue flips to Open with the claim cleared");
const reapRaw = await handleTool("bais_reap", {});
check(!reapRaw.includes("\n"), "reap result is compact JSON");
check(JSON.parse(reapRaw).reaped.length === 0, "second reap is an explicit empty (nothing left expired)");

// --- (8) full-lifecycle tail: claim → renew → Done releases the claim ---
await handleTool("bais_move", { id: "tc#03", status: "Doing", as: "lane-drill", for: "1h" });
await handleTool("bais_renew", { id: "tc#03", as: "lane-drill", for: "1h" });
const done = JSON.parse(await handleTool("bais_move", { id: "tc#03", status: "Done" }));
check(done.issue.status === "Done" && done.holder === null, "moving out of Doing releases the claim");

if (failures) {
	console.error(`bais-crud: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("bais-crud: all green");
