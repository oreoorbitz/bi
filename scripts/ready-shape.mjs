// bi/scripts/ready-shape.mjs — bi#62: readyBaisIssues output conformance.
// The agent's prompt context is only as good as this shape: every entry
// must carry a non-empty id + title (+ status/kind when present), no
// empties, no duplicates. Runs against the nearest hub (bi/.bais if
// present, else the root hub — migrated 2026-09-06; read-only, offline).
//
// bi#74 cwd note (docs-only; no code change warranted): this script is
// cwd-independent by construction — the hub dir and the bais.js import
// below both resolve from this file's own path (ROOT), never from
// process.cwd(). Verified exit 0 with identical counts from cwd=bi/,
// cwd=repo-root, and cwd=/tmp against the same store (29 entries each,
// read-source "store" in all three).
//   Worktree constraint (the actual bi#74 cause, not cwd): a 0-ready
// result with identical .toml bytes means the BAIS parser module failed
// to load, NOT an empty backlog. bi/dist resolves bais/dist per
// candidates that must hit a BUILT bais/dist (git-ignored, absent in a
// fresh worktree; symlinked node_modules can also break the bridge /
// native import, and the loader swallows the real error into "BAIS
// parser not found" per-file failures → ready collapses to []). The
// BAML bridge resolving per-cwd was refuted (see counts above). Before
// trusting a 0 in a worktree: rebuild bais dist and re-sync store.db
// (also git-ignored, per-worktree); a stale-but-newer or empty store
// id-set likewise serves 0 through the store path.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { readyBaisIssues } = await import(join(ROOT, "..", "dist", "src", "bais.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const localHub = join(ROOT, "..", ".bais", "issues");
const rootHub = join(ROOT, "..", "..", ".bais", "issues");
const ready = await readyBaisIssues(existsSync(localHub) ? localHub : rootHub);
check(Array.isArray(ready), "readyBaisIssues returns an array");
const ids = new Set();
let shapeOk = true;
for (const f of ready) {
	const id = f?.issue?.id;
	const title = f?.issue?.title;
	if (typeof id !== "string" || id === "" || typeof title !== "string" || title === "") shapeOk = false;
	if (ids.has(id)) shapeOk = false;
	ids.add(id);
}
check(shapeOk, `every ready entry has non-empty id+title, no duplicates (${ready.length} entries)`);
check(ready.length > 0, "backlog is non-empty (conformance is vacuous on empty)");

console.log(failures === 0 ? "ready-shape: all green" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
