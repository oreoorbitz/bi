// bi/src/review-turn.ts — hub#203 post-turn review staging (pending → approve/reject).
//
// The BAML fork (baml_src/review.baml ReviewTurn) returns ONE plain-data
// ReviewAction per digest. This module is the consent gate between that
// proposal and bi's three stores: stageProposal writes the action into a
// pending/ dir, and ONLY approveProposal can reach a sink (memory, skill,
// or .bais/issues/). rejectProposal drops a staged proposal. Nothing else
// in this module — and nothing outside it — may apply a proposal: the
// sinks are injected here and handed out only after the pending check.
//
// Pure module (no imports — the bi#138 review.ts pattern): every effect
// takes injected IO so the fixture suite (scripts/review-staging.mjs)
// proves the gate without a build. cli.ts supplies the real fs IO + sinks.
//
// bi#57 red-check target — the staging gate:
//   hunk: requirePending's listProposalIds() membership check
//   expected reason: an action that was never staged via stageProposal
//     (smuggled into the dir by another writer, or replayed after
//     approval) must never reach a sink — pending/ membership is ground
//     truth, not file readability
//   observed: with the check removed, the drill case "approve bypasses
//     pending/ membership" FAILs as "staging gate bypassed: unstaged
//     proposal reached the memory sink"; restored, suite green.

export class ReviewStagingError extends Error {
	reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.reason = reason;
	}
}

export type ReviewActionType = "MemoryAdd" | "SkillPatch" | "IssueProposal" | "NothingToSave";

// Structural view of the baml_sdk ReviewAction union — this module stays
// import-free, so discrimination is by field shape (the SDK classes are
// plain data; see review.baml's FFI note).
export type ReviewActionData =
	| { op: "add" | "replace" | "remove"; content: string; old_text: string | null; rationale: string }
	| { skill: string; action: string; target_file: string; content: string; rationale: string }
	| { title: string; kind: string; area: string | null; body: string; rationale: string }
	| { reason: string };

export interface StagedProposal {
	id: string;
	type: ReviewActionType;
	session_id: string | null;
	staged_at: string;
	fields: Record<string, unknown>;
}

// All effects are injected. Sinks (applyMemory/applySkill/applyIssue) are
// called ONLY from approveProposal, after requirePending passes — cli.ts
// wires them to ~/.bi/memory.jsonl, the skills dir, and createBaisIssue.
export interface ReviewIO {
	writeProposal(id: string, json: string): void | Promise<void>;
	readProposal(id: string): string | null | Promise<string | null>;
	removeProposal(id: string): void | Promise<void>;
	listProposalIds(): string[] | Promise<string[]>;
	applyMemory(fields: Record<string, unknown>): void | Promise<void>;
	applySkill(fields: Record<string, unknown>): void | Promise<void>;
	applyIssue(fields: Record<string, unknown>): void | Promise<void>;
}

const PROPOSAL_ID_RE = /^[A-Za-z0-9_.-]+$/;

// Structural discrimination of the ReviewAction union. Unknown shapes fail
// loud (bi#55) — a new union arm must name itself here, never drop silent.
export function actionType(action: unknown): ReviewActionType {
	if (typeof action !== "object" || action === null) {
		throw new ReviewStagingError("unknown_action", `review action is not an object: ${typeof action}`);
	}
	const a = action as Record<string, unknown>;
	if (typeof a.op === "string" && typeof a.content === "string" && typeof a.rationale === "string") return "MemoryAdd";
	if (typeof a.skill === "string" && typeof a.action === "string" && typeof a.target_file === "string") return "SkillPatch";
	if (typeof a.title === "string" && typeof a.kind === "string" && typeof a.body === "string") return "IssueProposal";
	if (typeof a.reason === "string" && Object.keys(a).length === 1) return "NothingToSave";
	throw new ReviewStagingError("unknown_action", `review action matches no ReviewAction arm (keys: ${Object.keys(a).join(",")})`);
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "proposal";
}

export interface StageResult {
	staged: boolean;
	id: string | null;
	reason: string | null;
}

// Stage one ReviewAction into pending/. NothingToSave is a real outcome,
// not a proposal: it is logged by the caller and never staged (there is
// nothing to approve). Returns the staged id so the turn's summary line
// can name it.
export async function stageProposal(
	action: unknown,
	opts: { session_id?: string | null; now?: string; idgen?: (type: ReviewActionType) => string },
	io: Pick<ReviewIO, "writeProposal">,
): Promise<StageResult> {
	const type = actionType(action);
	if (type === "NothingToSave") {
		return { staged: false, id: null, reason: (action as { reason: string }).reason };
	}
	const id = opts.idgen
		? opts.idgen(type)
		: `${slug(type)}-${(opts.now ?? new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14)}`;
	if (!PROPOSAL_ID_RE.test(id)) {
		throw new ReviewStagingError("bad_id", `generated proposal id ${JSON.stringify(id)} is not [A-Za-z0-9_.-]+`);
	}
	const envelope: StagedProposal = {
		id,
		type,
		session_id: opts.session_id ?? null,
		staged_at: opts.now ?? new Date().toISOString(),
		fields: { ...(action as Record<string, unknown>) },
	};
	await io.writeProposal(id, JSON.stringify(envelope, null, 2) + "\n");
	return { staged: true, id, reason: null };
}

// Load-bearing gate (hub#203 acceptance; bi#57 red-check target — see the
// header): a proposal reaches a sink ONLY by proving current membership in
// pending/. The listing is ground truth, not readability: a file that was
// never staged through stageProposal (smuggled in by another writer, or
// replayed after approval removed it) must never be applied.
async function requirePending(io: ReviewIO, id: string): Promise<string> {
	if (!PROPOSAL_ID_RE.test(id)) {
		throw new ReviewStagingError("bad_id", `proposal id ${JSON.stringify(id)} is not [A-Za-z0-9_.-]+ — refusing to resolve it`);
	}
	const ids = await io.listProposalIds();
	if (!ids.includes(id)) {
		throw new ReviewStagingError("not_pending", `no staged proposal ${JSON.stringify(id)} in pending/ — approve/reject only touch staged proposals`);
	}
	const raw = await io.readProposal(id);
	if (raw == null) {
		throw new ReviewStagingError("not_pending", `staged proposal ${JSON.stringify(id)} vanished between list and read — refusing to apply`);
	}
	return raw;
}

// Envelope validation. Corrupt proposals fail loud and STAY in pending/
// (bi#55: no silent deletions) — a human inspects or rejects them.
export function parseStagedProposal(raw: string, id: string): StagedProposal {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} is not JSON: ${e instanceof Error ? e.message : e}`);
	}
	const p = parsed as Record<string, unknown>;
	if (typeof p !== "object" || p === null) throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} is not an object`);
	if (p.id !== id) throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} carries mismatched id ${JSON.stringify(p.id)}`);
	if (p.type !== "MemoryAdd" && p.type !== "SkillPatch" && p.type !== "IssueProposal" && p.type !== "NothingToSave") {
		throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} has unknown type ${JSON.stringify(p.type)}`);
	}
	if (typeof p.fields !== "object" || p.fields === null) {
		throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} carries no fields object`);
	}
	// The envelope's declared type must agree with the field shape — a
	// hand-edited file that says MemoryAdd but carries SkillPatch fields
	// is corruption, not a rename.
	const actual = actionType(p.fields);
	if (actual !== p.type) {
		throw new ReviewStagingError("corrupt_proposal", `staged proposal ${id} declares ${p.type as string} but its fields parse as ${actual}`);
	}
	return {
		id,
		type: p.type,
		session_id: typeof p.session_id === "string" ? p.session_id : null,
		staged_at: typeof p.staged_at === "string" ? p.staged_at : "",
		fields: p.fields as Record<string, unknown>,
	};
}

export interface PendingList {
	proposals: StagedProposal[];
	corrupt: { id: string; reason: string }[];
}

// The pending/ surface for `bi review pending`. Corrupt files are named,
// never silently omitted (same contract as bais_list's unparseable).
export async function listPending(io: ReviewIO): Promise<PendingList> {
	const ids = await io.listProposalIds();
	const out: PendingList = { proposals: [], corrupt: [] };
	for (const id of ids) {
		try {
			const raw = await io.readProposal(id);
			if (raw == null) throw new ReviewStagingError("not_pending", `proposal ${id} vanished between list and read`);
			out.proposals.push(parseStagedProposal(raw, id));
		} catch (e) {
			if (e instanceof ReviewStagingError) out.corrupt.push({ id, reason: `${e.reason}: ${e.message}` });
			else throw e;
		}
	}
	return out;
}

// THE CONSENT GATE. The only code path in bi that applies a review
// proposal to a store. Sink success is required before the proposal
// leaves pending/: a sink failure propagates and the proposal stays
// staged (named, retryable) — never half-applied, never silently dropped.
export async function approveProposal(id: string, io: ReviewIO): Promise<StagedProposal> {
	const raw = await requirePending(io, id);
	const p = parseStagedProposal(raw, id);
	if (p.type === "NothingToSave") {
		throw new ReviewStagingError("not_appliable", `proposal ${id} is NothingToSave — there is nothing to approve (reject it to clear the queue)`);
	}
	if (p.type === "MemoryAdd") await io.applyMemory(p.fields);
	else if (p.type === "SkillPatch") await io.applySkill(p.fields);
	else await io.applyIssue(p.fields);
	await io.removeProposal(id);
	return p;
}

// Reject drops a staged proposal without touching any sink. Same pending/
// gate as approve — reject is not a backdoor to delete arbitrary files.
export async function rejectProposal(id: string, io: ReviewIO): Promise<StagedProposal> {
	const raw = await requirePending(io, id);
	const p = parseStagedProposal(raw, id);
	await io.removeProposal(id);
	return p;
}
