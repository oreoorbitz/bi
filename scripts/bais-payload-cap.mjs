// bi/scripts/bais-payload-cap.mjs — bi#212: BAIS tool-result payload caps.
//
// A fresh-session "hello world" once burned ~276k tokens on two tool
// results (bais_list 529,839 chars of full bodies + pretty-print).
// This drill drives the REAL host executors (handleTool, the exact
// function the agent loop calls) over a sandbox board and pins:
//   (1) bare bais_list returns ROWS (id/status/kind/title/area), compact,
//       under the 60k cap — even on a ~300-issue fixture board;
//   (2) include_bodies:true returns full records;
//   (3) a result narrowed to one issue carries its body;
//   (4) `unparseable` is always present and rows stay complete;
//   (5) bais_check is compact + capped with check semantics unchanged
//       (small-board output byte-equals the direct checkBaisIssues JSON);
//   (6) over-cap results truncate with a notice naming the refinement
//       (status filter / bais show), never silent (bi#55);
//   (7) list→show→stage stays intact end-to-end (rows → `bais show` body
//       → move), plus the ToolSpec schema advertises include_bodies.
//
// Red-check record (bi#57, observed live 2026-09-09):
//   stash bi/src/tools.ts (rows projection + cap reverted to pretty full):
//     => FAIL bare small-board list stays under the byte cap (got 3-issue
//        pretty payload with bodies), FAIL rows carry no bodies,
//        FAIL big-board bare list under cap — exit 1
//   pop stash, rebuild, re-run => bais-payload-cap: all green, exit 0.
//   (Cap-only revert folded into the same stash: capBaisPayload is the
//   same hunk as the projection — without it every over-cap check fails
//   on the truncation-notice assertion instead.)
// A passing suite that cannot go red is camouflage, not coverage.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // bi/scripts
const DIST = join(ROOT, "..", "dist");
const CLI = join(DIST, "src", "cli.js");
const CAP = 60000;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const bytes = (s) => Buffer.byteLength(s, "utf8");

// --- sandbox board (project tt), real executors, cwd-jail like prod ---
const home = mkdtempSync(join(tmpdir(), "bi-paycap-"));
mkdirSync(join(home, ".bais", "issues"), { recursive: true });
writeFileSync(join(home, ".bais", "config.toml"), 'project = "tt"\n');

const { handleTool } = await import(join(DIST, "src", "tools.js"));
const { ListTools_async } = await import(join(DIST, "baml_sdk", "index.js"));
const { checkBaisIssues } = await import(join(DIST, "src", "bais.js"));
process.chdir(home);

// --- phase A: small board (alpha/beta/gamma + one garbage file) ---
await handleTool("bais_new", { title: "alpha", body: "Alpha scope line." });
await handleTool("bais_new", { title: "beta", body: "Beta body line." });
await handleTool("bais_new", { title: "gamma" });
await handleTool("bais_move", { id: "tt#01", status: "Doing" });
writeFileSync(join(home, ".bais", "issues", "tt#bad.toml"), "this is {{{ not toml\n");

// (0) ToolSpec schema advertises the contract (rides with implementation).
const spec = (await ListTools_async()).find((t) => t.name === "bais_list");
check(spec?.input_schema?.properties?.include_bodies?.type === "boolean", "bais_list schema advertises include_bodies:boolean");
check(typeof spec?.description === "string" && spec.description.includes("ROWS"), "bais_list description names ROWS");

// (1) Bare list: rows only, compact, complete, unparseable present.
const bare = await handleTool("bais_list", {});
const bareRows = JSON.parse(bare);
check(bytes(bare) < CAP, `bare small-board list stays under the byte cap (got ${bytes(bare)})`);
check(!bare.includes("\n"), "bare list is compact JSON (single line)");
check(!bare.includes('"body"'), "rows carry no bodies");
check(bareRows.issues.length === 3, `rows stay complete (got ${bareRows.issues.length}, want 3)`);
check(
	bareRows.issues.every((r) => Object.keys(r).sort().join(",") === "area,id,kind,status,title"),
	"row shape is exactly id/status/kind/title/area",
);
check(
	Array.isArray(bareRows.unparseable) && bareRows.unparseable.length === 1 && bareRows.unparseable[0].file === "tt#bad.toml",
	"unparseable always present, naming the garbage file (rows still complete)",
);

// (3) Result narrowed to one issue carries its body.
const single = JSON.parse(await handleTool("bais_list", { status: "Doing" }));
check(single.issues.length === 1, "Doing filter narrows to one issue");
check(single.issues[0]?.issue?.body === "Alpha scope line.", "single-issue result carries its body");
check(Array.isArray(single.unparseable), "single-issue result keeps unparseable present");

// (2) include_bodies:true returns full records on demand.
const full = JSON.parse(await handleTool("bais_list", { include_bodies: true }));
check(full.issues.length === 3 && full.issues.every((f) => typeof f?.issue?.body === "string"), "include_bodies:true returns bodies");

// (5) bais_check: compact verdict rows, never bodies, semantics unchanged.
// bi#213 changed the tool shape (ok ids + failures first, ok last) while
// the CLI still reads checkBaisIssues directly — so pin equivalence of the
// verdict SETS with the direct check, not byte-equality of the payload.
const checkOut = await handleTool("bais_check", {});
const direct = await checkBaisIssues();
const checkRows = JSON.parse(checkOut);
check(!checkOut.includes("\n  "), "bais_check is compact JSON (no pretty indent)");
check(!checkOut.includes('"body"'), "bais_check carries no bodies (verdict rows only)");
check(
	JSON.stringify([...checkRows.ok].sort()) === JSON.stringify(direct.ok.map((f) => f.issue.id).sort()),
	"check ok ids match the direct check verdict set",
);
check(JSON.stringify(checkRows.bad) === JSON.stringify(direct.bad), "check bad matches the direct check");
check(JSON.stringify(checkRows.dangling) === JSON.stringify(direct.dangling), "check dangling matches the direct check");
check(JSON.stringify(checkRows.cycles) === JSON.stringify(direct.cycles), "check cycles matches the direct check");
check(
	Object.keys(checkRows).join(",") === "bad,dangling,cycles,evidence,ok",
	"check failures serialize first, ok last (truncation cuts ok ids, never a failure)",
);
check(checkRows.ok.length === 3, "small-board check sees all three issues");

// (7) list→show→stage end-to-end: rows → `bais show` body → move.
const run = (args) => {
	try {
		return { code: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120000, cwd: home }) };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const show = run(["bais", "show", "tt#02"]);
check(show.code === 0 && show.out.includes("Beta body line."), "show renders the staged body from the row id");
await handleTool("bais_move", { id: "tt#02", status: "Doing" });
const staged = JSON.parse(await handleTool("bais_list", {}));
check(staged.issues.find((r) => r.id === "tt#02")?.status === "Doing", "staged move visible in the next rows list");

// --- phase B: ~300-issue fixture board (bodies ~1.8k each) ---
const filler = "Fixture evidence line. ".repeat(80);
for (let n = 4; n <= 303; n++) {
	const id = `tt#${String(n).padStart(2, "0")}`;
	writeFileSync(
		join(home, ".bais", "issues", `${id}.toml`),
		`id = "${id}"\ntitle = "fixture ${n}"\nstatus = "Open"\nkind = "Feat"\nbody = """\n${filler}\n"""\n`,
	);
}

// (1b) Bare big-board list: rows only, still under the cap, still complete.
const big = await handleTool("bais_list", {});
const bigRows = JSON.parse(big);
console.log(`info: big-board bare list is ${bytes(big)} bytes for ${bigRows.issues.length} rows`);
check(bytes(big) < CAP, `bare big-board list stays under the byte cap (got ${bytes(big)})`);
check(!big.includes('"body"'), "big-board rows carry no bodies");
check(bigRows.issues.length === 303, `big-board rows stay complete (got ${bigRows.issues.length}, want 303)`);
check(bigRows.unparseable.length === 1, "big-board unparseable survives the crowd");

// (6) Over-cap results truncate with a notice naming the refinement.
const bigFull = await handleTool("bais_list", { include_bodies: true });
console.log(`info: big-board full list is ${bytes(bigFull)} bytes`);
check(bytes(bigFull) > CAP, `fixture board actually exceeds the cap full-body (got ${bytes(bigFull)})`);
check(bigFull.includes("…truncated"), "over-cap list carries the truncation notice (never silent)");
check(bigFull.includes("status=") && bigFull.includes("bais show"), "list notice names the refinement (status filter / bais show)");
const bigCheck = await handleTool("bais_check", {});
console.log(`info: big-board check is ${bytes(bigCheck)} bytes`);
check(!bigCheck.includes('"body"'), "big-board check carries no bodies (verdict rows scale)");
check(bytes(bigCheck) < CAP, `big-board check stays under the byte cap (got ${bytes(bigCheck)})`);
check(JSON.parse(bigCheck).ok.length === 303, "big-board check verdicts stay complete (all 303 ok)");

// --- phase C (bi#213): ready/check/graph row-mode on a fresh sandbox ---
// A second sandbox (project tu) so small-board pins stay exact while the
// big board above keeps its counts. Related edges build the graph chain:
// Related never orders work, so ready/check verdicts stay undisturbed.
const home2 = mkdtempSync(join(tmpdir(), "bi-paycap213-"));
mkdirSync(join(home2, ".bais", "issues"), { recursive: true });
writeFileSync(join(home2, ".bais", "config.toml"), 'project = "tu"\n');
process.chdir(home2);
await handleTool("bais_new", { title: "ralpha", body: "Ralpha body." });
await handleTool("bais_new", { title: "rbeta", body: "Rbeta body." });
await handleTool("bais_new", { title: "rgamma", body: "Rgamma body." });
await handleTool("bais_move", { id: "tu#01", status: "Doing" });
writeFileSync(join(home2, ".bais", "issues", "tu#bad.toml"), "this is {{{ not toml\n");

// (C0) ToolSpec schemas advertise the row-mode contract.
const readySpec = (await ListTools_async()).find((t) => t.name === "bais_ready");
check(readySpec?.input_schema?.properties?.include_bodies?.type === "boolean", "bais_ready schema advertises include_bodies:boolean");
check(typeof readySpec?.description === "string" && readySpec.description.includes("ROWS"), "bais_ready description names ROWS");
const graphSpec = (await ListTools_async()).find((t) => t.name === "bais_graph");
check(graphSpec?.input_schema?.properties?.depth?.type === "number", "bais_graph schema advertises depth:number");
check(graphSpec?.input_schema?.properties?.include_bodies?.type === "boolean", "bais_graph schema advertises include_bodies:boolean");
check(typeof graphSpec?.description === "string" && graphSpec.description.includes("narrower --from, shallower depth"), "bais_graph description names the refinement");

// (C1) Bare ready: rows only, compact, complete, unparseable present.
const readyBare = await handleTool("bais_ready", {});
const readyRows = JSON.parse(readyBare);
check(bytes(readyBare) < CAP, `bare ready stays under the byte cap (got ${bytes(readyBare)})`);
check(!readyBare.includes("\n"), "bare ready is compact JSON (single line)");
check(!readyBare.includes('"body"'), "ready rows carry no bodies");
check(readyRows.issues.length === 2, `ready rows stay complete (got ${readyRows.issues.length}, want 2)`);
check(
	readyRows.issues.every((r) => Object.keys(r).sort().join(",") === "area,id,kind,status,title"),
	"ready row shape is exactly id/status/kind/title/area",
);
check(
	Array.isArray(readyRows.unparseable) && readyRows.unparseable.length === 1 && readyRows.unparseable[0].file === "tu#bad.toml",
	"ready keeps unparseable present, naming the garbage file",
);

// (C2) Ready bodies on demand + single-issue narrowing.
const readyFull = JSON.parse(await handleTool("bais_ready", { include_bodies: true }));
check(readyFull.issues.length === 2 && readyFull.issues.every((f) => typeof f?.issue?.body === "string"), "ready include_bodies:true returns bodies");
await handleTool("bais_move", { id: "tu#02", status: "Doing" });
const readySingle = JSON.parse(await handleTool("bais_ready", {}));
check(readySingle.issues.length === 1, "narrowed ready holds one issue");
check(readySingle.issues[0]?.issue?.body === "Rgamma body.", "single-issue ready carries its body");
await handleTool("bais_move", { id: "tu#02", status: "Open" });

// (C3) Check failures-first by construction: a synthetic over-cap
// check-shaped payload keeps its full bad array after the shared cap.
const { capBaisPayload, BAIS_TOOL_RESULT_CAP } = await import(join(DIST, "src", "tools.js"));
const fakeBad = [{ file: "tu#bad.toml", error: "parse boom" }];
const fakeCheck = JSON.stringify({ bad: fakeBad, dangling: [], cycles: [], evidence: [], ok: Array(8000).fill("tu#99") });
check(bytes(fakeCheck) > BAIS_TOOL_RESULT_CAP, "synthetic check payload actually exceeds the cap");
const cappedFake = capBaisPayload(fakeCheck, "bais show <id>");
check(cappedFake.includes(JSON.stringify(fakeBad)), "truncated check keeps the full bad array (failures first)");
check(cappedFake.includes("…truncated"), "truncated check carries the notice (never silent)");

// (C4) Graph chain tu#10—tu#15 (Related edges, written directly).
for (let n = 10; n <= 15; n++) {
	const id = `tu#${String(n).padStart(2, "0")}`;
	const next = n < 15 ? `tu#${String(n + 1).padStart(2, "0")}` : null;
	writeFileSync(
		join(home2, ".bais", "issues", `${id}.toml`),
		`id = "${id}"\ntitle = "chain ${n}"\nstatus = "Open"\nkind = "Feat"\nbody = """\nChain body ${n}.\n"""\n${next ? `\n[[edge]]\nfrom = "${id}"\nto = "${next}"\nkind = "Related"\n` : ""}`,
	);
}
const g1 = JSON.parse(await handleTool("bais_graph", { from: "tu#10", depth: 1 }));
check(g1.issues.length === 2, `graph depth=1 holds from + neighbor (got ${g1.issues.length})`);
check(g1.truncated === false, "small graph is not truncated");
check(!JSON.stringify(g1).includes('"body"'), "graph rows carry no bodies");
const g2 = JSON.parse(await handleTool("bais_graph", { from: "tu#10", depth: 2 }));
check(g2.issues.length === 3, `graph depth=2 reaches two hops (got ${g2.issues.length})`);
const gDef = JSON.parse(await handleTool("bais_graph", { from: "tu#10" }));
check(gDef.depth === 3 && gDef.issues.length === 4, `graph default depth is 3 (got depth=${gDef.depth}, ${gDef.issues.length} rows)`);
check(gDef.issues.every((r) => Object.keys(r).sort().join(",") === "area,id,kind,status,title"), "graph row shape is exactly id/status/kind/title/area");
const gMid = JSON.parse(await handleTool("bais_graph", { from: "tu#12", depth: 1 }));
check(gMid.issues.length === 3, `graph traverses both directions (got ${gMid.issues.length}, want 3)`);
const gNeg = JSON.parse(await handleTool("bais_graph", { from: "tu#10", depth: -1 }));
check(gNeg.depth === 3, "invalid depth falls back to the default (never unbounded)");
const gFull = JSON.parse(await handleTool("bais_graph", { from: "tu#10", depth: 1, include_bodies: true }));
check(gFull.issues.length === 2 && gFull.issues.every((f) => typeof f?.issue?.body === "string"), "graph include_bodies:true returns bodies");
const gSolo = JSON.parse(await handleTool("bais_graph", { from: "tu#10", depth: 0 }));
check(gSolo.issues.length === 1 && gSolo.issues[0]?.issue?.body?.includes("Chain body 10."), "graph depth=0 narrows to from itself, body carried");
const gLost = JSON.parse(await handleTool("bais_graph", { from: "tu#nope", depth: 1 }));
check(gLost.issues.length === 0 && gLost.truncated === false, "graph from an unknown id is an explicit empty (not an error)");

// (C5) ready→show→stage + graph→show end-to-end on the tu board.
const run2 = (args) => {
	try {
		return { code: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120000, cwd: home2 }) };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const rshow = run2(["bais", "show", "tu#03"]);
check(rshow.code === 0 && rshow.out.includes("Rgamma body."), "ready→show renders the staged body from the row id");
await handleTool("bais_move", { id: "tu#03", status: "Doing" });
const rstaged = JSON.parse(await handleTool("bais_ready", {}));
check(!rstaged.issues.some((r) => (r.id ?? r?.issue?.id) === "tu#03"), "staged move leaves the ready rows");
await handleTool("bais_move", { id: "tu#03", status: "Open" });
const gshow = run2(["bais", "show", "tu#11"]);
check(gshow.code === 0 && gshow.out.includes("Chain body 11."), "graph→show renders the neighbor body from the row id");

// --- phase D (bi#213): big-board ready rows + graph node cap ---
process.chdir(home);
// Bare ready on the ~300-issue board: rows only, still under the cap.
const bigReady = await handleTool("bais_ready", {});
const bigReadyRows = JSON.parse(bigReady);
console.log(`info: big-board bare ready is ${bytes(bigReady)} bytes for ${bigReadyRows.issues.length} rows`);
check(bytes(bigReady) < CAP, `bare big-board ready stays under the byte cap (got ${bytes(bigReady)})`);
check(!bigReady.includes('"body"'), "big-board ready rows carry no bodies");
// tt#01 + tt#02 are Doing (phase A pins), everything else Open and unblocked.
check(bigReadyRows.issues.length === bigRows.issues.length - 2, `big-board ready stays complete (got ${bigReadyRows.issues.length}, want ${bigRows.issues.length - 2})`);
// Graph node cap: a 251-node star (center + 250 Related leaves) truncates
// by node count even at depth 1, with the notice naming the refinement.
writeFileSync(
	join(home, ".bais", "issues", "tt#500.toml"),
	`id = "tt#500"\ntitle = "star center"\nstatus = "Open"\nkind = "Feat"\nbody = """\nCenter.\n"""\n`,
);
for (let n = 501; n <= 750; n++) {
	const id = `tt#${n}`;
	writeFileSync(
		join(home, ".bais", "issues", `${id}.toml`),
		`id = "${id}"\ntitle = "leaf ${n}"\nstatus = "Open"\nkind = "Feat"\nbody = """\nLeaf.\n"""\n\n[[edge]]\nfrom = "${id}"\nto = "tt#500"\nkind = "Related"\n`,
	);
}
const star = JSON.parse(await handleTool("bais_graph", { from: "tt#500", depth: 1 }));
console.log(`info: star graph returned ${star.issues.length} rows, truncated=${star.truncated}`);
check(star.truncated === true, "251-node star truncates at the node cap");
check(star.issues.length === 200, `star keeps the first 200 rows (got ${star.issues.length})`);
check(typeof star.notice === "string" && star.notice.includes("narrower --from") && star.notice.includes("shallower depth"), "star notice names the refinement (narrower --from, shallower depth)");

// --- phase E (bi#214): bais_list structured filters, third sandbox ---
// Hand-written TOML (severity needs a bare int, which bais_new never
// emits) under project tq: areas/kinds/severities + footer titles +
// Problem:/Proposal: bodies + a non-numeric id + a garbage file.
const home3 = mkdtempSync(join(tmpdir(), "bi-paycap214-"));
mkdirSync(join(home3, ".bais", "issues"), { recursive: true });
writeFileSync(join(home3, ".bais", "config.toml"), 'project = "tq"\n');
const tq = (id, title, kind, area, sev, body) => {
	writeFileSync(
		join(home3, ".bais", "issues", `${id}.toml`),
		`id = "${id}"\ntitle = "${title}"\nstatus = "Open"\nkind = "${kind}"\narea = "${area}"\nseverity = ${sev}\nbody = """\n${body}\n"""\n`,
	);
};
tq("tq#07", "footer polish", "Bug", "cli/bi", 2, "Problem: footer overlaps the pager on narrow screens.");
tq("tq#100", "footer nav links", "Feat", "cli/bi", 3, "Proposal: add footer nav links.");
tq("tq#101", "a11y audit of footer", "Bug", "agent/reconcile", 2, "Problem: footer contrast fails AA.");
tq("tq#102", "header cleanup", "Feat", "cli/bi", 1, "Proposal: drop the dead header flags.");
tq("tq#hotfix", "footer emergency fix", "Flake", "cli/bi", 1, "Hotfix body, no sections.");
writeFileSync(join(home3, ".bais", "issues", "tq#bad.toml"), "this is {{{ not toml\n");
process.chdir(home3);
const rowIds = (res) => JSON.parse(res).issues.map((r) => r.id ?? r?.issue?.id).sort();

// (E0) The schema advertises every filter with its type.
const listSpec = (await ListTools_async()).find((t) => t.name === "bais_list");
const props = listSpec?.input_schema?.properties ?? {};
check(props.kind?.type === "string", "bais_list schema advertises kind:string");
check(props.area?.type === "string", "bais_list schema advertises area:string");
check(props.severity?.type === "number", "bais_list schema advertises severity:number");
check(props.query?.type === "string", "bais_list schema advertises query:string");
check(props.title_regex?.type === "string", "bais_list schema advertises title_regex:string");
check(props.body_regex?.type === "string", "bais_list schema advertises body_regex:string");
check(props.id_min?.type === "number", "bais_list schema advertises id_min:number");
check(props.id_max?.type === "number", "bais_list schema advertises id_max:number");

// (E1) query: case-insensitive substring over id + title, rows only.
const qFooter = await handleTool("bais_list", { query: "footer" });
check(JSON.stringify(rowIds(qFooter)) === JSON.stringify(["tq#07", "tq#100", "tq#101", "tq#hotfix"]), "query footer returns matching rows only");
check(!qFooter.includes('"body"'), "query results are rows (no bodies)");
const qUpper = await handleTool("bais_list", { query: "FOOTER" });
check(JSON.stringify(rowIds(qUpper)) === JSON.stringify(["tq#07", "tq#100", "tq#101", "tq#hotfix"]), "query is case-insensitive");
const qId = await handleTool("bais_list", { query: "tq#10" });
check(JSON.stringify(rowIds(qId)) === JSON.stringify(["tq#100", "tq#101", "tq#102"]), "query matches over ids too");

// (E2) Exact keys ANDed: area+kind narrows, severity exact-matches.
check(JSON.stringify(rowIds(await handleTool("bais_list", { area: "cli/bi", kind: "Feat" }))) === JSON.stringify(["tq#100", "tq#102"]), "area+kind AND narrows");
check(JSON.stringify(rowIds(await handleTool("bais_list", { severity: 2 }))) === JSON.stringify(["tq#07", "tq#101"]), "severity exact-matches");
check(JSON.stringify(rowIds(await handleTool("bais_list", { status: "Open", kind: "Bug", area: "agent/reconcile", severity: 2 }))) === JSON.stringify(["tq#101"]), "status+kind+area+severity AND to one");

// (E3) Regexes over title / body (section searches need no second tool).
check(JSON.stringify(rowIds(await handleTool("bais_list", { title_regex: "^footer" }))) === JSON.stringify(["tq#07", "tq#100", "tq#hotfix"]), "title_regex anchors");
check(JSON.stringify(rowIds(await handleTool("bais_list", { body_regex: "Proposal:" }))) === JSON.stringify(["tq#100", "tq#102"]), "body_regex covers section searches");

// (E4) id_min/id_max bound the numeric part per namespace.
check(JSON.stringify(rowIds(await handleTool("bais_list", { id_min: 100 }))) === JSON.stringify(["tq#100", "tq#101", "tq#102"]), "id_min bounds below (non-numeric excluded)");
check(JSON.stringify(rowIds(await handleTool("bais_list", { id_max: 101 }))) === JSON.stringify(["tq#07", "tq#100", "tq#101"]), "id_max bounds above (non-numeric excluded)");
check(JSON.stringify(rowIds(await handleTool("bais_list", { id_min: 100, id_max: 101 }))) === JSON.stringify(["tq#100", "tq#101"]), "id_min+id_max bound the namespace range");

// (E5) Invalid regex refuses loud, naming the pattern — never silent empty.
for (const arg of ["title_regex", "body_regex"]) {
	let err = null;
	try {
		await handleTool("bais_list", { [arg]: "([" });
	} catch (e) {
		err = String(e?.message ?? e);
	}
	check(err !== null && err.includes(arg) && err.includes("([") , `invalid ${arg} refuses loud naming the pattern`);
}

// (E6) Empty result is explicit, not an error; unparseable still present.
const qEmpty = JSON.parse(await handleTool("bais_list", { query: "zzz-no-such-issue" }));
check(Array.isArray(qEmpty.issues) && qEmpty.issues.length === 0, "empty result is an explicit empty list");
check(Array.isArray(qEmpty.unparseable) && qEmpty.unparseable.length === 1, "empty result keeps unparseable present");

// (E7) search→show→stage end-to-end on the tq board.
const run3 = (args) => {
	try {
		return { code: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120000, cwd: home3 }) };
	} catch (e) {
		return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
	}
};
const searched = rowIds(await handleTool("bais_list", { query: "nav links" }));
check(JSON.stringify(searched) === JSON.stringify(["tq#100"]), "search finds the issue by title substring");
const tshow = run3(["bais", "show", "tq#100"]);
check(tshow.code === 0 && tshow.out.includes("Proposal: add footer nav links."), "search→show renders the body from the row id");
await handleTool("bais_move", { id: "tq#100", status: "Doing" });
check(JSON.stringify(rowIds(await handleTool("bais_list", { status: "Doing" }))) === JSON.stringify(["tq#100"]), "staged move visible under the status filter");

if (failures) {
	console.error(`bais-payload-cap: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("bais-payload-cap: all green");
