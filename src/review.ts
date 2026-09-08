// bi/src/review.ts — hunk queue for `bi review` (bi#138).
//
// Code-review mode: the worktree (or ref) diff becomes a navigable queue of
// hunks, file by file, each annotated with provenance (which issue, which
// agent, which handoff). Per hunk the reviewer approves, questions, challenges
// (proof required — a challenge without proof fails loud, never asserts), or
// flags (builds a follow-up spec the host files via `bais new`, linked to the
// provenance issue). READ-ONLY by default: nothing here touches the filesystem,
// git, or .bais — all effects take injected IO so fixtures can prove them.
//
// Reuse, don't duplicate: rendering goes through colorizeDiffLines
// (src/diff-render.ts) at the call site; footprints come from parseFileClaims
// (src/bais.ts); verdict strings reuse the bi#83 `verdict(ID)` shape parsed by
// bais's close-evidence gate. This module is pure (no imports) so the fixture
// suite can drive it without a build.
//
// --skeptic spends a fresh-context reviewer per hunk (bi#59 area). No skeptic
// engine exists, so the flag is gated with the named reason below — never
// silently degraded to a normal review.

export type ReviewProvenance = { issue: string | null; agent: string | null; handoff: string | null };

export type ReviewFileHunk = { header: string; lines: string[] };

export type ReviewFile = { file: string; hunks: ReviewFileHunk[] };

export type ReviewHunk = {
	id: number;
	file: string;
	header: string;
	lines: string[];
	provenance: ReviewProvenance;
};

export type ChangedLine = { file: string; kind: "+" | "-"; text: string };

export class ReviewError extends Error {
	reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.name = "ReviewError";
		this.reason = reason;
	}
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function stripABPrefix(p: string): string {
	if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
	return p;
}

// Parse a unified diff (git diff --no-color output) into per-file hunk lists.
// File boundaries are `diff --git` lines; bare `---`/`+++` pairs without one
// still open a file so minimal fixtures parse. Binary diffs and mode-only
// changes yield a file with zero hunks — never fake hunks.
export function parseUnifiedDiff(text: string): ReviewFile[] {
	const files: ReviewFile[] = [];
	// Holder object, not locals: the open* closures assign the loop state and
	// TS control flow cannot see closure assignments on locals (it narrows
	// them to never). Property reads start from the declared type, so the
	// guards below stay sound.
	const st: { cur: ReviewFile | null; hunk: ReviewFileHunk | null; pendingMinus: string | null } = {
		cur: null,
		hunk: null,
		pendingMinus: null,
	};
	const openFile = (file: string): void => {
		st.cur = { file, hunks: [] };
		files.push(st.cur);
		st.hunk = null;
		st.pendingMinus = null;
	};
	const openHunk = (header: string): void => {
		if (!st.cur) openFile("unknown");
		st.hunk = { header, lines: [] };
		(st.cur as ReviewFile).hunks.push(st.hunk);
	};
	for (const raw of (text ?? "").split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			openFile(m ? stripABPrefix("b/" + m[2]) : "unknown");
			continue;
		}
		if (HUNK_RE.test(line)) {
			openHunk(line);
			continue;
		}
		if (!st.cur) {
			if (line.startsWith("--- ")) st.pendingMinus = line.slice(4).trim();
			else if (line.startsWith("+++ ") && st.pendingMinus !== null) {
				const plus = line.slice(4).trim();
				openFile(plus === "/dev/null" ? stripABPrefix(st.pendingMinus) : stripABPrefix(plus));
				st.pendingMinus = null;
			}
			continue;
		}
		const hunk = st.hunk;
		if (!hunk) continue;
		// Hunk body: context (" "), additions ("+"), removals ("-"), and
		// "\ No newline" markers ride along as context (never changed lines).
		if (
			line.startsWith(" ") ||
			line.startsWith("\\") ||
			line === "" ||
			(line.startsWith("+") && !line.startsWith("+++")) ||
			(line.startsWith("-") && !line.startsWith("---"))
		) {
			hunk.lines.push(line);
		}
	}
	return files;
}

function changedKind(line: string): "+" | "-" | null {
	if (line.startsWith("+") && !line.startsWith("+++")) return "+";
	if (line.startsWith("-") && !line.startsWith("---")) return "-";
	return null;
}

export function changedLinesOfHunk(file: string, hunk: ReviewFileHunk): ChangedLine[] {
	const out: ChangedLine[] = [];
	for (const line of hunk.lines) {
		const kind = changedKind(line);
		if (kind) out.push({ file, kind, text: line });
	}
	return out;
}

export function changedLinesOfFile(file: ReviewFile): ChangedLine[] {
	return file.hunks.flatMap((h) => changedLinesOfHunk(file.file, h));
}

// Flatten files into the review queue: file by file, hunks in diff order,
// ids sequential from 1. Provenance resolves per file through the injected
// resolver (the host feeds Doing-first footprints + --provenance overrides).
export function buildHunkQueue(
	files: ReviewFile[],
	provenanceFor: (file: string) => ReviewProvenance,
): ReviewHunk[] {
	const queue: ReviewHunk[] = [];
	let id = 0;
	for (const f of files) {
		for (const h of f.hunks) {
			queue.push({ id: ++id, file: f.file, header: h.header, lines: [...h.lines], provenance: provenanceFor(f.file) });
		}
	}
	return queue;
}

// Acceptance probe: the queue covers every changed line exactly once — no
// dropped lines, no duplicated lines. Throws ReviewError with a named reason.
export function assertQueueCoversDiffOnce(queue: ReviewHunk[], files: ReviewFile[]): void {
	const key = (c: ChangedLine): string => `${c.file}\0${c.kind}\0${c.text}`;
	const want = new Map<string, number>();
	for (const f of files) for (const c of changedLinesOfFile(f)) want.set(key(c), (want.get(key(c)) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const h of queue) {
		for (const line of h.lines) {
			const kind = changedKind(line);
			if (!kind) continue;
			const k = key({ file: h.file, kind, text: line });
			seen.set(k, (seen.get(k) ?? 0) + 1);
		}
	}
	for (const [k, n] of seen) {
		if (!want.has(k)) throw new ReviewError("queue-coverage-gap", `queue holds a line the diff never changed: ${JSON.stringify(k)}`);
		if (n > (want.get(k) ?? 0)) throw new ReviewError("queue-coverage-duplicate", `queue covers a changed line ${n}x (want 1x): ${JSON.stringify(k)}`);
	}
	for (const [k, n] of want) {
		if ((seen.get(k) ?? 0) < n) throw new ReviewError("queue-coverage-gap", `queue drops a changed line (${n}x in diff, ${(seen.get(k) ?? 0)}x in queue): ${JSON.stringify(k)}`);
	}
}

export type ReviewAction = "approve" | "question" | "challenge" | "flag" | "skip";

export type ReviewDecisionInput = {
	hunk: number | string;
	action: ReviewAction;
	text?: string;
	proof?: string;
	title?: string;
};

export type ReviewDecision = {
	hunk: number;
	file: string;
	action: ReviewAction;
	text: string | null;
	proof: string | null;
	title: string | null;
};

// Resolve a hunk ref: numeric queue id, or "path#k" (k = 1-based hunk index
// within the file). Unknown refs fail loud — never clamp to a neighbor.
export function resolveHunkRef(ref: number | string, queue: ReviewHunk[]): ReviewHunk {
	if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
		const id = Number(ref);
		const h = queue.find((q) => q.id === id);
		if (!h) throw new ReviewError("unknown-hunk", `no hunk #${String(ref)} (queue holds ${queue.length})`);
		return h;
	}
	const m = /^(.*)#(\d+)$/.exec(String(ref));
	if (!m) throw new ReviewError("unknown-hunk", `unparseable hunk ref ${JSON.stringify(String(ref))} (want <id> or <path>#<n>)`);
	const inFile = queue.filter((q) => q.file === m[1]);
	const h = inFile[Number(m[2]) - 1];
	if (!h) throw new ReviewError("unknown-hunk", `no hunk ${JSON.stringify(String(ref))} (${inFile.length} hunk(s) in ${m[1]})`);
	return h;
}

const nonBlank = (s: string | undefined): string | null => (s !== undefined && s.trim() !== "" ? s : null);

// Apply one decision per hunk. A challenge without proof fails loud
// (challenge-needs-proof): the agent must prove via test or red-check, never
// assert. Questions need their text, flags need a title — same loud rule.
export function applyDecisionInputs(queue: ReviewHunk[], inputs: ReviewDecisionInput[]): ReviewDecision[] {
	const byHunk = new Map<number, ReviewDecision>();
	for (const input of inputs) {
		const h = resolveHunkRef(input.hunk, queue);
		if (byHunk.has(h.id)) throw new ReviewError("duplicate-decision", `hunk #${h.id} already has a decision`);
		if (input.action === "challenge" && nonBlank(input.proof) === null) {
			throw new ReviewError("challenge-needs-proof", `hunk #${h.id} challenged without proof — cite a test or red-check ref`);
		}
		if (input.action === "question" && nonBlank(input.text) === null) {
			throw new ReviewError("question-needs-text", `hunk #${h.id} questioned without a question`);
		}
		if (input.action === "flag" && nonBlank(input.title) === null) {
			throw new ReviewError("flag-needs-title", `hunk #${h.id} flagged without a title`);
		}
		byHunk.set(h.id, {
			hunk: h.id,
			file: h.file,
			action: input.action,
			text: nonBlank(input.text),
			proof: nonBlank(input.proof),
			title: nonBlank(input.title),
		});
	}
	return [...byHunk.values()].sort((a, b) => a.hunk - b.hunk);
}

export type FlagSpec = {
	hunk: number;
	file: string;
	title: string;
	body: string;
	linkTo: string | null;
};

// The follow-up a flag files: linked Related to the provenance issue so the
// finding stays attached to the change it was found in. Files: carries the
// footprint for file-ownership batching.
export function flagSpecFor(queue: ReviewHunk[], decision: ReviewDecision): FlagSpec {
	const h = resolveHunkRef(decision.hunk, queue);
	if (decision.action !== "flag" || decision.title === null) {
		throw new ReviewError("flag-needs-title", `hunk #${h.id} has no flaggable decision`);
	}
	const p = h.provenance;
	const body = [
		`Review flag from \`bi review\`: ${decision.title}`,
		``,
		`File: ${h.file}`,
		`Hunk: ${h.header}`,
		...h.lines,
		``,
		`Provenance: issue ${p.issue ?? "unknown"} · agent ${p.agent ?? "unknown"} · handoff ${p.handoff ?? "unknown"}`,
		``,
		`Files: ${h.file}`,
	].join("\n");
	return { hunk: h.id, file: h.file, title: decision.title, body, linkTo: p.issue };
}

export type FlagIssueIO = {
	createIssue: (spec: { title: string; body: string; edges: { kind: string; to: string }[] }) => Promise<{ id: string }>;
};

// File flagged follow-ups through injected IO (the host passes createBaisIssue;
// fixtures pass a recorder). Returns the created ids in spec order.
export async function applyFlagSpecs(specs: FlagSpec[], io: FlagIssueIO): Promise<string[]> {
	const ids: string[] = [];
	for (const s of specs) {
		const created = await io.createIssue({
			title: s.title,
			body: s.body,
			edges: s.linkTo ? [{ kind: "Related", to: s.linkTo }] : [],
		});
		ids.push(created.id);
	}
	return ids;
}

// Approvals record as bi#83 `verdict(ID)` refs — the exact shape bais's
// close-evidence gate resolves. Only approved hunks with a known provenance
// issue yield a ref (deduped, queue order); unattributed approvals stay in
// the decision set with ref null instead of a ref that could never resolve.
export function verdictRefsFor(queue: ReviewHunk[], decisions: ReviewDecision[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const d of decisions) {
		if (d.action !== "approve") continue;
		const h = resolveHunkRef(d.hunk, queue);
		if (!h.provenance.issue || seen.has(h.provenance.issue)) continue;
		seen.add(h.provenance.issue);
		out.push(`verdict(${h.provenance.issue})`);
	}
	return out;
}

export type ReviewVerdictSet = {
	ref: string;
	hunks: { id: number; file: string; header: string; lines: string[]; provenance: ReviewProvenance }[];
	decisions: ReviewDecision[];
	verdicts: string[];
	flags: FlagSpec[];
	untracked: string[];
};

// The --json payload: the full queue plus the verdict set. Flags carry their
// specs so a dry-run review still shows exactly what --apply would file.
// Untracked files ride along so --json states what the queue did NOT cover.
export function reviewToJson(ref: string, queue: ReviewHunk[], decisions: ReviewDecision[], untracked: string[] = []): ReviewVerdictSet {
	return {
		ref,
		hunks: queue.map((h) => ({ id: h.id, file: h.file, header: h.header, lines: [...h.lines], provenance: { ...h.provenance } })),
		decisions: decisions.map((d) => ({ ...d })),
		verdicts: verdictRefsFor(queue, decisions),
		flags: decisions.filter((d) => d.action === "flag").map((d) => flagSpecFor(queue, d)),
		untracked: [...untracked],
	};
}

// Untracked files never appear in `git diff HEAD` — without a loud note they
// would silently skip review while the queue claims full coverage. Parse
// `git status --porcelain` (read-only) and report them; the reviewer opts
// into `git add -N` themselves (it mutates the index, so review never does).
export function parseUntrackedFiles(statusPorcelain: string): string[] {
	const out: string[] = [];
	for (const raw of (statusPorcelain ?? "").split("\n")) {
		const m = /^\?\? (.+)$/.exec(raw.trimEnd());
		if (m) out.push(m[1].replace(/^"|"$/g, ""));
	}
	return out;
}

export type IssueFootprint = { id: string; holder: string | null; files: string[] };

function normalizeClaimPath(p: string): string {
	let s = p.trim().replace(/^\.\//, "");
	if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
	return s;
}

function pathMatches(diffFile: string, claim: string): boolean {
	const d = normalizeClaimPath(diffFile);
	const c = normalizeClaimPath(claim);
	if (!d || !c) return false;
	return d === c || d.endsWith("/" + c) || c.endsWith("/" + d);
}

// Provenance for one diff file: first footprint (caller-ordered, Doing first)
// with a matching Files: claim. Overrides (from --provenance) win outright.
// Unknown stays null — never invented.
export function provenanceForFile(
	file: string,
	footprints: IssueFootprint[],
	overrides?: Record<string, Partial<ReviewProvenance>>,
): ReviewProvenance {
	if (overrides) {
		for (const [k, v] of Object.entries(overrides)) {
			if (pathMatches(file, k)) {
				return { issue: v.issue ?? null, agent: v.agent ?? null, handoff: v.handoff ?? null };
			}
		}
	}
	for (const f of footprints) {
		if (f.files.some((c) => pathMatches(file, c))) {
			return { issue: f.id, agent: f.holder, handoff: null };
		}
	}
	return { issue: null, agent: null, handoff: null };
}

// argv for the read-only diff source. Default is the worktree (staged +
// unstaged vs HEAD); a single ref diffs the worktree against it; a
// from..to (or from...to) range diffs the two endpoints. Never mutates.
export function gitDiffArgs(ref: string | null): string[] {
	if (!ref) return ["diff", "--no-color", "HEAD", "--"];
	const m = /^(.*?)(\.\.\.?)(.+)$/.exec(ref);
	if (m) return ["diff", "--no-color", m[1] === "" ? "HEAD" : m[1], m[3], "--"];
	return ["diff", "--no-color", ref, "--"];
}

export const SKEPTIC_UNIMPLEMENTED = "unimplemented-skeptic-engine";

// --skeptic gates loud: a fresh-context reviewer per hunk is bi#59 area and
// no skeptic engine exists. Spending reviewer context silently is worse than
// refusing — the flag stays until the engine lands.
export function assertSkepticReady(wantSkeptic: boolean): void {
	if (wantSkeptic) {
		throw new ReviewError(
			SKEPTIC_UNIMPLEMENTED,
			"bi review --skeptic is not implemented (unimplemented-skeptic-engine — fresh-context reviewers per hunk are bi#59 area; no skeptic engine exists yet)",
		);
	}
}

export function hunkLabel(h: ReviewHunk, total: number): string {
	return `hunk ${h.id}/${total} — ${h.file} ${h.header}`;
}
