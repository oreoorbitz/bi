// bi/scripts/ready-shape.mjs — bi#62: readyBaisIssues output conformance.
// The agent's prompt context is only as good as this shape: every entry
// must carry a non-empty id + title (+ status/kind when present), no
// empties, no duplicates. Runs against bi/.bais (read-only, offline).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { readyBaisIssues } = await import(join(ROOT, "..", "dist", "src", "bais.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const ready = await readyBaisIssues(join(ROOT, "..", ".bais", "issues"));
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
