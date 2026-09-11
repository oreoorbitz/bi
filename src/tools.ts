// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec host wrapper.
// BAML owns the plain-data spec (ListTools/GetTool), TS host owns executors
// (actual read/write/bash + bais_*). This mirrors bi's ToolSpec handling (limitation 4).

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GetTool_async, ListTools_async, render_tool_diff_async, approval_choices_async, approval_feedback_result_async, approval_header_async, refuse_approval_rejected_async, refuse_bash_blocked_async, refuse_bash_timeout_async, refuse_read_binary_async, refuse_read_outside_root_async, refuse_read_too_large_async, refuse_write_outside_root_async, refuse_write_untrusted_async, refuse_write_too_large_async, edit_missing_text_async, gate_meta_tool_materialization_async, mine_meta_tools_async, write_guard_check_async, MaterializeRefuse, WriteGuardRefuse, type MetaToolProposal, type MetaToolSpec, type SessionTrace, type ToolSpec } from "../baml_sdk/index.js";
import { checkBaisIssues, createBaisIssue, linkBaisIssues, loadBaisIssues, moveBaisIssue, parseClaimDuration, readyBaisIssues, reapBaisClaims, renewBaisClaim, type BaisEdge, type BaisFile } from "./bais.js";
import { colorizeDiffLines } from "./diff-render.js";
import { askApproval, askText, promptAvailable } from "./prompt.js";
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

// bi#220: expected tool errors (refusals + arg validation) carry a
// marker so the turn-failure site prints message-only; unexpected
// throws keep their stacks. Marked here at construction — never by
// string-matching at the print site.
export class ToolRefusalError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "ToolRefusalError";
	}
}

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
		throw new ToolRefusalError(await refuse(p));
	}
	return real;
}

// bi#170 per-call approval. Session approvals latch per tool in memory
// only (the stored trust file is untouched); interactive prompting is
// opt-in per process (the REPL sets it, `bi run` never does) AND
// TTY-gated, so pipes and non-interactive runs keep today's behavior
// byte-identical. Stored deny refuses without prompting — an explicit
// no is not re-asked. Undecided on a headless run refuses as before.
const sessionApprovals = new Map<string, true>();
let approvalInteractive = false;
export function setApprovalInteractive(on: boolean): void {
	approvalInteractive = on;
}

// Pure choice transition (drill-importable): what a prompt answer does
// to the latch. Index order is the BAML approval_choices order (pinned
// by baml test); unknown indices fail closed. The modal itself stays
// behind promptAvailable — this function never touches the terminal.
export function applyApprovalPick(latch: Map<string, true>, tool: string, pick: number): "once" | "session" | "reject" | "feedback" {
	if (pick === 1) {
		latch.set(tool, true);
		return "session";
	}
	if (pick === 2) return "reject";
	if (pick === 3) return "feedback";
	if (pick === 0) return "once";
	return "reject";
}

type ApprovalVerdict = { proceed: boolean; refusal?: string };
async function approvalFor(tool: string, detail: string): Promise<ApprovalVerdict> {
	if (sessionApprovals.has(tool)) return { proceed: true };
	const pick = await askApproval(await approval_header_async(tool), detail, await approval_choices_async());
	const kind = pick === null ? "reject" : applyApprovalPick(sessionApprovals, tool, pick);
	if (kind === "once" || kind === "session") return { proceed: true };
	// Null (Esc/Ctrl-C/Ctrl-D) lands here as reject; empty feedback
	// degrades to the plain refusal rather than sending blank text.
	if (kind === "feedback") {
		const fb = await askText("Rejection feedback (Enter to send, Esc for plain reject):");
		if (fb !== null && fb.trim()) return { proceed: false, refusal: await approval_feedback_result_async(tool, fb) };
	}
	return { proceed: false, refusal: await refuse_approval_rejected_async(tool) };
}

// Affirmative trust only: stored allow, or session trust for this run.
// Stored deny refuses (named fix, BAML-owned) without prompting.
// Undecided prompts per call on an interactive TTY and refuses headless.
async function gateWriteTrust(tool: string, detail: string): Promise<void> {
	const t = trustReader();
	if (t === "allow" || t === "session") return;
	if (t === "deny" || !approvalInteractive || !promptAvailable()) {
		throw new ToolRefusalError(await refuse_write_untrusted_async());
	}
	const v = await approvalFor(tool, detail);
	if (!v.proceed) throw new ToolRefusalError(v.refusal);
}

function diffEnvelope(path: string, before: string, after: string): string {
	return JSON.stringify({ path, before, after });
}

async function execWrite(args: Record<string, unknown>): Promise<string> {
	const p = args.path;
	const content = args.content;
	if (typeof p !== "string" || !p) throw new ToolRefusalError('write requires a "path" string');
	if (typeof content !== "string") throw new ToolRefusalError('write requires a "content" string');
	if (Buffer.byteLength(content) > TOOL_WRITE_CAP) {
		throw new ToolRefusalError(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
	}
	await gateWriteTrust("write", `write ${p} (${Buffer.byteLength(content)} bytes)`);
	const abs = await jailResolve(p, refuse_write_outside_root_async);
	const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
	if (Buffer.byteLength(before) > TOOL_WRITE_CAP) {
		throw new ToolRefusalError(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
	}
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	return diffEnvelope(p, before, content);
}

async function execEdit(args: Record<string, unknown>): Promise<string> {
	const p = args.path;
	const edits = args.edits;
	if (typeof p !== "string" || !p) throw new ToolRefusalError('edit requires a "path" string');
	if (!Array.isArray(edits) || edits.length === 0) throw new ToolRefusalError('edit requires a non-empty "edits" array');
	await gateWriteTrust("edit", `edit ${p} (${edits.length} edit${edits.length === 1 ? "" : "s"})`);
	const abs = await jailResolve(p, refuse_write_outside_root_async);
	let current: string;
	try {
		current = readFileSync(abs, "utf8");
	} catch {
		throw new ToolRefusalError(`edit target unreadable: "${p}" — write it first or check the path`);
	}
	// Validate every oldText before touching disk: atomic or nothing.
	const pairs: { oldText: string; newText: string }[] = [];
	for (let i = 0; i < edits.length; i++) {
		const e = edits[i] as Record<string, unknown>;
		if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") {
			throw new ToolRefusalError(`edit ${i} needs string oldText/newText`);
		}
		if (!current.includes(e.oldText)) throw new ToolRefusalError(await edit_missing_text_async(p, i));
		pairs.push({ oldText: e.oldText, newText: e.newText });
	}
	let next = current;
	for (const pair of pairs) next = next.replace(pair.oldText, pair.newText);
	if (Buffer.byteLength(next) > TOOL_WRITE_CAP) {
		throw new ToolRefusalError(await refuse_write_too_large_async(p, TOOL_WRITE_CAP));
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
	if (typeof command !== "string" || !command.trim()) throw new ToolRefusalError('bash requires a "command" string');
	const want = Math.floor(Number(args.timeout ?? BASH_DEFAULT_TIMEOUT_S));
	const timeoutS = Number.isFinite(want) ? Math.min(Math.max(want, 1), BASH_MAX_TIMEOUT_S) : BASH_DEFAULT_TIMEOUT_S;
	const prog = bashProgram(command);
	if (!prog || !BASH_ALLOW.has(prog)) {
		throw new ToolRefusalError(await refuse_bash_blocked_async(command, [...BASH_ALLOW].sort().join(", ")));
	}
	// bi#170: allowlisted commands approve per call on an interactive
	// TTY (session latch skips repeats); headless runs proceed as today.
	if (approvalInteractive && promptAvailable()) {
		const v = await approvalFor("bash", `run: ${command}`);
		if (!v.proceed) throw new ToolRefusalError(v.refusal);
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
		if (err.killed) throw new ToolRefusalError(await refuse_bash_timeout_async(command, timeoutS));
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
	if (typeof p !== "string" || !p) throw new ToolRefusalError('read requires a "path" string');
	const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1);
	const limit = Math.min(Math.max(1, Math.floor(Number(args.limit ?? TOOL_READ_MAX_LINES)) || 1), TOOL_READ_MAX_LINES);
	const abs = await jailResolve(p, (q) => refuse_read_outside_root_async("read", q));
	let buf: Buffer;
	try {
		if (statSync(abs).isDirectory()) throw new ToolRefusalError(`read: "${p}" is a directory — use ls`);
		buf = readFileSync(abs);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("read:")) throw e;
		throw new ToolRefusalError(`read: no such file "${p}" — check the path`);
	}
	if (buf.includes(0)) throw new ToolRefusalError(await refuse_read_binary_async("read", p));
	if (buf.length > TOOL_READ_CAP) throw new ToolRefusalError(await refuse_read_too_large_async("read", p, TOOL_READ_CAP));
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
		if (!statSync(abs).isDirectory()) throw new ToolRefusalError(`ls: "${p}" is not a directory`);
		entries = readdirSync(abs, { withFileTypes: true }).map((d) => ({
			name: d.name,
			kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other",
		} as LsEntry)).sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === "dir" ? -1 : 1));
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("ls:")) throw e;
		throw new ToolRefusalError(`ls: cannot list "${p}" — check the path`);
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
	if (typeof pattern !== "string" || !pattern) throw new ToolRefusalError('grep requires a "pattern" string');
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		throw new ToolRefusalError(`grep: invalid regex "${pattern}"`);
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
	if (typeof pattern !== "string" || !pattern) throw new ToolRefusalError('find requires a "pattern" string');
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
		throw new ToolRefusalError(`meta-tool materialization refused: ${verdict.reason}`);
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
		if (typeof p !== "string" || !p) throw new ToolRefusalError(`${name} requires a "path" string`);
		const abs = guardResolvePath(p);
		const verdict = await write_guard_check_async({
			tool: name,
			path: p,
			target_exists: existsSync(abs),
			read_this_session: session.readMarks.has(abs),
		});
		if (verdict instanceof WriteGuardRefuse) {
			throw new ToolRefusalError(verdict.reason);
		}
	}
	const out = await handleTool(name, args);
	if (name === "read") {
		const p = args.path;
		if (typeof p === "string" && p) session.readMarks.add(guardResolvePath(p));
	}
	return out;
}

// bi#212: BAIS tool-result payload caps. A fresh-session discovery once
// burned ~276k tokens on two pretty-printed full-body results, so:
// bais_list returns ROWS by default (full bodies only via include_bodies
// or a result narrowed to one issue), every bais_* executor emits compact
// JSON, and anything over the byte cap truncates with a notice naming the
// refinement — never silent (bi#55). `unparseable` stays always present
// (the invariant below): rows stay complete, bodies ride bais show.
export const BAIS_TOOL_RESULT_CAP = 60_000;

export type BaisIssueRow = { id: string; status: string; kind: string; title: string; area: string | null };

// Row projection for bais_list: discovery costs rows, not bodies.
export function toBaisIssueRow(f: BaisFile): BaisIssueRow {
	return { id: f.issue.id, status: f.issue.status, kind: f.issue.kind, title: f.issue.title, area: f.issue.area ?? null };
}

// Cap a compact-JSON tool payload: at or under the cap it passes through
// byte-identical; over it the string truncates at the cap with a notice
// naming the refinement (status filter / bais show).
export function capBaisPayload(compact: string, refine: string): string {
	if (Buffer.byteLength(compact) <= BAIS_TOOL_RESULT_CAP) return compact;
	const buf = Buffer.from(compact);
	return buf.subarray(0, BAIS_TOOL_RESULT_CAP).toString("utf8") + `\n…truncated at ${BAIS_TOOL_RESULT_CAP} bytes, refine with ${refine}`;
}

// bi#214: bais_list structured filters (schema keys + query + regexes +
// id ranges). Compiled once per call so an invalid pattern refuses before
// any scan — loud (naming the pattern, bi#55), never a silent empty.
export interface BaisListFilters {
	kind: string | null;
	area: string | null;
	severity: number | null;
	query: string | null;
	titleRe: RegExp | null;
	titlePattern: string | null;
	bodyRe: RegExp | null;
	bodyPattern: string | null;
	idMin: number | null;
	idMax: number | null;
}

function baisListCompile(pattern: string, arg: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch {
		throw new ToolRefusalError(`bais_list: invalid ${arg} ${JSON.stringify(pattern)} — fix the pattern, nothing was filtered`);
	}
}

// Trailing numeric part of an id ("bi#100" -> 100, "bi#hotfix" -> null):
// id_min/id_max bound namespaces ("more than 100, less than 10" style).
// A bound issue without a numeric part cannot satisfy a numeric bound,
// so it does not match while either bound is present.
export function baisIdNumber(id: string): number | null {
	const m = /#(\d+)$/.exec(id);
	return m ? parseInt(m[1], 10) : null;
}

export function baisListFilters(args: Record<string, unknown>): BaisListFilters {
	const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
	const num = (v: unknown): number | null => {
		if (v === undefined || v === null || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	const titlePattern = str(args.title_regex);
	const bodyPattern = str(args.body_regex);
	return {
		kind: str(args.kind),
		area: str(args.area),
		severity: num(args.severity),
		query: str(args.query)?.toLowerCase() ?? null,
		titleRe: titlePattern !== null ? baisListCompile(titlePattern, "title_regex") : null,
		titlePattern,
		bodyRe: bodyPattern !== null ? baisListCompile(bodyPattern, "body_regex") : null,
		bodyPattern,
		idMin: num(args.id_min),
		idMax: num(args.id_max),
	};
}

export function baisListMatches(f: BaisFile, flt: BaisListFilters): boolean {
	const i = f.issue;
	if (flt.kind !== null && i.kind !== flt.kind) return false;
	if (flt.area !== null && (i.area ?? null) !== flt.area) return false;
	if (flt.severity !== null && i.severity !== flt.severity) return false;
	if (flt.query !== null && !`${i.id} ${i.title}`.toLowerCase().includes(flt.query)) return false;
	if (flt.titleRe !== null && !flt.titleRe.test(i.title)) return false;
	if (flt.bodyRe !== null && !flt.bodyRe.test(i.body)) return false;
	if (flt.idMin !== null || flt.idMax !== null) {
		const n = baisIdNumber(i.id);
		if (n === null) return false;
		if (flt.idMin !== null && n < flt.idMin) return false;
		if (flt.idMax !== null && n > flt.idMax) return false;
	}
	return true;
}

// bi#213: bounded graph traversal for the bais_graph TOOL (the CLI keeps
// the unbounded graphBaisIssues in bais.ts — discovery-sized, not
// tool-sized). BFS from `from` over all edge kinds (both directions, same
// reachability), but expansion stops past `depth` hops and collection stops
// at `limit` nodes. `truncated` is true when either bound bit — the tool
// names the refinement (narrower --from, shallower depth), never silent
// (bi#55). Depth 0 is just `from` itself.
export const BAIS_GRAPH_DEFAULT_DEPTH = 3;
export const BAIS_GRAPH_NODE_CAP = 200;

async function graphBaisIssuesBounded(
	fromId: string,
	opts: { depth?: number; limit?: number } = {},
): Promise<{ files: BaisFile[]; truncated: boolean }> {
	const depth = opts.depth ?? BAIS_GRAPH_DEFAULT_DEPTH;
	const limit = opts.limit ?? BAIS_GRAPH_NODE_CAP;
	const { issues } = await loadBaisIssues();
	const edges: BaisEdge[] = issues.flatMap((f) => f.edges);
	const byId = new Map(issues.map((f) => [f.issue.id, f]));
	const seen = new Map<string, number>([[fromId, 0]]);
	const queue = [fromId];
	while (queue.length) {
		const cur = queue.shift()!;
		const d = seen.get(cur)!;
		if (d >= depth) continue;
		for (const e of edges) {
			for (const nxt of e.from === cur ? [e.to] : e.to === cur ? [e.from] : []) {
				if (!seen.has(nxt)) {
					seen.set(nxt, d + 1);
					queue.push(nxt);
				}
			}
		}
	}
	const ids = [...seen.keys()].sort((a, b) => (seen.get(a)! - seen.get(b)!) || (a < b ? -1 : 1));
	const kept = ids.slice(0, limit);
	return {
		files: kept.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
		truncated: kept.length < ids.length,
	};
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
		return capBaisPayload(JSON.stringify(file), "bais show <id>");
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
		return capBaisPayload(JSON.stringify(file), "bais show <id>");
	}
	switch (name) {
		case "bais_list": {
			const status = (args.status as string | undefined) ?? null;
			const includeBodies = args.include_bodies === true;
			const { issues, failures } = await loadBaisIssues();
			// bi#214: structured filters mirroring the TOML schema keys —
			// one discovery tool, not two. All optional and ANDed; rows by
			// default per bi#212, so a search costs rows, never bodies.
			const filters = baisListFilters(args);
			const filtered = issues.filter((f) => (status ? f.issue.status === status : true) && baisListMatches(f, filters));
			// `unparseable` is always present, even when empty: a tool that silently
			// omits files teaches the model the list is complete when it is not.
			// Full records only on demand (include_bodies) or when the result
			// narrows to one issue — its body is the point, not discovery cost.
			const full = includeBodies || filtered.length === 1;
			const payload = full
				? { issues: filtered, unparseable: failures }
				: { issues: filtered.map(toBaisIssueRow), unparseable: failures };
			const refine = status ? "bais show <id>" : "status=<Open|Doing|Blocked|Done|Dropped> or bais show <id>";
			return capBaisPayload(JSON.stringify(payload), refine);
		}
		case "bais_ready": {
			// bi#213: rows by default, bodies on demand — the same shape
			// and rule as bais_list (include_bodies, or a result narrowed
			// to one issue whose body is the point). `unparseable` stays
			// always present (same invariant as the list tool).
			const includeBodies = args.include_bodies === true;
			const files = await readyBaisIssues();
			const { failures } = await loadBaisIssues();
			const full = includeBodies || files.length === 1;
			const payload = full
				? { issues: files, unparseable: failures }
				: { issues: files.map(toBaisIssueRow), unparseable: failures };
			return capBaisPayload(JSON.stringify(payload), "bais show <id>");
		}
		case "bais_new": {
			const title = String(args.title ?? "");
			if (!title) throw new ToolRefusalError("bais_new requires title");
			// bi#215: edges at birth ride `edges: [{kind, to}]`, validated
			// like the CLI inside createBaisIssue (known kind, existing
			// ends, no self-links/dups — a refusal names the reason and
			// nothing reaches disk). Shape-checked here so a malformed
			// entry refuses at the tool boundary, not inside the writer.
			const rawEdges = args.edges ?? [];
			if (!Array.isArray(rawEdges)) throw new ToolRefusalError("bais_new: edges must be [{kind, to}]");
			const edges: { kind: string; to: string }[] = rawEdges.map((e, i) => {
				const r = e as Record<string, unknown>;
				if (typeof r?.kind !== "string" || !r.kind || typeof r?.to !== "string" || !r.to) {
					throw new ToolRefusalError(`bais_new: edges[${i}] needs string kind/to`);
				}
				return { kind: r.kind, to: r.to };
			});
			const file = await createBaisIssue({
				title,
				kind: (args.kind as string | undefined) ?? "Feat",
				area: (args.area as string | undefined) ?? undefined,
				body: (args.body as string | undefined) ?? undefined,
				status: (args.status as string | undefined) ?? "Open",
				edges,
			});
			return capBaisPayload(JSON.stringify(file), "bais show <id>");
		}
		case "bais_move": {
			const id = String(args.id ?? "");
			const status = String(args.status ?? "");
			if (!id || !status) throw new ToolRefusalError("bais_move requires id and status");
			// bi#215: claim-capable move. `as` + `for` mirror the CLI
			// exactly: `for` without `as` is ignored (bare move keeps
			// today's anonymous-but-instantly-stale contract), an invalid
			// `for` refuses loud naming the value.
			const as = typeof args.as === "string" && args.as ? args.as : null;
			const forRaw = typeof args.for === "string" && args.for ? args.for : null;
			let forMs: number | undefined;
			if (forRaw != null) {
				const p = parseClaimDuration(forRaw);
				if (p == null) throw new ToolRefusalError(`bais_move: --for ${JSON.stringify(forRaw)} needs <n>s|m|h|d`);
				forMs = p;
			}
			const file = await moveBaisIssue(id, status, undefined, as != null ? { as, forMs } : undefined);
			return capBaisPayload(JSON.stringify(file), "bais show <id>");
		}
		case "bais_show": {
			// bi#215: the single-issue read path (CLI `bais show` parity).
			// Unknown ids fail closed naming themselves — never an empty
			// render. A single full record carries its body by definition
			// (the bi#212 rows rule is for discovery-sized results).
			const id = String(args.id ?? "");
			if (!id) throw new ToolRefusalError("bais_show requires id");
			const { issues } = await loadBaisIssues();
			const found = issues.find((f) => f.issue.id === id);
			if (!found) throw new ToolRefusalError(`bais_show: unknown issue ${JSON.stringify(id)} — \`bi bais list\` lists ids`);
			return capBaisPayload(JSON.stringify(found), "bais show <id>");
		}
		case "bais_link": {
			// bi#215: link over linkBaisIssues — CLI `bais link` validation
			// (known kind, existing ends, no self-links/dups/cycles) with
			// the same loud refusals, nothing half-written.
			const from = String(args.from ?? "");
			const kind = String(args.kind ?? "");
			const to = String(args.to ?? "");
			if (!from || !kind || !to) throw new ToolRefusalError("bais_link requires from, kind, and to");
			const file = await linkBaisIssues(from, kind, to);
			return capBaisPayload(JSON.stringify(file), "bais show <id>");
		}
		case "bais_renew": {
			// bi#215: heartbeat over renewBaisClaim — only the recorded
			// holder extends a live claim (strangers refuse naming both
			// holders). `for` parses like the CLI; invalid refuses loud.
			const id = String(args.id ?? "");
			const as = String(args.as ?? "");
			if (!id || !as) throw new ToolRefusalError("bais_renew requires id and as");
			const forRaw = typeof args.for === "string" && args.for ? args.for : null;
			let forMs = 4 * 3600000;
			if (forRaw != null) {
				const p = parseClaimDuration(forRaw);
				if (p == null) throw new ToolRefusalError(`bais_renew: --for ${JSON.stringify(forRaw)} needs <n>s|m|h|d`);
				forMs = p;
			}
			const file = await renewBaisClaim(id, as, forMs);
			return capBaisPayload(JSON.stringify(file), "bais show <id>");
		}
		case "bais_reap": {
			// bi#215: reclamation over reapBaisClaims — expired-only, the
			// same lease predicate as the CLI reap. Live claims untouched.
			const reaped = await reapBaisClaims(Date.now());
			return capBaisPayload(JSON.stringify({ reaped }), "bais show <id>");
		}
		case "bais_check": {
			// bi#213: per-file verdict rows, never bodies. `ok` is ids
			// only (bodies ride bais show); `bad`/`dangling`/`cycles`/
			// `evidence` are already body-free. Key order is the safety:
			// failures serialize FIRST and `ok` LAST, so a byte-cap
			// truncation cuts ok ids, never a failure — verdict rows stay
			// complete by construction (a truncated-away failure would be
			// a silent pass, bi#55). Check semantics unchanged — the CLI
			// still reads checkBaisIssues directly.
			const res = await checkBaisIssues();
			const payload = {
				bad: res.bad,
				dangling: res.dangling,
				cycles: res.cycles,
				evidence: res.evidence,
				ok: res.ok.map((f) => f.issue.id),
			};
			return capBaisPayload(JSON.stringify(payload), "bais show <id>");
		}
		case "bais_graph": {
			// bi#213: rows by default (same rule as list/ready), bounded
			// BFS (depth + node cap) with a notice naming the refinement —
			// the old unbounded full-body traversal was the worst dose
			// (~109k tokens from one --from).
			// hub#238: `id` is an alias for `from` (every sibling tool takes
			// `id`, so agents keep passing it). Explicit non-empty `from`
			// wins when both are present; neither refuses naming both
			// spellings (marked refusal, so bi#220 prints message-only).
			const fromArg = typeof args.from === "string" && args.from ? args.from : null;
			const idArg = typeof args.id === "string" && args.id ? args.id : null;
			const from = fromArg ?? idArg ?? "";
			if (!from) throw new ToolRefusalError('bais_graph requires "from" (or "id" as an alias)');
			const wantDepth = Number(args.depth);
			const depth = Number.isFinite(wantDepth) && wantDepth >= 0 ? Math.floor(wantDepth) : BAIS_GRAPH_DEFAULT_DEPTH;
			const includeBodies = args.include_bodies === true;
			const { files, truncated } = await graphBaisIssuesBounded(from, { depth, limit: BAIS_GRAPH_NODE_CAP });
			const full = includeBodies || files.length === 1;
			const payload: Record<string, unknown> = {
				from,
				depth,
				issues: full ? files : files.map(toBaisIssueRow),
				truncated,
			};
			if (truncated) {
				payload.notice = `…truncated at depth ${depth} / ${BAIS_GRAPH_NODE_CAP} nodes — refine with a narrower --from, a shallower depth, or bais show <id> for bodies`;
			}
			return capBaisPayload(
				JSON.stringify(payload),
				"a narrower --from, a shallower depth, or bais show <id>",
			);
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
