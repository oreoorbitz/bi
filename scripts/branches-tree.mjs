// bi/scripts/branches-tree.mjs — session-branch tree conformance (bi#87).
// Drives the REAL host walk (dist/src/session.js) over a temp
// BI_SESSION_DIR plus the REAL BAML gutters (dist/baml_sdk) and asserts:
// (1) /fork-style parent links nest as children, /clone-style parentless
// copies list as roots, orphans/self-links root too, unreachable cycles
// terminate dropped; (2) children sort by timestamp then id, depth and
// is_last/gu transitive guides render pi-style connectors (├─/└─/│);
// (3) branchSwitchState adopts the /resume triple (file, user-turn
// count, persisted length); (4) the empty store prints the grow hint.
// The TTY modal itself (pickList over these rows) is pi-tui-owned and
// covered headlessly by prompt.mjs; the REPL switch arm in cli.ts
// consumes branchSwitchState + replayCompactionBlocks (bi#97, covered
// by compaction-blocks.mjs) — this suite pins everything beneath it.
//
// Red-check (bi#57): flip the orphan rule in session.ts orderBranchRows
// (`!byId.has(p)` -> `byId.has(p)`), rebuild, and this suite must fail
// at "orphan roots at depth 0" — the orphan detaches from the walk.
// Observed red 2026-09-06, restored green same day.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const session = await import(join(ROOT, "..", "dist", "src", "session.js"));
const baml = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { createSessionFile, appendSessionEntries, sessionBranchList, orderBranchRows, branchSwitchState } = session;
const { branch_row_prefix_async, format_branch_row_async, format_branches_list_async } = baml;

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "bi-branches-"));
const msg = (role, text) => ({ role, text, provider: null, model: null, thinking: null });

// Forest: A root; B/C forks of A (B older); D2 grandchild of B;
// D clone-style copy (no parent); E orphan (parent missing);
// F self-link; G/H unreachable 2-cycle.
const fA = createSessionFile({ id: "a-root", cwd: "/w", sessionDir: dir });
appendSessionEntries(fA, [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")]);
const fB = createSessionFile({ id: "b-fork", cwd: "/w", parentSession: "a-root", label: "try-x", sessionDir: dir });
appendSessionEntries(fB, [msg("user", "u1")]);
const fC = createSessionFile({ id: "c-fork", cwd: "/w", parentSession: "a-root", sessionDir: dir });
appendSessionEntries(fC, [msg("user", "u1"), msg("assistant", "a1")]);
const fD2 = createSessionFile({ id: "d-grand", cwd: "/w", parentSession: "b-fork", sessionDir: dir });
createSessionFile({ id: "e-clone", cwd: "/w", sessionDir: dir });
createSessionFile({ id: "f-orphan", cwd: "/w", parentSession: "gone", sessionDir: dir });
createSessionFile({ id: "g-self", cwd: "/w", parentSession: "g-self", sessionDir: dir });
createSessionFile({ id: "h-cyc1", cwd: "/w", parentSession: "i-cyc2", sessionDir: dir });
createSessionFile({ id: "i-cyc2", cwd: "/w", parentSession: "h-cyc1", sessionDir: dir });

// (1) walk: links, turns, labels.
const entries = await sessionBranchList(dir);
check(entries.length === 9, `9 sessions listed (got ${entries.length})`);
const byId = new Map(entries.map((e) => [e.id, e]));
check(byId.get("b-fork")?.parent === "a-root", "fork keeps its parent link");
check(byId.get("e-clone")?.parent === null, "clone stays parentless");
check(byId.get("a-root")?.turns === 2, "root counts 2 user turns");
check(byId.get("b-fork")?.turns === 1, "fork counts 1 user turn");
check(byId.get("b-fork")?.label === "try-x", "fork keeps its label");

// (2) order + gutters.
const rows = orderBranchRows(entries);
const ids = rows.map((r) => r.id);
check(JSON.stringify(ids) === JSON.stringify(["a-root", "b-fork", "d-grand", "c-fork", "e-clone", "f-orphan", "g-self"]), `roots-first, children by time: ${ids.join(",")}`);
check(!ids.includes("h-cyc1") && !ids.includes("i-cyc2"), "unreachable cycle dropped, never hung");
check(rows.some((r) => r.id === "f-orphan" && r.depth === 0), "orphan roots at depth 0");
const depth = new Map(rows.map((r) => [r.id, r.depth]));
check(depth.get("a-root") === 0 && depth.get("b-fork") === 1 && depth.get("d-grand") === 2, "depths 0/1/2 down the fork line");
const last = new Map(rows.map((r) => [r.id, r.is_last]));
check(last.get("b-fork") === false && last.get("c-fork") === true && last.get("d-grand") === true, "sibling-last flags (B ├─, C └─, D2 └─)");
const row = async (id) => {
	const r = rows.find((x) => x.id === id);
	const e = byId.get(id);
	return format_branch_row_async(e.id, e.label, e.turns, false, await branch_row_prefix_async(r.depth, r.is_last, r.guides));
};
check((await row("b-fork")).startsWith("  ├─ b-fork"), `fork row draws ├─ (${await row("b-fork")})`);
check((await row("c-fork")).startsWith("  └─ c-fork"), "second fork row draws └─");
check((await row("d-grand")).startsWith("  │  └─ d-grand"), "grandchild row keeps the │ guide");
check((await row("a-root")).startsWith("  a-root"), "root row has no connector");
const cur = await format_branch_row_async("b-fork", "try-x", 1, true, await branch_row_prefix_async(1, false, []));
check(cur.startsWith("* ") && cur.includes('"try-x"'), "current row marks * and names the label");
const empty = await format_branches_list_async([]);
check(empty === "no saved sessions — /fork or /clone to grow branches", "empty store prints the grow hint");

// (3) switch state: the /resume triple.
const st = branchSwitchState({ file: fB, history: [{ role: "user" }, { role: "assistant" }, { role: "user" }] });
check(st.file === fB && st.turn === 2 && st.persisted === 3, "switch adopts file + user-turn count + persisted length");

if (failures) process.exit(1);
console.log("branches-tree: all green");
