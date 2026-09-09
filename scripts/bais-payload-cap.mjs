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

// (5) bais_check: compact + semantics unchanged on the small board.
const checkOut = await handleTool("bais_check", {});
const direct = await checkBaisIssues();
check(!checkOut.includes("\n  "), "bais_check is compact JSON (no pretty indent)");
check(checkOut === JSON.stringify(direct), "bais_check semantics unchanged (tool output byte-equals direct check)");
check(JSON.parse(checkOut).ok.length === 3, "small-board check sees all three issues");

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
check(bigCheck.includes("…truncated") && bigCheck.includes("bais show"), "over-cap check truncates with a notice naming bais show");

if (failures) {
	console.error(`bais-payload-cap: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("bais-payload-cap: all green");
