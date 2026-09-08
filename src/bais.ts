// bi/src/bais.ts — TS-level BAIS interop (BAML deps not yet live in 0.17.0).
// bais is the single source of truth for Issue/Edge types (defined in
// bais/baml_src/main.baml). Until `baml.toml [dependencies]` lands
// (Phase-B, single-workspace invariant), bi consumes BAIS via the TS host:
// it reads .bais/issues/*.toml and validates them through bais's BAML parser
// (bais/src/toml.ts → bais/baml_src/ns_toml/toml.baml), which keeps BAML
// as the validator even without a BAML-level import.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { format_issue_index_async, format_skill_index_async } from "../baml_sdk/index.js";

export type BaisIssue = {
	id: string;
	title: string;
	status: string;
	kind: string;
	area: string | null;
	severity: number | null;
	source: string | null;
	body: string;
};

export type BaisEdge = { from: string; to: string; kind: string };
// File-envelope claim mirror (bais/src/graph.ts): holder + RFC3339 UTC
// lease, null when unclaimed. BAML serialize round-trips them untouched.
export type BaisFile = { issue: BaisIssue; edges: BaisEdge[]; holder: string | null; lease: string | null };

// Resolve the BAIS issues directory. Prefer the nearest .bais/issues.
// Root .bais/ is the ecosystem hub (goal.toml lives there); per-dir hubs
// resolve first when present, otherwise fall through to the root.
// (cwd → bais project → repo dot). Mirrors `rg` file-per-issue layout.
// For bi, primary is bi/.bais/issues — handle both `cwd==bi` and `cwd==orion-learn-baml`.
function resolveIssuesDir(from: string = process.cwd()): string | null {
	const candidates = [
		join(from, ".bais", "issues"), // cwd is bi/
		join(from, "bi", ".bais", "issues"), // cwd is orion-learn-baml/
		join(from, "bais", ".bais", "issues"),
		resolve(from, "../bais/.bais/issues"),
		join(resolve(from, ".."), ".bais", "issues"),
		resolve(from, "../bais"),
		join(from, ".bais"),
		join(from, "bi", ".bais", "issues"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
		const alt = join(c, "bais", ".bais", "issues");
		if (existsSync(alt)) return alt;
	}
	const sibling = resolve(from, "../bais/.bais/issues");
	if (existsSync(sibling)) return sibling;
	const here = join(from, "bais", ".bais", "issues");
	if (existsSync(here)) return here;
	return null;
}

// Validate a raw .toml string through bais's BAML parser (the ground truth).
// We dynamically import bais's TS wrapper so bi doesn't need a compile-time
// dependency on bais's baml_sdk — hidden behind eval to avoid tsc's
// rootDir check (bais/baml_sdk lives outside bi). BAML remains validator.
// Resolution must work both from bi/src (dev, ts-node) and bi/dist/src (compiled).
// Resolve bais's TS wrapper once and memoise it. Hidden behind eval so tsc's
// rootDir check does not follow it — bais/baml_sdk lives outside this project.
// Resolution must work from src (dev, ts-node) and dist/src (compiled).
function baisDistCandidates(file: string): string[] {
	return [
		// compiled: bi/dist/src/bais.js -> orion-learn-baml/bais/dist/src/<file>
		join(resolve(process.cwd(), "../bais"), "dist", "src", file),
		join(resolve(process.cwd(), "../../bais"), "dist", "src", file),
		// dev: bi/src/bais.ts -> ../bais/src/<file>
		resolve(join(resolve(process.cwd(), "bais"), "dist", "src", file)),
		resolve(join(resolve(process.cwd(), "..", "bais"), "dist", "src", file)),
	];
}

async function loadBaisDistModule(file: string, probe: (m: any) => boolean, label: string): Promise<any> {
	const { pathToFileURL } = await import("node:url");
	const candidates = baisDistCandidates(file);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const mod = await (Function("u", "return import(u)") as any)(pathToFileURL(p).href);
			if (probe(mod)) return mod;
		} catch {}
	}
	// last resort: relative spec hidden from tsc (may work in some layouts)
	try {
		const mod = await (Function("s", "return import(s)") as any)(`../../../bais/dist/src/${file}`);
		if (probe(mod)) return mod;
	} catch {}
	throw new Error(`${label} not found — tried ${candidates.join(", ")}`);
}

let baisTomlModule: Promise<any> | null = null;
function loadBaisTomlModule(): Promise<any> {
	if (baisTomlModule) return baisTomlModule;
	baisTomlModule = (async () => {
		try {
			return await loadBaisDistModule("toml.js", (m) => !!m?.parseBaisFile, "BAIS parser");
		} catch (e) {
			baisTomlModule = null; // let a later call retry once bais is built
			throw e;
		}
	})();
	return baisTomlModule;
}

// bi#84 follow-through: bi consumes the bais close-evidence gate instead
// of reimplementing it — same file:// dist interop as the TOML parser.
// checkBaisIssues already requires a built bais dist (parsing goes through
// it), so delegation adds no new requirement.
let baisGraphModule: Promise<any> | null = null;
function loadBaisGraphModule(): Promise<any> {
	if (baisGraphModule) return baisGraphModule;
	baisGraphModule = (async () => {
		try {
			return await loadBaisDistModule("graph.js", (m) => typeof m?.closeEvidenceIn === "function", "BAIS graph module (closeEvidenceIn)");
		} catch (e) {
			baisGraphModule = null;
			throw e;
		}
	})();
	return baisGraphModule;
}

// Validate a raw .toml string through bais's BAML parser (the ground truth).
// The resolver's catch-and-continue above deliberately stops at module load:
// once we have a module, a throw from parseBaisFile is a real parse error about
// the caller's file and must propagate verbatim. Folding it into the loop meant
// every malformed issue was reported as "BAIS parser not found", which is both
// wrong and unactionable.
async function validateViaBaisBaml(text: string): Promise<BaisFile> {
	const mod = await loadBaisTomlModule();
	return (await mod.parseBaisFile(text)) as BaisFile;
}

function issuesDirOrDefault(dir?: string): string {
	return dir ?? resolveIssuesDir() ?? resolve(process.cwd(), "../bais/.bais/issues");
}

// A file under .bais/issues that the BAML parser rejected. Kept as its own
// shape rather than being coerced into a BaisIssue: a file we could not parse
// has no trustworthy id, status or edges, and anything we invent for those
// fields is a lie the rest of the graph will act on.
export type BaisLoadFailure = { file: string; error: string };
export type BaisLoad = { issues: BaisFile[]; failures: BaisLoadFailure[] };

// The single loader for a .bais/issues directory — every other read path is
// expressed in terms of this one, so "what counts as a valid issue" is decided
// in exactly one place.
//
// Parse failures are returned, never swallowed and never faked. The previous
// behaviour synthesised `{status: "Open", kind: "Proposal", body: <raw text>}`
// from an unparseable file, which meant a corrupt or half-written .toml showed
// up as ready work: readyBaisIssues would hand it to an agent, and any edges it
// declared were dropped, so it could also unblock issues it was meant to block.
export async function loadBaisIssues(dir?: string): Promise<BaisLoad> {
	const issuesDir = issuesDirOrDefault(dir);
	if (!existsSync(issuesDir)) return { issues: [], failures: [] };
	const files = readdirSync(issuesDir).filter((f) => f.endsWith(".toml"));
	const issues: BaisFile[] = [];
	const failures: BaisLoadFailure[] = [];
	for (const f of files) {
		try {
			const text = readFileSync(join(issuesDir, f), "utf8");
			issues.push(await validateViaBaisBaml(text));
		} catch (e: any) {
			failures.push({ file: f, error: String(e?.message ?? e) });
		}
	}
	return { issues, failures };
}

// Valid issues only. Callers that need to know about unparseable files (the CLI
// and the bais_check/bais_list tools) use loadBaisIssues directly — a silent
// short list is better than a fabricated issue, but it is still worth surfacing.
export async function listBaisIssues(dir?: string): Promise<BaisFile[]> {
	return (await loadBaisIssues(dir)).issues;
}

// Mirror of BAML `blast_radii` (bi#122) — same mirror rationale as
// filterReadyIssues above (proposals/05: enums nested in class fields do
// not survive the FFI boundary, so BAML owns the definition proved by
// `baml test` and this mirrors it — keep the two in step). Per issue, the
// transitive dependents through DependsOn/Blocks, split into open_downstream
// (work actually held) and total_downstream (every declared dependent).
export type BlastRadius = { id: string; open_downstream: number; total_downstream: number };

// Mirrors of BAML parse_file_claims / dispatch_pack (bi#123) — same rationale.
// `Files:` body lines declare the footprint; dispatchPack is the dry-run pack
// (ready + unleased, greedy by radius, no file clashes). Never mutates.
export type FileClaim = { issue_id: string; files: string[] };
export type AgentSlot = { slot: number; issue_id: string };

export function parseFileClaims(body: string): string[] {
	const out: string[] = [];
	for (const line of (body ?? "").split("\n")) {
		const t = line.trim();
		if (!t.startsWith("Files:")) continue;
		let rest = t.slice("Files:".length).trim();
		const hash = rest.indexOf("#");
		if (hash !== -1) rest = rest.slice(0, hash).trim();
		for (const part of rest.split(" ")) {
			const p = part.trim();
			if (p !== "" && !out.includes(p)) out.push(p);
		}
	}
	return out;
}

export function blastRadii(all: BaisFile[]): BlastRadius[] {
	const edges = all.flatMap((f) => f.edges);
	const statusById = new Map(all.map((f) => [f.issue.id, f.issue.status]));
	const directDependents = (id: string): string[] => {
		const out: string[] = [];
		for (const e of edges) {
			if ((e.kind === "DependsOn" || e.kind === "Blocks") && e.to === id && !out.includes(e.from)) {
				out.push(e.from);
			}
		}
		return out;
	};
	return all.map((f) => {
		const seen: string[] = [];
		let frontier = directDependents(f.issue.id);
		while (frontier.length > 0) {
			const next: string[] = [];
			for (const id of frontier) {
				if (seen.includes(id)) continue;
				seen.push(id);
				for (const d of directDependents(id)) {
					if (!seen.includes(d)) next.push(d);
				}
			}
			frontier = next;
		}
		let open = 0;
		let total = 0;
		for (const id of seen) {
			if (id === f.issue.id) continue;
			total += 1;
			if (statusById.get(id) === "Open") open += 1;
		}
		return { id: f.issue.id, open_downstream: open, total_downstream: total };
	});
}

// hub#175: unknown footprints (no `Files:` line — a bare `Files:` still
// counts as declared) are mutually exclusive in a swipe pack. Mirror of the
// bais/src/graph.ts exclusion, which mirrors the scripts-lane
// splitUnknownPack in bais/scripts/briefs.mjs: the greedy pick fills the
// budget, then the first unknown in slot order keeps its slot and the rest
// are withheld, renumbered dense. Keep the two dispatchPack copies in sync.
export function isDeclaredFootprint(body: string): boolean {
	return (body ?? "").split("\n").some((l) => l.trim().startsWith("Files:"));
}

// hub#175 warning lines — verbatim mirrors of warnUnknownWithheld /
// warnUnknownShared in bais/scripts/briefs.mjs (see bais/src/graph.ts).
export function warnUnknownWithheld(ids: string[]): string {
	const list = [...ids].map(String);
	const noun = list.length === 1 ? "footprint" : "footprints";
	return `[bais] unknown ${noun} withheld from swipe pack: ${list.join(", ")} (no Files: line proves no clash-freedom — at most one unknown per pack; declare Files: first per bi#125)`;
}

export function warnUnknownShared(unknownId: string, declaredIds: string[]): string {
	return `[bais] unknown footprint ${unknownId} shares a swipe pack with declared ${[...declaredIds].map(String).join(", ")} (no Files: — confirm scope with the operator before writing)`;
}

export function dispatchPack(all: BaisFile[], leased: string[], footprints: Map<string, string[]>, budget: number): AgentSlot[] {
	const slots: AgentSlot[] = [];
	if (budget <= 0) return slots;
	const radii = new Map(blastRadii(all).map((r) => [r.id, r]));
	const ready = filterReadyIssues(all);
	const bodies = new Map(all.map((f) => [f.issue.id, f.issue.body ?? ""]));
	const filesFor = (id: string): string[] => footprints.get(id) ?? [];
	const clash = (a: string[], b: string[]): boolean => a.some((x) => b.includes(x));
	const packed: string[] = [];
	const packedFiles: string[] = [];
	while (slots.length < budget) {
		let bestId = "";
		let bestOpen = -1;
		for (const c of ready) {
			if (packed.includes(c.issue.id) || leased.includes(c.issue.id)) continue;
			const open = radii.get(c.issue.id)?.open_downstream ?? 0;
			if (clash(filesFor(c.issue.id), packedFiles)) continue;
			if (open > bestOpen || (open === bestOpen && (bestId === "" || c.issue.id < bestId))) {
				bestId = c.issue.id;
				bestOpen = open;
			}
		}
		if (bestId === "") break;
		packed.push(bestId);
		for (const f of filesFor(bestId)) {
			if (!packedFiles.includes(f)) packedFiles.push(f);
		}
		slots.push({ slot: slots.length, issue_id: bestId });
	}
	const kept: AgentSlot[] = [];
	let seenUnknown = false;
	for (const s of slots) {
		if (!isDeclaredFootprint(bodies.get(s.issue_id) ?? "")) {
			if (seenUnknown) continue;
			seenUnknown = true;
		}
		kept.push({ slot: kept.length, issue_id: s.issue_id });
	}
	return kept;
}

// Mirror of BAML `ready_issues` / `is_blocked` (bais/baml_src/main.baml).
//
// Deliberately a hand-mirror rather than a delegation: calling bais's BAML
// `ready_issues` across FFI returns silently wrong results today. An enum nested
// in a class field (Issue.status, Edge.kind) is encoded as a bare string on the
// inbound path, so inside the VM every `==` against an enum literal evaluates
// false and every `!=` true — `ready_issues` comes back empty and `is_blocked`
// always false, with no error raised. proposals/05 covers the direct-parameter
// form of the same encode gap (which at least panics). Until that is fixed BAML
// owns the *definition*, proved by `baml test`, and this mirrors it — keep the
// two in step.
//
// Ready = Open, and no Blocks edge points at it from an issue that is neither
// Done nor Dropped. A Blocks edge naming an id we cannot see (cross-project
// edge, typo, directory not loaded) is unresolvable and blocks: we cannot prove
// the blocker is closed, so we do not hand the node out as work. The previous
// behaviour skipped such edges, which silently turned a dangling blocker into a
// ready issue. A typo'd edge therefore parks until fixed — `bais check` reports
// it as Missing so the park is loud, not silent.
export function filterReadyIssues(all: BaisFile[]): BaisFile[] {
	const issues = all.map((f) => f.issue);
	const edges = all.flatMap((f) => f.edges);
	const byId = new Map(issues.map((i) => [i.id, i]));
	const blocked = new Set<string>();
	for (const e of edges) {
		if (e.kind !== "Blocks") continue;
		const blocker = byId.get(e.from);
		if (!blocker || (blocker.status !== "Done" && blocker.status !== "Dropped")) {
			blocked.add(e.to);
		}
	}
	// RED-CHECK TARGET (bi#57): the `!isEpic(...)` conjunct below (hub#225,
	// mirrors bais/src/graph.ts readyIssues). Neutering it re-seats epics.
	return all.filter((f) => f.issue.status === "Open" && !blocked.has(f.issue.id) && !isEpic(f.issue.id, edges));
}

// Mirror of BAML is_epic / epic_children (hub#223 epic policy, mirrors
// bais/src/graph.ts): an issue is an epic iff at least one SubtaskOf edge
// points at it — the edge runs from the subtask (child) to the epic
// (parent). Derived, never stored. Same hand-mirror contract as
// filterReadyIssues above — keep the two in step.
export function isEpic(issueId: string, edges: BaisEdge[]): boolean {
	return edges.some((e) => e.to === issueId && e.kind === "SubtaskOf");
}
export function epicChildren(epicId: string, edges: BaisEdge[]): string[] {
	return edges.filter((e) => e.to === epicId && e.kind === "SubtaskOf").map((e) => e.from);
}

// Mirror of bais/src/graph.ts epicWithheldIn (hub#225): every Open +
// unblocked + unleased epic is withheld from the pack with a named reason.
// Blocked/leased epics are out for those reasons, never double-counted.
export type EpicHold = { issue_id: string; children: string[]; reason: "epic" };
export function epicWithheldIn(all: BaisFile[], leased: string[] = []): EpicHold[] {
	const byId = new Map(all.map((f) => [f.issue.id, f.issue]));
	const edges = all.flatMap((f) => f.edges);
	const blocked = new Set<string>();
	for (const f of all) {
		for (const e of f.edges) {
			if (e.kind !== "Blocks") continue;
			const blocker = byId.get(e.from);
			if (!blocker || (blocker.status !== "Done" && blocker.status !== "Dropped")) {
				blocked.add(e.to);
			}
		}
	}
	return all
		.filter(
			(f) =>
				f.issue.status === "Open" &&
				!blocked.has(f.issue.id) &&
				!leased.includes(f.issue.id) &&
				isEpic(f.issue.id, edges),
		)
		.map((f) => ({ issue_id: f.issue.id, children: epicChildren(f.issue.id, edges), reason: "epic" as const }));
}

export function warnEpicWithheld(ids: string[]): string {
	const list = [...ids].map(String);
	const noun = list.length === 1 ? "epic" : "epics";
	return `[bais] ${noun} withheld from swipe pack: ${list.join(", ")} (coordinates subtasks from outside the pack — claim a child instead per hub#223)`;
}

// bais/dist/src/store.js, resolved the same way as the TOML wrapper above:
// dynamic import hidden from tsc, memoised, retryable when bais is built
// later. The store is what makes ready lease-aware (hub claims land there).
let baisStoreModule: Promise<any> | null = null;
function loadBaisStoreModule(): Promise<any> {
	if (baisStoreModule) return baisStoreModule;
	baisStoreModule = (async () => {
		const { pathToFileURL } = await import("node:url");
		const candidates = [
			join(resolve(process.cwd(), "../bais"), "dist", "src", "store.js"),
			join(resolve(process.cwd(), "../../bais"), "dist", "src", "store.js"),
			resolve(join(resolve(process.cwd(), "bais"), "dist", "src", "store.js")),
			resolve(join(resolve(process.cwd(), "..", "bais"), "dist", "src", "store.js")),
		];
		for (const p of candidates) {
			if (!existsSync(p)) continue;
			try {
				const mod = await (Function("u", "return import(u)") as any)(pathToFileURL(p).href);
				if (mod?.storeReady) return mod;
			} catch {}
		}
		baisStoreModule = null; // let a later call retry once bais is built
		throw new Error(`BAIS store not found — tried ${candidates.join(", ")}`);
	})();
	return baisStoreModule;
}

function storeDbFor(issuesDir: string): string | null {
	const p = join(resolve(issuesDir, ".."), "store.db");
	return existsSync(p) ? p : null;
}

// Where ready reads from: the SQLite projection when one exists and bais
// is built, else the TOML scan. Exported so the CLI can say which —
// "empty" and "not synced" must stay distinguishable.
export async function baisReadSource(dir?: string): Promise<"store" | "scan"> {
	const issuesDir = issuesDirOrDefault(dir);
	if (!storeDbFor(issuesDir)) return "scan";
	try {
		await loadBaisStoreModule();
		return "store";
	} catch {
		return "scan";
	}
}

// True when any issue file is newer than the store build: the store is a
// cache and TOML is truth until per-actor logs land (Phase 4), so a stale
// store falls back to the scan rather than serve a silently short list.
function scanNewerThan(issuesDir: string, wallTs: string): boolean {
	const wall = Date.parse(wallTs);
	if (!Number.isFinite(wall)) return true;
	let files: string[] = [];
	try {
		files = readdirSync(issuesDir).filter((f) => f.endsWith(".toml"));
	} catch {
		return true;
	}
	for (const f of files) {
		try {
			if (statSync(join(issuesDir, f)).mtimeMs > wall) return true;
		} catch {}
	}
	return false;
}

// Projection-first ready: the store rule already excludes live leases and
// unclosed blockers, so its id set IS the answer; joining the scanned files
// keeps edges (bais_ready serializes whole BaisFiles) and drops files the
// parser rejects. No store, no built bais, unreadable store, or a store
// older than the scan → the hand-mirror over the TOML files.
export async function readyBaisIssues(dir?: string): Promise<BaisFile[]> {
	const scan = async (): Promise<BaisFile[]> => filterReadyIssues(await listBaisIssues(dir));
	const issuesDir = issuesDirOrDefault(dir);
	if (!storeDbFor(issuesDir)) return scan();
	let mod: any;
	try {
		mod = await loadBaisStoreModule();
	} catch {
		return scan();
	}
	let store: { ready: { entity: string }[]; as_of: { wall_ts: string } };
	try {
		store = mod.storeReady(issuesDir);
	} catch {
		return scan();
	}
	if (scanNewerThan(issuesDir, store.as_of.wall_ts)) return scan();
	const ids = new Set(store.ready.map((t) => t.entity));
	const { issues } = await loadBaisIssues(issuesDir);
	return issues.filter((f) => ids.has(f.issue.id));
}

function nextBaisId(dir: string, prefix = "bi"): string {
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".toml")) : [];
	let max = 0;
	for (const f of files) {
		const m = f.match(/^.*#(\d+)\.toml$/);
		if (m) max = Math.max(max, parseInt(m[1], 10));
		const m2 = f.match(/^.*#([A-Za-z0-9]+)\.toml$/);
		if (m2 && !m) {
			// hash ids — ignore for sequential
		}
	}
	const n = String(max + 1).padStart(2, "0");
	return `${prefix}#${n}`;
}

// Same rule as validateViaBaisBaml: a throw from serializeBaisFile is a real
// error about `file` and propagates. The hand-rolled fallback below is only for
// the case where bais itself is not built.
async function serializeViaBaisBaml(file: BaisFile): Promise<string> {
	try {
		const mod = await loadBaisTomlModule();
		if (mod?.serializeBaisFile) return (await mod.serializeBaisFile(file)) as string;
	} catch (e: any) {
		if (!String(e?.message ?? e).startsWith("BAIS parser not found")) throw e;
	}
	// fallback: minimal TOML (still valid per BAIS.md, but BAML is preferred)
	const i = file.issue;
	let out = `id = "${i.id}"\ntitle = "${i.title.replace(/"/g, '\\"')}"\nstatus = "${i.status}"\nkind = "${i.kind}"\n`;
	if (i.area) out += `area = "${i.area}"\n`;
	if (i.severity != null) out += `severity = ${i.severity}\n`;
	if (i.source) out += `source = "${i.source}"\n`;
	out += `body = """\n${i.body}\n"""\n`;
	for (const e of file.edges) out += `\n[[edge]]\nfrom = "${e.from}"\nto = "${e.to}"\nkind = "${e.kind}"\n`;
	return out;
}

export const BAIS_EDGE_KINDS = ["Blocks", "DependsOn", "SubtaskOf", "DuplicateOf", "Related", "Fixes", "Replaces"];

function assertEdgeKind(kind: string): void {
	if (!BAIS_EDGE_KINDS.includes(kind)) throw new Error(`unknown edge kind ${JSON.stringify(kind)} — one of ${BAIS_EDGE_KINDS.join(", ")}`);
}

// Precedence adjacency mirrors precedesEdge (only Blocks/DependsOn order
// work): BFS from `b` to `a`, returning [b, …, a], or null when no path.
// The link refusal below reports the full closed cycle from this path.
function precedencePath(edges: BaisEdge[], a: string, b: string): string[] | null {
	const next = (id: string): string[] => {
		const out: string[] = [];
		for (const e of edges) {
			if (e.kind === "Blocks" && e.from === id) out.push(e.to);
			else if (e.kind === "DependsOn" && e.to === id) out.push(e.from);
		}
		return out;
	};
	const prev = new Map<string, string>();
	const seen = new Set([b]);
	const q = [b];
	while (q.length) {
		const cur = q.shift()!;
		if (cur === a) {
			const path = [cur];
			let n = cur;
			while (n !== b) {
				n = prev.get(n)!;
				path.unshift(n);
			}
			return path;
		}
		for (const id of next(cur)) {
			if (!seen.has(id)) {
				seen.add(id);
				prev.set(id, cur);
				q.push(id);
			}
		}
	}
	return null;
}

export async function createBaisIssue(opts: {
	title: string;
	kind?: string;
	area?: string;
	body?: string;
	status?: string;
	dir?: string;
	edges?: { kind: string; to: string }[];
}): Promise<BaisFile> {
	const dir = opts.dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi", ".bais", "issues");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// ensure dir exists even when cwd is repo root vs bi
	const issuesDir = existsSync(dir) ? dir : join(process.cwd(), "bi/.bais/issues");
	if (!existsSync(issuesDir)) mkdirSync(issuesDir, { recursive: true });
	const targetDir = existsSync(dir) ? dir : issuesDir;
	// New ids carry the owning project's scope (bi#11 in bi, tt#01 in tt) —
	// a hardcoded "bi" prefix would mis-scope every other project's issues.
	const id = nextBaisId(targetDir, baisProjectName(targetDir));
	// bi#111: edges declared at birth. Ends must already exist (Missing
	// fails loudly per bais check §4.3); a fresh node has no inbound, so
	// birth edges cannot close a cycle — kind + existence is the check.
	const birthEdges: BaisEdge[] = [];
	for (const e of opts.edges ?? []) {
		assertEdgeKind(e.kind);
		if (e.to === id) throw new Error(`cannot link ${id} to itself`);
		if (!existsSync(join(targetDir, `${e.to}.toml`))) throw new Error(`unknown issue ${JSON.stringify(e.to)} — link ends must exist (bais check §4.3 Missing fails loudly)`);
		if (birthEdges.some((b) => b.to === e.to && b.kind === e.kind)) throw new Error(`${id} ${e.kind} ${e.to} is already linked`);
		birthEdges.push({ from: id, to: e.to, kind: e.kind });
	}
	const file: BaisFile = {
		issue: {
			id,
			title: opts.title,
			status: opts.status ?? "Open",
			kind: opts.kind ?? "Feat",
			area: opts.area ?? null,
			severity: null,
			source: null,
			body: opts.body ?? `Seeded via \`bi bais new\` for ${id}.`,
		},
		edges: birthEdges,
		holder: null,
		lease: null,
	};
	// BAML is validator — serialize via BAML, then re-validate
	const toml = await serializeViaBaisBaml(file);
	await validateViaBaisBaml(toml);
	const fp = join(targetDir, `${id}.toml`);
	writeFileSync(fp, toml);
	return file;
}

export interface BaisClaim {
	as: string;
	forMs?: number;
	nowMs?: number;
	scopeConfirmed?: boolean;
}

// Claim mirrors (bais/src/cli.ts): duration grammar, millis-stripped
// UTC lease, expiry comparison where unparseable reads as expired.
export function parseClaimDuration(s: string): number | null {
	const m = /^(\d+)(s|m|h|d)$/.exec(s);
	if (!m) return null;
	const mult = m[2] === "s" ? 1000 : m[2] === "m" ? 60000 : m[2] === "h" ? 3600000 : 86400000;
	return Number(m[1]) * mult;
}
export function toLeaseIso(at: number): string {
	return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function leaseExpiredMs(lease: string | null, at: number): boolean {
	if (lease == null) return true;
	const t = Date.parse(lease);
	if (Number.isNaN(t)) return true;
	return t <= at;
}
const DEFAULT_CLAIM_MS = 4 * 3600000;

export async function moveBaisIssue(id: string, status: string, dir?: string, claim?: BaisClaim): Promise<BaisFile> {
	const issuesDir = dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi/.bais/issues");
	if (!existsSync(issuesDir)) throw new Error(`No .bais/issues at ${issuesDir}`);
	const fp = join(issuesDir, `${id}.toml`);
	if (!existsSync(fp)) throw new Error(`No issue ${id} at ${fp}`);
	const text = readFileSync(fp, "utf8");
	const file = await validateViaBaisBaml(text);
	const from = file.issue.status;
	file.issue.status = status;
	if (status === "Doing") {
		if (claim?.as == null) {
			// Anonymous claim: allowed (bi#49 bare-move contract), but
			// instantly stale — reap reclaims on sight. Pass as for live.
			file.holder = null;
			file.lease = null;
		} else {
			// Epic/scope gate (epic policy, mirrors bais/src/cli.ts): a
			// live claim needs a workable scope. Epics coordinate
			// subtasks — claim a child instead; unknown footprints cannot
			// prove clash-freedom — declare Files: first. claim.
			// scopeConfirmed is the operator override. Graph helpers come
			// from bais/dist over the file:// interop; an older dist
			// without them skips the gate rather than bricking claims.
			if (!claim.scopeConfirmed) {
				try {
					const g = await loadBaisGraphModule();
					if (typeof g?.isEpic === "function" && typeof g?.epicChildren === "function" && typeof g?.isDeclaredFootprint === "function") {
						const { issues } = await loadBaisIssues(issuesDir);
						const allEdges = issues.flatMap((f) => f.edges);
						const kids = g.epicChildren(id, allEdges) as string[];
						if (kids.length > 0) throw new Error(`${id} is an epic (subtasks: ${kids.join(", ")}) — claim a child, or re-run with --scope-confirmed for a verification close`);
						const me = issues.find((f) => f.issue.id === id);
						if (!g.isDeclaredFootprint(me?.issue.body ?? text)) throw new Error(`${id} declares no footprint (no Files: line) — declare Files: first (bi#125), or re-run with --scope-confirmed`);
					}
				} catch (e) {
					if (e instanceof Error && /epic|footprint/.test(e.message)) throw e;
					// Interop miss (no dist, old dist): gate degrades open.
				}
			}
			file.holder = claim.as;
			file.lease = toLeaseIso((claim.nowMs ?? Date.now()) + (claim.forMs ?? DEFAULT_CLAIM_MS));
		}
	} else if (from === "Doing") {
		file.holder = null;
		file.lease = null;
	}
	const toml = await serializeViaBaisBaml(file);
	await validateViaBaisBaml(toml);
	writeFileSync(fp, toml);
	return file;
}

// bi#111: link issues without hand-editing TOML. Edges live in the FROM
// file only (same convention as hand-written [[edge]] tables); BAML
// serializes + re-validates, so a malformed link never reaches disk.
// Write-time validation: known kind, existing ends (Missing fails loudly
// per bais check §4.3), no self-links, no exact duplicates, and no new
// Blocks/DependsOn cycle (refused with the cycle path).
export async function linkBaisIssues(from: string, kind: string, to: string, dir?: string): Promise<BaisFile> {
	assertEdgeKind(kind);
	if (from === to) throw new Error(`cannot link ${from} to itself`);
	const issuesDir = dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi/.bais/issues");
	if (!existsSync(issuesDir)) throw new Error(`No .bais/issues at ${issuesDir}`);
	const { issues } = await loadBaisIssues(issuesDir);
	const byId = new Map(issues.map((f) => [f.issue.id, f]));
	const fromFile = byId.get(from);
	if (!fromFile) throw new Error(`unknown issue ${JSON.stringify(from)} — link ends must exist (bais check §4.3 Missing fails loudly)`);
	if (!byId.get(to)) throw new Error(`unknown issue ${JSON.stringify(to)} — link ends must exist (bais check §4.3 Missing fails loudly)`);
	if (fromFile.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) throw new Error(`${from} ${kind} ${to} is already linked`);
	const all = issues.flatMap((f) => f.edges);
	// The new edge (from -kind-> to) closes a cycle iff precedence already
	// flows back: Blocks from→to needs a to⇝from path, DependsOn to→from
	// needs a from⇝to path. Other kinds never order (precedesEdge), so
	// only Blocks/DependsOn can close one.
	const back = kind === "Blocks" ? precedencePath(all, from, to) : kind === "DependsOn" ? precedencePath(all, to, from) : null;
	if (back) {
		// back already runs back-to-front ([to, …, from] for Blocks),
		// so prepending the new edge's start closes the loop exactly.
		const cycle = kind === "Blocks" ? [from, ...back] : [to, ...back];
		throw new Error(`linking ${from} ${kind} ${to} would close a cycle: ${cycle.join(" -> ")}`);
	}
	fromFile.edges.push({ from, to, kind });
	const toml = await serializeViaBaisBaml(fromFile);
	await validateViaBaisBaml(toml);
	writeFileSync(join(issuesDir, `${from}.toml`), toml);
	return fromFile;
}

// Heartbeat: only the recorded holder extends a live Doing claim.
export async function renewBaisClaim(id: string, holder: string, forMs = DEFAULT_CLAIM_MS, nowMs = Date.now(), dir?: string): Promise<BaisFile> {
	const issuesDir = dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi/.bais/issues");
	const fp = join(issuesDir, `${id}.toml`);
	if (!existsSync(fp)) throw new Error(`No issue ${id} at ${fp}`);
	const file = await validateViaBaisBaml(readFileSync(fp, "utf8"));
	if (file.issue.status !== "Doing") throw new Error(`${id} is ${file.issue.status}, not Doing (nothing to renew)`);
	if (file.holder !== holder) throw new Error(`${id} held by ${JSON.stringify(file.holder)}, not ${JSON.stringify(holder)} (strangers cannot renew)`);
	file.lease = toLeaseIso(nowMs + forMs);
	const toml = await serializeViaBaisBaml(file);
	await validateViaBaisBaml(toml);
	writeFileSync(fp, toml);
	return file;
}

// Reclamation: every Doing with an expired (or missing) lease flips to
// Open with the claim cleared. Pure function of (files, now).
export async function reapBaisClaims(nowMs = Date.now(), dir?: string): Promise<{ id: string; holder: string | null; lease: string | null }[]> {
	const issuesDir = dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi/.bais/issues");
	if (!existsSync(issuesDir)) throw new Error(`No .bais/issues at ${issuesDir}`);
	const reaped: { id: string; holder: string | null; lease: string | null }[] = [];
	for (const f of readdirSync(issuesDir).filter((x) => x.endsWith(".toml")).sort()) {
		const fp = join(issuesDir, f);
		const file = await validateViaBaisBaml(readFileSync(fp, "utf8"));
		if (file.issue.status !== "Doing" || !leaseExpiredMs(file.lease, nowMs)) continue;
		const rec = { id: file.issue.id, holder: file.holder, lease: file.lease };
		file.issue.status = "Open";
		file.holder = null;
		file.lease = null;
		const toml = await serializeViaBaisBaml(file);
		await validateViaBaisBaml(toml);
		writeFileSync(fp, toml);
		reaped.push(rec);
	}
	return reaped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Directory scope of an id: "bi#04" -> "bi". An id with no "#" has no scope.
// Mirror of BAML id_project.
function idProject(id: string): string {
	const i = id.indexOf("#");
	return i === -1 ? "" : id.slice(0, i);
}

// The project that owns a .bais directory, from .bais/config.toml
// (`project = "bi"`), falling back to the directory containing .bais — the
// layout every project here uses. Only this one key is read, so a regex is
// enough; routing config.toml through the BAML parser would mean forcing it
// into the Issue shape it deliberately is not.
function baisProjectName(issuesDir: string): string {
	const cfg = join(resolve(issuesDir, ".."), "config.toml");
	if (existsSync(cfg)) {
		try {
			const m = readFileSync(cfg, "utf8").match(/^\s*project\s*=\s*"([^"]*)"/m);
			if (m) return m[1];
		} catch {}
	}
	return basename(resolve(issuesDir, "..", ".."));
}

export type BaisRefStatus = "Missing" | "External";
export type BaisDanglingRef = {
	declaredBy: string ; // id of the issue whose file declared the edge
	from: string;
	to: string;
	kind: string;
	id: string;
	side: "from" | "to";
	status: BaisRefStatus;
};

// Mirror of BAML `dangling_edge_refs` (bais/baml_src/main.baml) — a mirror for
// the same FFI reason as filterReadyIssues above (proposals/05: enums nested
// in class fields compare silently-false inbound). BAML owns the rule and
// proves it with `baml test`; this reproduces it. Keep the two in step.
//
// Per-file parsing cannot catch these: an edge naming an id that does not exist
// is only visible once the whole directory is loaded. It matters because
// is_blocked treats an unresolvable blocker as blocking, so an unreported typo
// parks an issue indefinitely and silently.
export function danglingRefsIn(issues: BaisFile[], project: string): BaisDanglingRef[] {
	const known = new Set(issues.map((f) => f.issue.id));
	const out: BaisDanglingRef[] = [];
	for (const f of issues) {
		for (const e of f.edges) {
			for (const side of ["from", "to"] as const) {
				const id = e[side];
				if (known.has(id)) continue;
				const scope = idProject(id);
				out.push({
					declaredBy: f.issue.id,
					from: e.from,
					to: e.to,
					kind: e.kind,
					id,
					side,
					// An unscoped id is Missing, not excused as another project's.
					status: scope !== "" && scope !== project ? "External" : "Missing",
				});
			}
		}
	}
	return out;
}

export async function danglingBaisRefs(dir?: string): Promise<BaisDanglingRef[]> {
	const issuesDir = issuesDirOrDefault(dir);
	if (!existsSync(issuesDir)) return [];
	const { issues } = await loadBaisIssues(issuesDir);
	return danglingRefsIn(issues, baisProjectName(issuesDir));
}

// Mirror of BAML `cyclic_ids` (bais/baml_src/main.baml) — Kahn's algorithm
// keeping the leftovers: whatever cannot be dropped is in a dependency cycle
// or downstream of one. Same mirror rationale as readyBaisIssues above.
function precedesEdge(e: BaisEdge, before: string, after: string): boolean {
	if (e.kind === "Blocks") return e.from === before && e.to === after;
	if (e.kind === "DependsOn") return e.to === before && e.from === after;
	return false;
}

export function cyclicIssueIds(all: BaisFile[]): string[] {
	const edges = all.flatMap((f) => f.edges);
	let remaining = all.map((f) => f.issue.id);
	for (;;) {
		const next = remaining.filter((id) => edges.some((e) => remaining.some((other) => precedesEdge(e, other, id))));
		if (next.length === remaining.length) return next;
		remaining = next;
	}
}

// Same traversal as loadBaisIssues, named for the CLI's ok/bad reporting, plus
// the graph-level passes that per-file validation cannot do (dangling refs,
// cycles). Shape matches `bais check --json` plus the bais SPEC §4.3 contract.
// Close-evidence (bi#83) is delegated to bais's gate, not mirrored: bi#84
// direction is consume-don't-reimplement, and a second implementation is a
// second place for the rule to rot.
export type BaisEvidenceProblem = {
	id: string;
	reason: "missing-close-evidence" | "unresolvable-drill" | "unresolvable-verdict";
	ref: string | null;
	kind: "drill" | "verdict" | null;
	status: "Missing" | "External";
};
export async function checkBaisIssues(
	dir?: string,
): Promise<{ ok: BaisFile[]; bad: BaisLoadFailure[]; dangling: BaisDanglingRef[]; cycles: string[]; evidence: BaisEvidenceProblem[] }> {
	const issuesDir = issuesDirOrDefault(dir);
	const { issues, failures } = await loadBaisIssues(issuesDir);
	const gmod = await loadBaisGraphModule();
	const evidence = gmod.closeEvidenceIn(
		issues.map((f) => ({ id: f.issue.id, status: f.issue.status, body: f.issue.body })),
		baisProjectName(issuesDir),
		gmod.knownDrillNames(gmod.scriptsDirFor(issuesDir)),
	) as BaisEvidenceProblem[];
	return {
		ok: issues,
		bad: failures,
		dangling: danglingRefsIn(issues, baisProjectName(issuesDir)),
		cycles: cyclicIssueIds(issues),
		evidence,
	};
}

// Fast list path for /issues: readdir + strict line scan, zero BAML VM
// calls. This is the payoff of the file-per-issue standard — the list is
// O(file bytes) while a full load pays one VM validation per file. Full
// BAML validation still happens, but only for the O(1) files the agent
// actually stages.
//
// Scalars come from top-level `key = "value"` lines; edges from
// `[[edge]]` blocks; `body = """` spans are skipped so body text can
// never masquerade as frontmatter. Anything off-shape marks the file
// unparseable: it still lists (an honest row, never selectable) but its
// edges are dropped, so a corrupt file can neither block nor unblock
// work — the same never-fabricate rule as loadBaisIssues.
export type BaisHeader = {
	id: string;
	title: string;
	status: string;
	kind: string;
	file: string;
	parseable: boolean;
};

export type BaisScan = { headers: BaisHeader[]; edges: BaisEdge[] };

export function baisIssuesDir(dir?: string): string {
	return issuesDirOrDefault(dir);
}

const SCALAR_RE = /^([A-Za-z_][A-Za-z0-9_]*) = "(.*)"$/;
// Bare-integer scalars (severity = 2): legal TOML the header scan needs
// nothing from. bi#112 root cause: every severity-bearing file scanned
// unparseable, so /issues could list but never stage or mark it.
const INT_SCALAR_RE = /^([A-Za-z_][A-Za-z0-9_]*) = (-?\d+)$/;

export function scanBaisHeaders(dir?: string): BaisScan {
	const issuesDir = issuesDirOrDefault(dir);
	const headers: BaisHeader[] = [];
	const edges: BaisEdge[] = [];
	if (!existsSync(issuesDir)) return { headers, edges };
	const files = readdirSync(issuesDir).filter((f) => f.endsWith(".toml"));
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(join(issuesDir, f), "utf8");
		} catch {
			continue;
		}
		const scalars = new Map<string, string>();
		const fileEdges: BaisEdge[] = [];
		let ok = true;
		let inBody = false;
		let cur: { from?: string; to?: string; kind?: string } | null = null;
		const flushEdge = () => {
			if (!cur) return;
			if (cur.from && cur.to && cur.kind) fileEdges.push({ from: cur.from, to: cur.to, kind: cur.kind });
			else ok = false;
			cur = null;
		};
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (inBody) {
				if (line === `"""`) inBody = false;
				continue;
			}
			if (line === `[[edge]]`) {
				flushEdge();
				cur = {};
				continue;
			}
			if (line.startsWith("[[") && line.endsWith("]]")) {
				flushEdge();
				continue;
			}
			const m = line.match(SCALAR_RE);
			if (!m) {
				// Blank lines and comments are layout, not content.
				if (line === "" || line.startsWith("#")) continue;
				// Integer scalars are content the scan doesn't need
				// (severity) — but only at top level: edge tables take
				// from/to/kind strings, so an int there is off-shape.
				if (!cur && INT_SCALAR_RE.test(line)) continue;
				ok = false;
				continue;
			}
			const [, key, value] = m;
			if (key === "body") {
				// Body is prose, never frontmatter: a lone `body = """`
				// opener starts a skipped span, anything else body-shaped
				// on one line is opaque and skipped as-is.
				if (line === `body = """`) inBody = true;
				continue;
			}
			if (line.includes(`"""`)) {
				ok = false;
				continue;
			}
			if (cur) {
				if (key === "from" || key === "to" || key === "kind") (cur as any)[key] = value;
				continue;
			}
			if (scalars.has(key)) ok = false; // duplicate top-level key
			else scalars.set(key, value);
		}
		flushEdge();
		const id = scalars.get("id") ?? "";
		const title = scalars.get("title") ?? "";
		const status = scalars.get("status") ?? "";
		const kind = scalars.get("kind") ?? "";
		const parseable = ok && id !== "" && title !== "" && status !== "" && kind !== "";
		headers.push({ id: id || f, title, status, kind, file: join(issuesDir, f), parseable });
		if (parseable) edges.push(...fileEdges);
	}
	return { headers, edges };
}

// Blockers pointing at an id, from the scan's own edges (same Blocks
// rule as filterReadyIssues: unclosed or unresolvable blockers block).
export function scannedBlockers(id: string, scan: BaisScan, byId: Map<string, BaisHeader>): string[] {
	const out: string[] = [];
	for (const e of scan.edges) {
		if (e.kind !== "Blocks" || e.to !== id) continue;
		const blocker = byId.get(e.from);
		if (!blocker || (blocker.status !== "Done" && blocker.status !== "Dropped")) out.push(e.from);
	}
	return out;
}

// Staged-issue deep read: single-file read + BAML validation each, with
// an mtime memo so unchanged files cost no VM call across turns. Bodies
// are re-read (never baked) so mid-session edits show up next turn.
// Missing ids (deleted/moved since staging) come back separately so the
// caller can prune the staged set instead of showing ghosts.
export type StagedIssueContext = {
	file: BaisFile;
	neighbors: { id: string; title: string; status: string }[];
};

const stagedCache = new Map<string, { mtimeMs: number; file: BaisFile }>();

export async function loadStagedIssues(ids: string[], dir?: string): Promise<{ staged: StagedIssueContext[]; missing: string[] }> {
	const scan = scanBaisHeaders(dir);
	const byId = new Map(scan.headers.map((h) => [h.id, h]));
	const staged: StagedIssueContext[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const h = byId.get(id);
		if (!h || !h.parseable) {
			missing.push(id);
			continue;
		}
		try {
			const mtimeMs = statSync(h.file).mtimeMs;
			let file = stagedCache.get(h.file)?.mtimeMs === mtimeMs ? stagedCache.get(h.file)!.file : null;
			if (!file) {
				file = await validateViaBaisBaml(readFileSync(h.file, "utf8"));
				stagedCache.set(h.file, { mtimeMs, file });
			}
			const seen = new Set<string>();
			const neighbors: { id: string; title: string; status: string }[] = [];
			for (const e of file.edges) {
				for (const nid of [e.from, e.to]) {
					if (nid === id || seen.has(nid)) continue;
					seen.add(nid);
					const n = byId.get(nid);
					neighbors.push(n ? { id: nid, title: n.title, status: n.status } : { id: nid, title: "(unresolved — typo or cross-project edge)", status: "?" });
				}
			}
			staged.push({ file, neighbors });
		} catch {
			missing.push(id);
		}
	}
	return { staged, missing };
}

export async function graphBaisIssues(fromId: string, dir?: string): Promise<BaisFile[]> {
	const all = await listBaisIssues(dir);
	const edges = all.flatMap((f) => f.edges);
	const seen = new Set<string>([fromId]);
	const queue = [fromId];
	const out: BaisFile[] = [];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const e of edges) {
			if (e.from === cur && !seen.has(e.to)) {
				seen.add(e.to);
				queue.push(e.to);
			}
			if (e.to === cur && !seen.has(e.from)) {
				seen.add(e.from);
				queue.push(e.from);
			}
		}
	}
	for (const id of seen) {
		const f = all.find((x) => x.issue.id === id);
		if (f) out.push(f);
	}
	return out;
}

// Progressive disclosure (hub#206, hermes prompt_builder.py:1191-1219): the
// prompt carries a compact INDEX rendered by BAML (format_issue_index /
// format_skill_index in bi/baml_src/issues.baml — one bounded line per
// entry, hermes' 60-char description rule, sorted so enumeration order
// never leaks into bytes). Full bodies load on demand as tool results
// (bais_view/skill_view in tools.ts), never by rebuilding the prompt.
// BAML owns the render and its baml-test proof; this is the host plumbing:
// entry extraction from the zero-VM header scan + a session-stable cache.

export type IssueIndexEntry = { id: string; status: string; kind: string; title: string };
export type SkillIndexEntry = { name: string; description: string };

// Index entries straight from scanBaisHeaders — readdir + line scan, zero
// BAML VM calls, the same O(file bytes) fast path /issues uses. Unparseable
// files are skipped rather than fabricating id/status (same never-fabricate
// rule as loadBaisIssues; `bais check` names them).
export function issueIndexEntries(dir?: string): IssueIndexEntry[] {
	return scanBaisHeaders(dir)
		.headers.filter((h) => h.parseable)
		.map((h) => ({ id: h.id, status: h.status, kind: h.kind, title: h.title }));
}

// Byte-stability within a session (hub#206 acceptance): the injected block
// must not change between turns unless the underlying issues actually
// changed, or prompt caches miss every turn. Keyed by issues dir; the value
// is the rendered block plus the scan fingerprint it was rendered from
// (file count + max mtime — a touch, an add, or a delete all move it). A
// scan with the same fingerprint reuses the cached block: same entries,
// same bytes, no VM call. Body-only edits still bump mtime, so a stale
// block is never served past a real change (titles/status/kind are header
// fields).
const issueIndexCache = new Map<string, { fingerprint: string; block: string }>();

export async function renderIssueIndex(dir?: string): Promise<string> {
	const issuesDir = issuesDirOrDefault(dir);
	const scan = scanBaisHeaders(issuesDir);
	let maxMtimeMs = 0;
	for (const h of scan.headers) {
		try {
			maxMtimeMs = Math.max(maxMtimeMs, statSync(h.file).mtimeMs);
		} catch {}
	}
	const fingerprint = `${scan.headers.length}:${maxMtimeMs}`;
	const cached = issueIndexCache.get(issuesDir);
	if (cached && cached.fingerprint === fingerprint) return cached.block;
	const entries = scan.headers
		.filter((h) => h.parseable)
		.map((h) => ({ id: h.id, status: h.status, kind: h.kind, title: h.title }));
	const block = await format_issue_index_async(entries);
	issueIndexCache.set(issuesDir, { fingerprint, block });
	return block;
}

// Skill entries come from skill discovery, which lives in cli.ts/skills.ts
// (out of this file's scope) — this is only the render path, kept next to
// renderIssueIndex so both progressive-disclosure blocks are produced the
// same way. Pure pass-through to BAML: same entries in → same bytes out.
export async function renderSkillIndex(entries: SkillIndexEntry[]): Promise<string> {
	return format_skill_index_async(entries);
}
