// bi/scripts/review-queue.mjs — bi#138 hunk-queue conformance.
// Drives the REAL review module over fixture diffs and asserts the four
// acceptance clauses: (1) the queue covers every changed line exactly once,
// (2) a challenge without proof fails loud, (3) a flag files a linked issue,
// (4) --json emits the verdict set. Plus the read-only gates: --skeptic
// refuses with its named reason, unknown hunks/duplicates fail loud.
//
// Module resolution: dist by convention (like every suite here); set
// BI_REVIEW_UNDER_TEST to drive a scratch source path instead (this wave's
// verification — the merger builds dist once, so fixtures run pre-build
// against src/review.ts via node type-stripping).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MOD = process.env.BI_REVIEW_UNDER_TEST ?? join(ROOT, "..", "dist", "src", "review.js");
const R = await import(MOD);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const throwsReason = (fn, reason, msg) => {
	try {
		const r = fn();
		if (r instanceof Promise) throw new Error("unexpected async");
	} catch (e) {
		check(e?.reason === reason, `${msg} (got reason ${JSON.stringify(e?.reason)}: ${e?.message})`);
		return;
	}
	check(false, `${msg} (no throw)`);
};

// Fixture diff: two files, three hunks, plus a new file and a deletion.
// Every changed line must appear in the queue exactly once.
const DIFF = `diff --git a/bi/src/a.ts b/bi/src/a.ts
index 111..222 100644
--- a/bi/src/a.ts
+++ b/bi/src/a.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,4 +10,5 @@
 x
 y
+z
 w
diff --git a/bi/src/new.ts b/bi/src/new.ts
new file mode 100644
index 000..123
--- /dev/null
+++ b/bi/src/new.ts
@@ -0,0 +1,2 @@
+n1
+n2
diff --git a/bi/src/gone.ts b/bi/src/gone.ts
deleted file mode 100644
index 123..000
--- a/bi/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-g1
-g2
`;

const files = R.parseUnifiedDiff(DIFF);
check(files.length === 3, `three files parsed (got ${files.length})`);
check(files[0].file === "bi/src/a.ts" && files[0].hunks.length === 2, "a.ts keeps both hunks");
check(files[1].file === "bi/src/new.ts", `new file path (got ${files[1]?.file})`);
check(files[2].file === "bi/src/gone.ts", `deleted file path (got ${files[2]?.file})`);

const prov = (file) =>
	file === "bi/src/a.ts"
		? { issue: "bi#12", agent: "a1", handoff: null }
		: file === "bi/src/new.ts"
			? { issue: "bi#13", agent: "a2", handoff: "/tmp/t-deliver/NOTES.md" }
			: { issue: null, agent: null, handoff: null };
const queue = R.buildHunkQueue(files, prov);
check(queue.length === 4, `four hunks queued (got ${queue.length})`);
check(JSON.stringify(queue.map((h) => h.id)) === "[1,2,3,4]", "ids sequential from 1 across files");
check(queue[0].provenance.issue === "bi#12" && queue[2].provenance.issue === "bi#13", "provenance rides per file");
check(queue[3].provenance.issue === null, "unknown provenance stays null, never invented");

// (1) coverage: every changed line exactly once.
try {
	R.assertQueueCoversDiffOnce(queue, files);
	check(true, "queue covers every changed line exactly once");
} catch (e) {
	check(false, `coverage probe threw: ${e?.message}`);
}
// A dropped line is a gap, not a silent short queue.
const dropped = queue.filter((h) => h.id !== 4).map((h) => ({ ...h }));
throwsReason(() => R.assertQueueCoversDiffOnce(dropped, files), "queue-coverage-gap", "dropped hunk fails as queue-coverage-gap");
// A duplicated hunk line fails as duplicate.
const duped = [...queue, { ...queue[0] }];
throwsReason(() => R.assertQueueCoversDiffOnce(duped, files), "queue-coverage-duplicate", "duplicated hunk fails as queue-coverage-duplicate");

// Decisions: approve + question + challenge(with proof) + flag.
const decisions = R.applyDecisionInputs(queue, [
	{ hunk: 1, action: "approve" },
	{ hunk: 2, action: "question", text: "why z here?" },
	{ hunk: 3, action: "challenge", proof: "test:scripts/review-queue.mjs" },
	{ hunk: 4, action: "flag", title: "g1 removal looks unrelated" },
]);
check(decisions.length === 4, "four decisions applied");

// (2) challenge without proof fails loud — never asserts.
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: 1, action: "challenge" }]), "challenge-needs-proof", "challenge without proof fails loud");
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: 1, action: "challenge", proof: "  " }]), "challenge-needs-proof", "blank proof fails loud");
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: 1, action: "question" }]), "question-needs-text", "question without text fails loud");
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: 1, action: "flag" }]), "flag-needs-title", "flag without title fails loud");
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: 99, action: "approve" }]), "unknown-hunk", "unknown hunk id fails loud");
throwsReason(() => R.applyDecisionInputs(queue, [{ hunk: "bi/src/a.ts#9", action: "approve" }]), "unknown-hunk", "unknown path#n fails loud");
throwsReason(
	() =>
		R.applyDecisionInputs(queue, [
			{ hunk: 1, action: "approve" },
			{ hunk: 1, action: "skip" },
		]),
	"duplicate-decision",
	"second decision on one hunk fails loud",
);
// path#n refs resolve.
const byPath = R.applyDecisionInputs(queue, [{ hunk: "bi/src/a.ts#2", action: "skip" }]);
check(byPath[0].hunk === 2, "path#n resolves to the queue id");

// (3) flag files a LINKED issue through injected IO.
const recorded = [];
const created = await R.applyFlagSpecs(
	decisions.filter((d) => d.action === "flag").map((d) => R.flagSpecFor(queue, d)),
	{ createIssue: async (spec) => (recorded.push(spec), { id: "bi#900" }) },
);
check(JSON.stringify(created) === `["bi#900"]`, "flag returns the created id");
// Hunk #4 (gone.ts) has no provenance issue → unlinked spec, still filed.
check(recorded.length === 1 && recorded[0].edges.length === 0, "unattributed flag files unlinked (no invented edge)");
check(recorded[0].body.includes("Files: bi/src/gone.ts"), "flag body carries the Files: footprint");
// A flag on an attributed hunk links Related to the provenance issue.
const linked = [];
await R.applyFlagSpecs([R.flagSpecFor(queue, { hunk: 1, file: "x", action: "flag", text: null, proof: null, title: "t" })], {
	createIssue: async (spec) => (linked.push(spec), { id: "bi#901" }),
});
check(JSON.stringify(linked[0].edges) === JSON.stringify([{ kind: "Related", to: "bi#12" }]), "attributed flag links Related to the provenance issue");
check(linked[0].body.includes("@@ -1,3 +1,3 @@") && linked[0].body.includes("issue bi#12"), "flag body carries hunk + provenance");

// (4) --json payload: verdicts reuse the bi#83 shape.
const payload = R.reviewToJson("HEAD", queue, decisions);
check(payload.ref === "HEAD" && payload.hunks.length === 4, "--json carries ref + full queue");
check(JSON.stringify(payload.verdicts) === JSON.stringify(["verdict(bi#12)"]), `verdicts reuse verdict(ID) shape (got ${JSON.stringify(payload.verdicts)})`);
check(payload.flags.length === 1 && payload.flags[0].title === "g1 removal looks unrelated", "--json carries flag specs for the dry run");
// Approvals on unattributed hunks yield no ref — never an unresolvable one.
const unattributed = R.reviewToJson("HEAD", queue, R.applyDecisionInputs(queue, [{ hunk: 4, action: "approve" }]));
check(unattributed.verdicts.length === 0, "unattributed approval yields no verdict ref");
// Duplicate provenance issues dedupe to one ref.
const both = R.reviewToJson(
	"HEAD",
	queue,
	R.applyDecisionInputs(queue, [
		{ hunk: 1, action: "approve" },
		{ hunk: 2, action: "approve" },
	]),
);
check(JSON.stringify(both.verdicts) === JSON.stringify(["verdict(bi#12)"]), "same-issue approvals dedupe");

// Untracked files are outside the diff — the queue must say so loudly.
check(JSON.stringify(R.parseUntrackedFiles(" M bi/src/a.ts\n?? bi/src/new.ts\n?? \"sp ace.ts\"\nA  staged.ts\n")) === JSON.stringify(["bi/src/new.ts", "sp ace.ts"]), "porcelain ?? lines parse as untracked");
check(R.parseUntrackedFiles("").length === 0, "clean status parses empty");
check(R.reviewToJson("HEAD", queue, decisions, ["bi/src/new.ts"]).untracked.length === 1, "--json carries the untracked list");
check(R.reviewToJson("HEAD", queue, decisions).untracked.length === 0, "untracked defaults empty");

// Read-only gates.
throwsReason(() => R.assertSkepticReady(true), "unimplemented-skeptic-engine", "--skeptic gates with its named reason");
R.assertSkepticReady(false);
check(true, "no --skeptic passes the gate");

// Diff-source argv (read-only git, never mutates).
check(JSON.stringify(R.gitDiffArgs(null)) === JSON.stringify(["diff", "--no-color", "HEAD", "--"]), "default is the worktree diff");
check(JSON.stringify(R.gitDiffArgs("abc123")) === JSON.stringify(["diff", "--no-color", "abc123", "--"]), "single ref diffs worktree vs ref");
check(JSON.stringify(R.gitDiffArgs("a..b")) === JSON.stringify(["diff", "--no-color", "a", "b", "--"]), "range diffs its endpoints");

// Provenance matching: Doing-first footprints, suffix-tolerant, overrides win.
const fps = [
	{ id: "bi#12", holder: "w1", files: ["bi/src/a.ts"] },
	{ id: "bi#13", holder: null, files: ["src/new.ts"] },
];
check(R.provenanceForFile("bi/src/a.ts", fps).agent === "w1", "exact claim matches with holder as agent");
check(R.provenanceForFile("bi/src/new.ts", fps).issue === "bi#13", "suffix claim matches across cwd roots");
check(R.provenanceForFile("bi/src/other.ts", fps).issue === null, "unclaimed file stays unknown");
check(
	R.provenanceForFile("bi/src/a.ts", fps, { "bi/src/a.ts": { issue: "bi#99", agent: "ov", handoff: "/tmp/ov-deliver" } }).issue === "bi#99",
	"--provenance override wins",
);

if (failures) process.exit(1);
console.log("review-queue: all green");
