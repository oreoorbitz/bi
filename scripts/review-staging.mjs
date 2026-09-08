// bi/scripts/review-staging.mjs — hub#203 staging-gate conformance.
// Drives the REAL review-turn module over in-memory IO and asserts the
// acceptance clauses: (1) stageProposal lands MemoryAdd/SkillPatch/
// IssueProposal in pending/ and never stages NothingToSave, (2) approve
// applies to the right sink and only then leaves pending/, (3) reject
// drops without touching a sink, (4) THE GATE: a proposal that is not in
// the pending/ listing never reaches a sink (not_pending), (5) corrupt
// proposals fail loud and STAY in pending/ (no silent deletion), (6) id
// shape escapes refuse.
//
// Module resolution: dist by convention (like every suite here); set
// BI_REVIEW_UNDER_TEST to drive a scratch source path instead (this wave's
// verification — the merger builds dist once, so fixtures run pre-build
// against src/review-turn.ts via node type-stripping).
//
// bi#57 red-check record (staging gate):
//   hunk: requirePending's `if (!ids.includes(id)) throw … not_pending`
//         membership check in src/review-turn.ts
//   expected reason: an action that was never staged via stageProposal
//     (smuggled into pending/ by another writer, or replayed after
//     approval) must never reach a sink — the pending/ LISTING is ground
//     truth, not file readability
//   observed: with the hunk reverted, this drill FAILs as
//     "FAIL: staging gate holds: unstaged proposal never reaches a sink
//     (sink fired — gate bypassed)"; restored, `node scripts/
//     review-staging.mjs` prints all ok, 0 failures.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MOD = process.env.BI_REVIEW_UNDER_TEST ?? join(ROOT, "..", "dist", "src", "review-turn.js");
const R = await import(MOD);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

function fakeIo() {
	const files = new Map(); // id -> json
	const sinks = { memory: [], skill: [], issue: [] };
	const io = {
		writeProposal: (id, json) => void files.set(id, json),
		readProposal: (id) => files.get(id) ?? null,
		removeProposal: (id) => void files.delete(id),
		listProposalIds: () => [...files.keys()].sort(),
		applyMemory: (f) => void sinks.memory.push(f),
		applySkill: (f) => void sinks.skill.push(f),
		applyIssue: (f) => void sinks.issue.push(f),
	};
	return { files, sinks, io };
}

const MEMORY = { op: "add", content: "User prefers terse answers.", old_text: null, rationale: "explicit correction" };
const SKILL = { skill: "baml-core", action: "add_reference", target_file: "references/pins.md", content: "# Pins", rationale: "pin mismatch cost a session" };
const ISSUE = { title: "review fork double-stages", kind: "Bug", area: "bi/review", body: "Repro: …", rationale: "outlives session" };
const NOTHING = { reason: "smooth session, no corrections" };

const throwsReason = async (p, reason, msg) => {
	try {
		await p;
	} catch (e) {
		check(e?.reason === reason, `${msg} (got reason ${JSON.stringify(e?.reason)}: ${e?.message})`);
		return;
	}
	check(false, `${msg} (no throw)`);
};

// (1) staging: three proposal kinds land; NothingToSave never staged.
{
	const { files, io } = fakeIo();
	let n = 0;
	const idgen = () => `p${++n}`;
	const r1 = await R.stageProposal(MEMORY, { idgen, session_id: "s1" }, io);
	const r2 = await R.stageProposal(SKILL, { idgen, session_id: "s1" }, io);
	const r3 = await R.stageProposal(ISSUE, { idgen, session_id: "s1" }, io);
	const r4 = await R.stageProposal(NOTHING, { idgen }, io);
	check(r1.staged && r2.staged && r3.staged, "three proposal kinds stage");
	check(files.size === 3, "pending/ holds exactly the three proposals");
	check(!r4.staged && r4.id === null && /no corrections/.test(r4.reason), "NothingToSave is a real outcome, never staged");
	check(files.size === 3, "NothingToSave did not add a pending file");
	const env = JSON.parse(files.get("p1"));
	check(env.type === "MemoryAdd" && env.session_id === "s1" && env.fields.op === "add", "envelope carries type, session, fields");
}

// (2) approve: right sink fires, then the proposal leaves pending/.
{
	const { files, sinks, io } = fakeIo();
	const r = await R.stageProposal(SKILL, { idgen: () => "s1" }, io);
	check(r.staged, "staged for approve");
	const p = await R.approveProposal("s1", io);
	check(p.type === "SkillPatch", "approve returns the applied proposal");
	check(sinks.skill.length === 1 && sinks.skill[0].skill === "baml-core", "skill sink fired with the fields");
	check(sinks.memory.length === 0 && sinks.issue.length === 0, "no other sink fired");
	check(files.size === 0, "applied proposal left pending/");
}

// approve applies memory and issue to their own sinks.
{
	const { sinks, io } = fakeIo();
	await R.stageProposal(MEMORY, { idgen: () => "m1" }, io);
	await R.stageProposal(ISSUE, { idgen: () => "i1" }, io);
	await R.approveProposal("m1", io);
	await R.approveProposal("i1", io);
	check(sinks.memory.length === 1 && sinks.memory[0].op === "add", "memory sink fired");
	check(sinks.issue.length === 1 && sinks.issue[0].kind === "Bug", "issue sink fired");
}

// sink failure keeps the proposal pending (named, retryable — never half-applied).
{
	const { files, io } = fakeIo();
	await R.stageProposal(MEMORY, { idgen: () => "m1" }, io);
	io.applyMemory = () => {
		throw new Error("disk full");
	};
	let threw = false;
	try {
		await R.approveProposal("m1", io);
	} catch {
		threw = true;
	}
	check(threw, "sink failure propagates");
	check(files.has("m1"), "failed apply leaves the proposal in pending/");
}

// (3) reject: drops the proposal, sinks untouched.
{
	const { files, sinks, io } = fakeIo();
	await R.stageProposal(MEMORY, { idgen: () => "m1" }, io);
	const p = await R.rejectProposal("m1", io);
	check(p.type === "MemoryAdd", "reject returns the dropped proposal");
	check(files.size === 0, "rejected proposal left pending/");
	check(sinks.memory.length === 0 && sinks.skill.length === 0 && sinks.issue.length === 0, "reject touched no sink");
}

// (4) THE GATE: not in the pending/ listing → never reaches a sink.
// This is the bi#57 red-check case named in the header — with
// requirePending's membership hunk reverted, the memory sink FIRES here
// and the check fails as "gate bypassed".
{
	const { files, sinks, io } = fakeIo();
	// A file exists on "disk" but was never staged through stageProposal
	// (smuggled): listProposalIds is rigged to NOT list it — ground truth.
	files.set("smuggled", JSON.stringify({ id: "smuggled", type: "MemoryAdd", session_id: null, staged_at: "", fields: MEMORY }));
	io.listProposalIds = () => [];
	await throwsReason(R.approveProposal("smuggled", io), "not_pending", "approve refuses an unstaged proposal");
	check(sinks.memory.length === 0, "staging gate holds: unstaged proposal never reaches a sink (sink fired — gate bypassed)");
	await throwsReason(R.rejectProposal("smuggled", io), "not_pending", "reject is gated by the same listing");
}

// approve of a NothingToSave envelope (hostile staging) refuses, named.
{
	const { files, io } = fakeIo();
	files.set("n1", JSON.stringify({ id: "n1", type: "NothingToSave", session_id: null, staged_at: "", fields: NOTHING }));
	await throwsReason(R.approveProposal("n1", io), "not_appliable", "NothingToSave is not appliable");
}

// (5) corrupt proposals fail loud and STAY in pending/.
{
	const { files, io } = fakeIo();
	files.set("bad1", "not json at all");
	files.set("bad2", JSON.stringify({ id: "bad2", type: "MemoryAdd", fields: { skill: "x", action: "patch", target_file: "SKILL.md" } }));
	const list = await R.listPending(io);
	check(list.proposals.length === 0 && list.corrupt.length === 2, "listPending names both corrupt files");
	check(/corrupt_proposal/.test(list.corrupt[0].reason) && /corrupt_proposal/.test(list.corrupt[1].reason), "corrupt reasons are named");
	check(files.has("bad1") && files.has("bad2"), "corrupt proposals are NOT silently deleted");
	await throwsReason(R.approveProposal("bad2", io), "corrupt_proposal", "type/fields mismatch refuses on approve");
	check(files.has("bad2"), "mismatched proposal survives the refused approve");
}

// (6) id shape: escapes refuse before any read.
{
	const { sinks, io } = fakeIo();
	await throwsReason(R.approveProposal("../etc/passwd", io), "bad_id", "path-escape id refuses on approve");
	await throwsReason(R.rejectProposal("a/b", io), "bad_id", "slash id refuses on reject");
	check(sinks.memory.length === 0, "no sink fired for bad ids");
}

// unknown action shapes fail loud on stage (bi#55: no silent drop).
{
	const { io } = fakeIo();
	await throwsReason(R.stageProposal({ wat: 1 }, { idgen: () => "x1" }, io), "unknown_action", "unknown union shape refuses to stage");
}

console.log(failures ? `\n${failures} FAILURES` : "\nall review-staging checks passed");
process.exit(failures ? 1 : 0);
