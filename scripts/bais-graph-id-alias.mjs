// bi/scripts/bais-graph-id-alias.mjs — hub#238: bais_graph accepts id as
// an alias for from (explicit from wins when both are present).
//
// Observed live: the agent called bais_graph with {"id":"bi#210"} (no
// from, every sibling tool takes id) and got `bais_graph requires from`
// plus a full stack. The alias drives the REAL host executor
// (handleTool, the exact function the agent loop calls) over a sandbox
// board and pins:
//   (1) {id} with no from traverses from that id;
//   (2) {from} alone keeps working;
//   (3) both present -> from wins;
//   (4) neither refuses loud as a MARKED ToolRefusalError (bi#220 prints
//       the missing-arg path message-only, no stack) naming both
//       spellings, with a live `bi run` fixture-turn proof;
//   (5) the ToolSpec schema advertises the id property and the
//       description documents the alias + precedence (BAML test pins the
//       description; this drill pins the schema host-side).
//
// Red-check (bi#57), observed 2026-09-11 (lane-u, hub#238): tools.ts
// alias hunk reversed by hand to `from = String(args.from ?? "")`
// (no stash — shared tree), rebuilt -> drill exit 1 with
// `FAIL: {id} traverses without refusing (bais_graph requires from)`;
// fix restored, rebuilt -> all green, exit 0. A passing suite that
// cannot go red is camouflage, not coverage.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "..", "dist");
const CLI = join(DIST, "src", "cli.js");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const AT = /^\s*at\s/m;

// --- sandbox board (project tt), real executors, cwd-jail like prod ---
const home = mkdtempSync(join(tmpdir(), "bi-graph-alias-"));
mkdirSync(join(home, ".bais", "issues"), { recursive: true });
writeFileSync(join(home, ".bais", "config.toml"), 'project = "tt"\n');

const { handleTool, ToolRefusalError } = await import(join(DIST, "src", "tools.js"));
const { ListTools_async } = await import(join(DIST, "baml_sdk", "index.js"));
process.chdir(home);

const alpha = JSON.parse(await handleTool("bais_new", { title: "alpha" }));
const beta = JSON.parse(await handleTool("bais_new", { title: "beta" }));
const aid = alpha.issue.id;
const bid = beta.issue.id;
await handleTool("bais_link", { from: aid, kind: "Blocks", to: bid });
const ids = (g) => g.issues.map((i) => i.id ?? i.issue?.id);
// Refusals surface as FAIL lines (never an uncaught throw) so a
// regression reads as a red suite, not a crashed driver.
const tryGraph = async (args) => {
	try {
		return { ok: true, val: JSON.parse(await handleTool("bais_graph", args)) };
	} catch (e) {
		return { ok: false, err: e };
	}
};

// 1 — {id} with no from traverses from that id.
const gId = await tryGraph({ id: aid, depth: 1 });
check(gId.ok, `{id} traverses without refusing (${gId.ok ? `from=${gId.val.from}` : gId.err?.message})`);
if (gId.ok) check(ids(gId.val).includes(aid) && ids(gId.val).includes(bid), "{id} reaches the linked issue");

// 2 — {from} alone keeps working.
const gFrom = await tryGraph({ from: aid, depth: 1 });
check(gFrom.ok && gFrom.val.from === aid, "{from} still traverses");
if (gId.ok && gFrom.ok) check(JSON.stringify(ids(gFrom.val).sort()) === JSON.stringify(ids(gId.val).sort()), "{id} and {from} agree on reachability");

// 3 — both present -> from wins.
const gBoth = await tryGraph({ from: bid, id: aid, depth: 0 });
check(gBoth.ok && gBoth.val.from === bid, `explicit from wins (from=${gBoth.ok ? gBoth.val.from : gBoth.err?.message})`);
if (gBoth.ok) check(ids(gBoth.val).length === 1 && ids(gBoth.val)[0] === bid, "from-wins result narrows to from at depth 0");

// 4 — neither refuses loud as a marked refusal naming both spellings.
let err = null;
try {
	await handleTool("bais_graph", { depth: 1 });
} catch (e) {
	err = e;
}
check(err instanceof ToolRefusalError, "missing-arg path throws a marked ToolRefusalError (bi#220 prints message-only)");
check(typeof err?.message === "string" && err.message.includes("from") && err.message.includes("id"), `refusal names both spellings (${JSON.stringify(err?.message)})`);
check(!AT.test(err?.message ?? ""), "refusal message carries no stack frames");

// 5 — schema advertises the alias host-side.
const spec = (await ListTools_async()).find((t) => t.name === "bais_graph");
check(spec?.input_schema?.properties?.id?.type === "string", "bais_graph schema advertises id:string");
check(typeof spec?.description === "string" && spec.description.includes("`id` is an alias for `from`"), "bais_graph description documents the alias");
check(typeof spec?.description === "string" && spec.description.includes("explicit `from` wins"), "bais_graph description documents from-wins precedence");

// 6 — live proof: a canned agent turn calling bais_graph with {id} (no
// from) traverses (exit 0, no refusal); with {} the turn fails
// message-only (exit 1, sentence present, zero at-frames). Same
// BI_LLM_FIXTURE shape as tool-refusal.mjs.
function makeRunHome() {
	const h = mkdtempSync(join(tmpdir(), "bi-graph-live-"));
	mkdirSync(join(h, ".bi", "sessions"), { recursive: true });
	mkdirSync(join(h, ".bais", "issues"), { recursive: true });
	writeFileSync(join(h, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	writeFileSync(join(h, ".bais", "config.toml"), 'project = "tt"\n');
	return h;
}
function cli(cwd, args, env = {}) {
	try {
		const out = spawnSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120000, cwd, env: { ...process.env, ...env } });
		return { code: out.status ?? -1, out: (out.stdout ?? "") + (out.stderr ?? "") };
	} catch (e) {
		return { code: -1, out: String(e) };
	}
}
function runTurn(cwd, fixtureTurns) {
	const fx = join(cwd, "fixture.json");
	writeFileSync(fx, JSON.stringify({ turns: fixtureTurns }) + "\n");
	const env = { HOME: cwd, TERM: "dumb", BI_LLM_FIXTURE: fx };
	delete env.BI_TUI_DEBUG;
	return cli(cwd, ["run", "do the thing"], env);
}
const live = makeRunHome();
check(cli(live, ["bais", "new", "alpha"]).code === 0, "live sandbox files tt#01");
{
	const r = runTurn(live, [{ toolUse: { name: "bais_graph", args: { id: "tt#01", depth: 0 } } }]);
	check(r.code === 0 && r.out.includes("tt#01"), "live {id} turn traverses (exit 0, id in output)");
	check(!r.out.includes("bais_graph requires"), "live {id} turn never hits the missing-arg refusal");
}
{
	const r = runTurn(live, [{ toolUse: { name: "bais_graph", args: {} } }]);
	check(r.code === 1, "live missing-arg turn exits 1");
	check(r.out.includes("bais_graph requires"), "live missing-arg turn prints the sentence");
	check(!AT.test(r.out), "live missing-arg turn prints zero at-frames (message-only)");
	check(!r.out.includes("dist/"), "live missing-arg turn leaks no internals");
}

if (failures) process.exit(1);
console.log("bais-graph-id-alias: all green");
