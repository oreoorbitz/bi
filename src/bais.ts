// bi/src/bais.ts — TS-level BAIS interop (BAML deps not yet live in 0.17.0).
// bais is the single source of truth for Issue/Edge types (defined in
// bais/baml_src/main.baml). Until `baml.toml [dependencies]` lands
// (Phase-B, single-workspace invariant), bi consumes BAIS via the TS host:
// it reads .bais/issues/*.toml and validates them through bais's BAML parser
// (bais/src/toml.ts → bais/baml_src/ns_toml/toml.baml), which keeps BAML
// as the validator even without a BAML-level import.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
export type BaisFile = { issue: BaisIssue; edges: BaisEdge[] };

// Resolve the BAIS issues directory. Prefer the nearest .bais/issues
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
	return all.filter((f) => f.issue.status === "Open" && !blocked.has(f.issue.id));
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

export async function createBaisIssue(opts: {
	title: string;
	kind?: string;
	area?: string;
	body?: string;
	status?: string;
	dir?: string;
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
		edges: [],
	};
	// BAML is validator — serialize via BAML, then re-validate
	const toml = await serializeViaBaisBaml(file);
	await validateViaBaisBaml(toml);
	const fp = join(targetDir, `${id}.toml`);
	writeFileSync(fp, toml);
	return file;
}

export async function moveBaisIssue(id: string, status: string, dir?: string): Promise<BaisFile> {
	const issuesDir = dir ?? resolveIssuesDir() ?? join(process.cwd(), "bi/.bais/issues");
	if (!existsSync(issuesDir)) throw new Error(`No .bais/issues at ${issuesDir}`);
	const fp = join(issuesDir, `${id}.toml`);
	if (!existsSync(fp)) throw new Error(`No issue ${id} at ${fp}`);
	const text = readFileSync(fp, "utf8");
	const file = await validateViaBaisBaml(text);
	(file as any).issue.status = status;
	const toml = await serializeViaBaisBaml(file);
	await validateViaBaisBaml(toml);
	writeFileSync(fp, toml);
	return file;
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
