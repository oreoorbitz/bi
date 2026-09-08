// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec host wrapper.
// BAML owns the plain-data spec (ListTools/GetTool), TS host owns executors
// (actual read/write/bash + bais_*). This mirrors bi's ToolSpec handling (limitation 4).

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GetTool_async, ListTools_async, render_tool_diff_async, refuse_bash_blocked_async, refuse_bash_timeout_async, refuse_read_binary_async, refuse_read_outside_root_async, refuse_read_too_large_async, refuse_write_outside_root_async, refuse_write_untrusted_async, refuse_write_too_large_async, edit_missing_text_async, gate_meta_tool_materialization_async, mine_meta_tools_async, write_guard_check_async, MaterializeRefuse, WriteGuardRefuse, type MetaToolProposal, type MetaToolSpec, type SessionTrace, type ToolSpec } from "../baml_sdk/index.js";
import { checkBaisIssues, createBaisIssue, graphBaisIssues, loadBaisIssues, moveBaisIssue, readyBaisIssues } from "./bais.js";
import { colorizeDiffLines } from "./diff-render.js";
import { getStoredTrust } from "./trust.js";

export type { ToolSpec } from "../baml_sdk/index.js";

export async function listTools(): Promise<ToolSpec[]> {
	return ListTools_async();
}

export async function getTool(name: string): Promise<ToolSpec | null> {
	return GetTool_async(name);
}

// bi#71: transcript shaping for edit/write tool results. The host passes
// bytes through: it parses the {path, before, after} envelope the tool
// output carries (or nulls when absent) and BAML decides diffable + shapes
// the lines. Non-diffable payloads yield no lines — the transcript keeps
// today's start/done lines byte-identical (raw fallback = unchanged).
export interface ShapedToolResult {
	diffable: boolean;
	lines: string[];
}

// Envelope parse is byte work, host-side by contract: the object must
// carry all three fields as strings. Binary sides (NUL) are rejected here
// so BAML never sees binary; BAML owns every shaping decision past this.
function parseDiffEnvelope(output: string): { path: string; before: string; after: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const r = parsed as Record<string, unknown>;
	if (typeof r.path !== "string" || typeof r.before !== "string" || typeof r.after !== "string") return null;
	if (r.before.includes(String.fromCharCode(0)) || r.after.includes(String.fromCharCode(0))) return null;
	return { path: r.path, before: r.before, after: r.after };
}

export async function shapeToolResult(name: string, output: string): Promise<ShapedToolResult> {
	const env = parseDiffEnvelope(output);
	const view = await render_tool_diff_async(name, env?.path ?? null, env?.before ?? null, env?.after ?? null);
	return { diffable: view.diffable, lines: [...view.lines] };
}

// The transcript call after a tool success: print the shaped diff lines,
// tinted for the terminal, and nothing at all unless BAML deems the payload
// diffable (failures and plain output keep today's lines byte-identical).
// Theme defaults to null (pipes/tests stay byte-identical); the cli owner
// passes its active theme at the runToolWithStatus call site.
export async function emitToolDiff(name: string, output: string, theme: string | null = null): Promise<void> {
	const shaped = await shapeToolResult(name, output);
	if (shaped.diffable) for (const l of await colorizeDiffLines(shaped.lines, theme)) console.log(l);
}

// bi#77: write/edit executors with cwd jail + affirmative project trust.
// bi#150 adds the bash executor (allowlist + scrubbed env + timeout/kill +
// secret redaction); bi#151 adds the read-only executors (read/ls/grep/find)
// reusing the same cwd jail with text-only + capped output.
export const TOOL_WRITE_CAP = 1_000_000;

// Effective trust lives in the loop (in-memory session answer + stored
// file); the loop registers a live reader once, so a mid-session
// `/trust deny` refuses the very next write — no stale latch.
let trustReader: () => string | null = () => getStoredTrust(process.cwd());
export function setTrustReader(fn: () => string | null): void {
	trustReader = fn;
}

// Resolve inside the project cwd without judging: the cwd-jailed, symlink-
// aware absolute path for p. Shared by the jail (which refuses escapes) and
// the hub#208 read-mark set (which must key read and write on the SAME
// resolved path or a symlink spelling would dodge the guard).
function guardResolvePath(p: string): string {
	const root = realpathSync(process.cwd());
	const abs = resolve(root, p);
	let probe = abs;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	return existsSync(abs) ? realpathSync(abs) : realpathSync(probe) + abs.slice(probe.length);
}

// Resolve inside the project cwd or throw the caller's BAML refusal.
// Symlink escapes resolve through the nearest existing ancestor, and an
// already-existing final symlink resolves fully too, so a link pointing
// outside still refuses. The refuse callback picks the refusal string:
// write's for write/edit, read's for the read-only tools (bi#151).
async function jailResolve(p: string, refuse: (path: string) => Promise<string>): Promise<string> {
	const root = realpathSync(process.cwd());
	const real = guardResolvePath(p);
	if (real !== root && !real.startsWith(root + sep)) {
		throw new Error(await refuse(p));
	}
	return real;
}

// Affirmative trust only: stored allow, or session trust for this run.
// Stored deny AND undecided both refuse (named fix, BAML-owned).
async function gateWriteTrust(): Promise<void> {
	const t = trustReader();
	if (t === "allow" || t === "session") return;
	throw new Error(await refuse_write_untrusted_async());
}

function diffEnvelope(path: string, before: string, after: string): string {
	return JSON.stringify({ path, before, after });
}

async function execWrite(args: Record<string, unknown>): Promise<string> {
	const p = args.path;
	const content = args.content;
	if (typeof p !== "string" || !p) throw new Error('write requires a "path" string');
	if (typeof content !== "string") throw new Error('write requires a "content" string');
	if (Buffer.byteLength(content) > TOOL_WRITE_CAP) {
		throw new Error(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
	}
	await gateWriteTrust();
	const abs = await jailResolve(p, refuse_write_outside_root_async);
	const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
	if (Buffer.byteLength(before) > TOOL_WRITE_CAP) {
		throw new Error(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
	}
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	return diffEnvelope(p, before, content);
}

async function execEdit(args: Record<string, unknown>): Promise<string> {
	const p = args.path;
	const edits = args.edits;
	if (typeof p !== "string" || !p) throw new Error('edit requires a "path" string');
	if (!Array.isArray(edits) || edits.length === 0) throw new Error('edit requires a non-empty "edits" array');
	await gateWriteTrust();
	const abs = await jailResolve(p, refuse_write_outside_root_async);
	let current: string;
	try {
		current = readFileSync(abs, "utf8");
	} catch {
		throw new Error(`edit target unreadable: "${p}" — write it first or check the path`);
	}
	// Validate every oldText before touching disk: atomic or nothing.
	const pairs: { oldText: string; newText: string }[] = [];
	for (let i = 0; i < edits.length; i++) {
		const e = edits[i] as Record<string, unknown>;
		if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") {
			throw new Error(`edit ${i} needs string oldText/newText`);
		}
		if (!current.includes(e.oldText)) throw new Error(await edit_missing_text_async(p, i));
		pairs.push({ oldText: e.oldText, newText: e.newText });
	}
	let next = current;
	for (const pair of pairs) next = next.replace(pair.oldText, pair.newText);
	if (Buffer.byteLength(next) > TOOL_WRITE_CAP) {
		throw new Error(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
	}
	writeFileSync(abs, next);
	return diffEnvelope(p, current, next);
}

// bi#150: bash executor with a real command policy. The first token of the
// command line must be on the allowlist (git/rg/node and other safe,
// mostly read-only tools) — anything else (curl, ssh, ...) refuses loud
// with the BAML-owned policy reason. The child runs jailed to the project
// cwd with a scrubbed env (no secrets, no loader hijacks), dies at its
// timeout (killed, never orphaned), and its output is secret-redacted
// before the transcript ever sees it.
export const BASH_DEFAULT_TIMEOUT_S = 30;
export const BASH_MAX_TIMEOUT_S = 120;
export const TOOL_BASH_CAP = 256_000;

const BASH_ALLOW = new Set([
	"git", "rg", "node", "npm", "npx", "ls", "cat", "head", "tail",
	"echo", "pwd", "sleep", "wc", "sort", "uniq", "diff", "grep", "find",
	"jq", "true", "false",
]);

// First token of the command line, skipping VAR=x env prefixes and
// resolving absolute paths to their basename. Empty/quoted-operator
// leads yield null (refuse, not guess).
function bashProgram(command: string): string | null {
	let rest = command.trim().replace(/^[;(]+/, "").trim();
	for (;;) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s*/.exec(rest);
		if (!m) break;
		rest = rest.slice(m[0].length);
	}
	const m = /^([\w.+/-]+)/.exec(rest);
	if (!m) return null;
	return basename(m[1]) || null;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|BEARER)/i;
const DANGEROUS_ENV = new Set([
	"LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
	"BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH",
]);

// Copy the parent env minus secrets and loader hijacks. Everything else
// (PATH, HOME, TERM, ...) passes through so allowlisted tools behave.
function scrubEnv(src: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(src)) {
		if (v === undefined) continue;
		if (DANGEROUS_ENV.has(k) || SECRET_ENV.test(k)) continue;
		out[k] = v;
	}
	return out;
}

const SECRET_RES = [
	/sk-ant-[A-Za-z0-9\-_]{8,}/g,
	/(gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/xox[bpas]-[A-Za-z0-9\-]+/g,
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];
const SECRET_KV = /((?:api[_-]?key|secret|token|passwd|password|auth(?:orization)?)\s*[:=]\s*['"]?)[^\s'";,}]+(['"]?)/gi;

// Redact secret-looking output before it reaches the transcript. Exported
// for the conformance script; the executor always applies it.
export function redactSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_RES) {
		re.lastIndex = 0;
		out = out.replace(re, "[REDACTED]");
	}
	SECRET_KV.lastIndex = 0;
	return out.replace(SECRET_KV, "$1[REDACTED]$2");
}

const execFileAsync = promisify(execFile);

async function execBash(args: Record<string, unknown>): Promise<string> {
	const command = args.command;
	if (typeof command !== "string" || !command.trim()) throw new Error('bash requires a "command" string');
	const want = Math.floor(Number(args.timeout ?? BASH_DEFAULT_TIMEOUT_S));
	const timeoutS = Number.isFinite(want) ? Math.min(Math.max(want, 1), BASH_MAX_TIMEOUT_S) : BASH_DEFAULT_TIMEOUT_S;
	const prog = bashProgram(command);
	if (!prog || !BASH_ALLOW.has(prog)) {
		throw new Error(await refuse_bash_blocked_async(command, [...BASH_ALLOW].sort().join(", ")));
	}
	let raw: string;
	try {
		const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
			cwd: process.cwd(),
			timeout: timeoutS * 1000,
			maxBuffer: 4 * 1024 * 1024,
			env: scrubEnv(process.env),
		});
		raw = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
	} catch (e) {
		const err = e as { killed?: boolean; stdout?: string; stderr?: string; code?: number; message?: string };
		const partial = redactSecrets((err.stdout ?? "") + (err.stderr ? `\n[stderr]\n${err.stderr}` : ""));
		if (err.killed) throw new Error(await refuse_bash_timeout_async(command, timeoutS));
		throw new Error(`bash exited ${err.code ?? "?"}: ${command}\n${partial}`);
	}
	const redacted = redactSecrets(raw);
	if (Buffer.byteLength(redacted) > TOOL_BASH_CAP) {
		const buf = Buffer.from(redacted);
		return buf.subarray(0, TOOL_BASH_CAP).toString("utf8") + `\n…(truncated: ${buf.length - TOOL_BASH_CAP} more bytes)`;
	}
	return redacted;
}

// bi#151: read-only executors. All four reuse the write jail (same
// cwd + symlink-escape refusal, BAML-owned read strings), serve text only
// (NUL refuses), and cap output: single reads refuse past the byte cap,
// search tools truncate and say so in the payload.
export const TOOL_READ_CAP = 256_000;
export const TOOL_READ_MAX_LINES = 2000;
export const TOOL_LS_CAP = 1000;
export const TOOL_GREP_CAP = 200;
export const TOOL_FIND_CAP = 500;

async function execRead(args: Record<string, unknown>): Promise<string> {
	const p = args.path;
	if (typeof p !== "string" || !p) throw new Error('read requires a "path" string');
	const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1);
	const limit = Math.min(Math.max(1, Math.floor(Number(args.limit ?? TOOL_READ_MAX_LINES)) || 1), TOOL_READ_MAX_LINES);
	const abs = await jailResolve(p, (q) => refuse_read_outside_root_async("read", q));
	let buf: Buffer;
	try {
		if (statSync(abs).isDirectory()) throw new Error(`read: "${p}" is a directory — use ls`);
		buf = readFileSync(abs);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("read:")) throw e;
		throw new Error(`read: no such file "${p}" — check the path`);
	}
	if (buf.includes(0)) throw new Error(await refuse_read_binary_async("read", p));
	if (buf.length > TOOL_READ_CAP) throw new Error(await refuse_read_too_large_async("read", p, TOOL_READ_CAP));
	const lines = buf.toString("utf8").split("\n");
	// A trailing newline is not a line: full reads stay byte-identical and
	// only genuinely unread lines earn the marker.
	const effective = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
	const slice = lines.slice(offset - 1, offset - 1 + limit);
	const rest = effective - (offset - 1 + slice.length);
	return slice.join("\n") + (rest > 0 ? `\n…(${rest} more lines — retry with offset ${offset + slice.length})` : "");
}

type LsEntry = { name: string; kind: "dir" | "file" | "symlink" | "other" };

async function execLs(args: Record<string, unknown>): Promise<string> {
	const p = typeof args.path === "string" && args.path ? args.path : ".";
	const abs = await jailResolve(p, (q) => refuse_read_outside_root_async("ls", q));
	let entries: LsEntry[];
	try {
		if (!statSync(abs).isDirectory()) throw new Error(`ls: "${p}" is not a directory`);
		entries = readdirSync(abs, { withFileTypes: true }).map((d) => ({
			name: d.name,
			kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other",
		} as LsEntry)).sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === "dir" ? -1 : 1));
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("ls:")) throw e;
		throw new Error(`ls: cannot list "${p}" — check the path`);
	}
	const truncated = entries.length > TOOL_LS_CAP;
	return JSON.stringify({ path: p, entries: truncated ? entries.slice(0, TOOL_LS_CAP) : entries, truncated });
}

// Walk absolute paths under root without following symlinks. Symlink
// entries are yielded themselves (find lists them, grep skips them) but
// never descended — an escape link can neither leak nor loop.
function walkFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names.sort()) {
			const full = resolve(dir, n);
			let st;
			try {
				st = lstatSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) stack.push(full);
			else if (st.isFile()) out.push(full);
			else if (st.isSymbolicLink()) out.push(full);
		}
	}
	return out;
}

function globToRegExp(glob: string): RegExp {
	return new RegExp("^" + glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : "\\.+^$()|[]{}".includes(c) ? `\\${c}` : c)).join("") + "$");
}

async function execGrep(args: Record<string, unknown>): Promise<string> {
	const pattern = args.pattern;
	if (typeof pattern !== "string" || !pattern) throw new Error('grep requires a "pattern" string');
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		throw new Error(`grep: invalid regex "${pattern}"`);
	}
	const base = typeof args.path === "string" && args.path ? args.path : ".";
	const root = await jailResolve(base, (q) => refuse_read_outside_root_async("grep", q));
	const glob = typeof args.glob === "string" && args.glob ? globToRegExp(args.glob) : null;
	const rootIsDir = statSync(root).isDirectory();
	const roots = rootIsDir ? walkFiles(root) : [root];
	const matches: { path: string; line: number; text: string }[] = [];
	let truncated = false;
	let skippedBinary = 0;
	let skippedLarge = 0;
	for (const full of roots) {
		if (truncated) break;
		if (glob && !glob.test(basename(full))) continue;
		let st;
		try {
			st = lstatSync(full);
		} catch {
			continue;
		}
		if (!st.isFile()) continue; // symlinks never followed
		if (st.size > TOOL_READ_CAP) {
			skippedLarge++;
			continue;
		}
		const buf = readFileSync(full);
		if (buf.includes(0)) {
			skippedBinary++;
			continue;
		}
		const rel = relative(root, full).split(sep).join("/");
		const lines = buf.toString("utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i])) continue;
			if (matches.length >= TOOL_GREP_CAP) {
				truncated = true;
				break;
			}
			matches.push({ path: rootIsDir ? rel : base, line: i + 1, text: lines[i].slice(0, 1000) });
		}
	}
	return JSON.stringify({ pattern, matches, truncated, skipped_binary: skippedBinary, skipped_large: skippedLarge });
}

async function execFind(args: Record<string, unknown>): Promise<string> {
	const pattern = args.pattern;
	if (typeof pattern !== "string" || !pattern) throw new Error('find requires a "pattern" string');
	const base = typeof args.path === "string" && args.path ? args.path : ".";
	const root = await jailResolve(base, (q) => refuse_read_outside_root_async("find", q));
	const isDir = statSync(root).isDirectory();
	const files = isDir ? walkFiles(root) : [root];
	const re = globToRegExp(pattern);
	const paths: string[] = [];
	let truncated = false;
	for (const full of files) {
		if (!re.test(basename(full))) continue;
		if (paths.length >= TOOL_FIND_CAP) {
			truncated = true;
			break;
		}
		paths.push(isDir ? relative(root, full).split(sep).join("/") : base);
	}
	return JSON.stringify({ pattern, paths, truncated });
}

// hub#203: TranscriptDigest construction for the post-turn review fork
// (baml_src/review.baml ReviewTurn). Host byte-work mirroring hermes'
// digest pass (background_review.py:280-294): user turns truncated to 300
// chars, assistant text to 200, tool calls named not echoed. BAML owns
// what the fork ASKS; the host owns how the digest is built from the live
// transcript. The output matches the BAML TranscriptDigest class 1:1 —
// plain data that crosses the bridge as a ReviewTurn argument.
export interface DigestEntryData {
	role: string;
	text: string;
	tools: string[];
}

export interface TranscriptDigestData {
	session_id: string;
	earlier_summary: string | null;
	recent: DigestEntryData[];
	skills_loaded: string[];
}

export const DIGEST_USER_CAP = 300;
export const DIGEST_ASSISTANT_CAP = 200;

// Message shapes seen in the live transcript: REPL turns are
// {role, text}; model turns may carry pi-style content blocks
// ({type:"text"} / {type:"toolUse", name}). Anything else contributes its
// role with empty text — never a silent drop of the turn itself.
export function buildTranscriptDigest(
	history: readonly unknown[],
	sessionId: string,
	opts: { earlierSummary?: string | null; skillsLoaded?: string[] } = {},
): TranscriptDigestData {
	const recent: DigestEntryData[] = [];
	for (const msg of history) {
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as Record<string, unknown>;
		const role = typeof m.role === "string" ? m.role : "unknown";
		const cap = role === "user" ? DIGEST_USER_CAP : DIGEST_ASSISTANT_CAP;
		const tools: string[] = [];
		let text = "";
		if (typeof m.text === "string") text = m.text;
		if (Array.isArray(m.content)) {
			const texts: string[] = [];
			for (const b of m.content) {
				if (typeof b !== "object" || b === null) continue;
				const block = b as Record<string, unknown>;
				if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
				// NB: tool-parity.mjs greps name=== labels as handleTool
				// dispatch arms — never write that literal here.
				const toolName = block.name;
				if (block.type === "toolUse" && typeof toolName === "string") tools.push(toolName);
			}
			if (texts.length) text = texts.join("\n");
		}
		recent.push({ role, text: text.replace(/\n/g, " ").slice(0, cap), tools });
	}
	return {
		session_id: sessionId,
		earlier_summary: opts.earlierSummary ?? null,
		recent,
		skills_loaded: opts.skillsLoaded ?? [],
	};
}

// hub#207: meta-tools mined from session transcripts (arXiv:2601.22037).
// BAML owns mining (mine_meta_tools — recurring contiguous tool-call
// sequences across SessionTrace trajectories, one proposal per distinct
// sequence) and the materialization gate (hub#200 flip-gate evidence);
// the host stays a thin pass-through. Materializing yields a plain-data
// MetaToolSpec — staged for human approval like hub#203 review proposals,
// never auto-installed. Refusals arrive as named MaterializeRefuse slugs
// (bi#55) and surface here as thrown errors naming the reason.
export type { MetaToolProposal, MetaToolSpec, SessionTrace } from "../baml_sdk/index.js";

export async function mineMetaTools(sessions: SessionTrace[], minSupport = 2): Promise<MetaToolProposal[]> {
	return mine_meta_tools_async(sessions, { min_support: minSupport });
}

export async function materializeMetaTool(proposal: MetaToolProposal): Promise<MetaToolSpec> {
	const verdict = await gate_meta_tool_materialization_async(proposal);
	if (verdict instanceof MaterializeRefuse) {
		throw new Error(`meta-tool materialization refused: ${verdict.reason}`);
	}
	return verdict;
}

// hub#208 rail 1: READ-BEFORE-WRITE enforced by the tool layer, not the
// prompt (hermes skill_manager_guards.py:55-71 read marks, 220-230
// refusal). A ToolSession carries the per-session read marks — the resolved
// absolute paths the `read` tool has served this session. The guarded entry
// point consults BAML's write_guard_check (policy + named refusal live in
// baml_src/write_guard.baml; the host owns only the mark set) before any
// write/edit: edit always needs a mark, write needs one only when
// overwriting an existing file (new-file creation is unfenced — there is
// nothing to have read). ls/grep/find never mark: they show names and
// fragments, not the content a write would destroy.
//
// Wiring: cli.ts still dispatches through bare handleTool (bi#193 owns that
// file) — the guard ships as this opt-in wrapper; routing the agent loop
// through newToolSession()/handleToolInSession is the named follow-up.
export interface ToolSession {
	readMarks: Set<string>;
}

export function newToolSession(): ToolSession {
	return { readMarks: new Set<string>() };
}

export async function handleToolInSession(
	session: ToolSession,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	if (name === "write" || name === "edit") {
		const p = args.path;
		if (typeof p !== "string" || !p) throw new Error(`${name} requires a "path" string`);
		const abs = guardResolvePath(p);
		const verdict = await write_guard_check_async({
			tool: name,
			path: p,
			target_exists: existsSync(abs),
			read_this_session: session.readMarks.has(abs),
		});
		if (verdict instanceof WriteGuardRefuse) {
			throw new Error(verdict.reason);
		}
	}
	const out = await handleTool(name, args);
	if (name === "read") {
		const p = args.path;
		if (typeof p === "string" && p) session.readMarks.add(guardResolvePath(p));
	}
	return out;
}

// BAML is spec, host is executor — dispatch table for the agent loop.
// bais_* tools are first-class here so the LLM can manage .bais.
export async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
	// self-adjust telemetry → BAIS: sub-agent patterns become issues
	if (name === "report_subagent_timeout") {
		const directive = String(args.directive ?? "unknown directive");
		const duration_ms = Number(args.duration_ms ?? 0);
		const timeout_ms = Number(args.timeout_ms ?? 0);
		const area = (args.area as string | undefined) ?? "agent/subagent";
		const file = await createBaisIssue({
			title: `Sub-agent timeout: ${directive} (${duration_ms}ms >= ${timeout_ms}ms)`,
			kind: "Flake",
			area,
			body: `Self-adjust report from Bi.\n\nDirective: ${directive}\nDuration: ${duration_ms}ms\nTimeout: ${timeout_ms}ms\n\nPattern: sub-agent timed out before completing. Consider increasing timeout or splitting directive. Repro: run Bi sub-agent with directive above, observe timeout. Acceptance: timeout raised or directive chunked, no timeout on retry.\n\nCreated via \`report_subagent_timeout\` tool.`,
		});
		return JSON.stringify(file, null, 2);
	}
	if (name === "report_reconcile_conflict") {
		const conflict_count = Number(args.conflict_count ?? 0);
		const files = (args.files as string[] | undefined) ?? [];
		const area = (args.area as string | undefined) ?? "agent/reconcile";
		const file = await createBaisIssue({
			title: `Reconcile conflicts: ${conflict_count} files`,
			kind: "Flake",
			area,
			body: `Self-adjust report from Bi.\n\nConflicts: ${conflict_count}\nFiles: ${files.join(", ") || "(unknown)"}\n\nPattern: parallel sub-agents produced conflicting edits. Consider tightening file ownership or reconcile strategy. Acceptance: re-run with isolated worktrees / clearer directive, no conflicts.\n\nCreated via \`report_reconcile_conflict\` tool.`,
		});
		return JSON.stringify(file, null, 2);
	}
	switch (name) {
		case "bais_list": {
			const status = (args.status as string | undefined) ?? null;
			const { issues, failures } = await loadBaisIssues();
			const filtered = status ? issues.filter((f) => f.issue.status === status) : issues;
			// `unparseable` is always present, even when empty: a tool that silently
			// omits files teaches the model the list is complete when it is not.
			return JSON.stringify({ issues: filtered, unparseable: failures }, null, 2);
		}
		case "bais_ready": {
			const files = await readyBaisIssues();
			return JSON.stringify(files, null, 2);
		}
		case "bais_new": {
			const title = String(args.title ?? "");
			if (!title) throw new Error("bais_new requires title");
			const file = await createBaisIssue({
				title,
				kind: (args.kind as string | undefined) ?? "Feat",
				area: (args.area as string | undefined) ?? undefined,
				body: (args.body as string | undefined) ?? undefined,
				status: (args.status as string | undefined) ?? "Open",
			});
			return JSON.stringify(file, null, 2);
		}
		case "bais_move": {
			const id = String(args.id ?? "");
			const status = String(args.status ?? "");
			if (!id || !status) throw new Error("bais_move requires id and status");
			const file = await moveBaisIssue(id, status);
			return JSON.stringify(file, null, 2);
		}
		case "bais_check": {
			const res = await checkBaisIssues();
			return JSON.stringify(res, null, 2);
		}
		case "bais_graph": {
			const from = String(args.from ?? "");
			if (!from) throw new Error("bais_graph requires from");
			const files = await graphBaisIssues(from);
			return JSON.stringify(files, null, 2);
		}
		case "write": {
			return execWrite(args);
		}
		case "edit": {
			return execEdit(args);
		}
		case "read": {
			return execRead(args);
		}
		case "bash": {
			return execBash(args);
		}
		case "ls": {
			return execLs(args);
		}
		case "grep": {
			return execGrep(args);
		}
		case "find": {
			return execFind(args);
		}
		default:
			throw new Error(`unknown tool ${name} — known tools: read/write/edit/bash/ls/grep/find/bais_*/report_*`);
	}
}
