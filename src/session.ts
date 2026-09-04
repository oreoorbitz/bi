// bi/src/session.ts — host SessionManager + trust (bi/.bi, not .pi)
// BAML owns SessionHeader/create_session_header/validate_session_id, host owns FS.
// Mirrors pi/src/core/session-manager.ts + project-trust.ts (vendor/pi-*.ts).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { validate_session_id, create_session_header, format_project_trust_prompt, select_valid_history_async } from "../baml_sdk/index.js";

export const BI_SESSION_DIR_ENV = "BI_SESSION_DIR";
export const BI_AGENT_DIR_ENV = "BI_AGENT_DIR";

export function getBiSessionsDir(sessionDirFlag?: string): string {
	if (sessionDirFlag) return resolve(sessionDirFlag);
	if (process.env[BI_SESSION_DIR_ENV]) return resolve(process.env[BI_SESSION_DIR_ENV]!);
	if (process.env[BI_AGENT_DIR_ENV]) return join(resolve(process.env[BI_AGENT_DIR_ENV]!), "sessions");
	return join(homedir(), ".bi", "sessions");
}

export function ensureSessionsDir(dir?: string): string {
	const d = dir ?? getBiSessionsDir();
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	return d;
}

export function formatTrustPrompt(cwd: string): string {
	return format_project_trust_prompt(cwd);
}

export function validateSessionIdOrThrow(id: string): void {
	// BAML is validator — throws InvalidArgument if bad
	validate_session_id(id);
}

export function newSessionId(): string {
	return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

export function createSessionFile(opts: { id?: string; cwd?: string; parentSession?: string; sessionDir?: string }): string {
	const dir = ensureSessionsDir(opts.sessionDir);
	const id = opts.id ?? newSessionId();
	validateSessionIdOrThrow(id);
	const cwd = opts.cwd ?? process.cwd();
	const timestamp = new Date().toISOString();
	const header = create_session_header(id, cwd, timestamp, { parent_session: opts.parentSession ?? null });
	const file = join(dir, `${id}.jsonl`);
	// pi writes JSONL with header as first line; keep same for bi
	writeFileSync(file, JSON.stringify(header) + "\n");
	return file;
}

export function listSessions(sessionDir?: string): string[] {
	const dir = getBiSessionsDir(sessionDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => f.replace(/\.jsonl$/, ""))
		.sort();
}

export function findMostRecentSession(sessionDir?: string): string | null {
	const ids = listSessions(sessionDir);
	if (ids.length === 0) return null;
	// newest by mtime — simple: last sorted id (pi uses timestamp header; we use id sort for now)
	return ids[ids.length - 1];
}

export function sessionIdFromFile(file: string): string {
	const base = basename(file);
	return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

// bi#30: transcript persistence. Session files are JSONL (header + one
// history line per message); BAML owns the HistoryEntry schema +
// validation, the host owns JSON encode/decode + FS. Append failures
// warn but never break the REPL — memory stays authoritative.
export interface SessionHistoryLine {
	role: string;
	text: string;
	provider?: string | null;
	model?: string | null;
	thinking?: string | null;
}

export function appendSessionEntries(file: string, entries: SessionHistoryLine[]): void {
	if (!entries.length) return;
	try {
		const lines = entries.map((e) =>
			JSON.stringify({ type: "history", role: e.role, text: e.text ?? "", provider: e.provider ?? null, model: e.model ?? null, thinking: e.thinking ?? null }),
		);
		appendFileSync(file, lines.join("\n") + "\n");
	} catch (e) {
		console.error(`[bi] session persist failed (${e instanceof Error ? e.message : e}) — transcript kept in memory`);
	}
}

export interface LoadedSession {
	file: string;
	header: { id: string; timestamp: string; cwd: string; parent_session: string | null };
	history: { role: string; text: string }[];
}

export async function loadSessionTranscript(id: string, sessionDir?: string): Promise<LoadedSession | null> {
	const file = join(getBiSessionsDir(sessionDir), `${id}.jsonl`);
	if (!existsSync(file)) return null;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (!lines.length) return null;
	let header: LoadedSession["header"];
	try {
		const h = JSON.parse(lines[0]);
		header = { id: String(h.id ?? id), timestamp: String(h.timestamp ?? ""), cwd: String(h.cwd ?? ""), parent_session: h.parent_session ?? null };
	} catch {
		return null;
	}
	const parsed: any[] = [];
	for (const line of lines.slice(1)) {
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// corrupt line — BAML filtering below drops what it can, but
			// unparseable JSON never even reaches it (never fatal).
		}
	}
	const valid = await select_valid_history_async(parsed);
	return { file, header, history: valid.map((e: any) => ({ role: String(e.role), text: String(e.text) })) };
}

// Resume-list rows: header metadata + user-turn count per file.
export async function sessionResumeList(sessionDir?: string): Promise<{ id: string; timestamp: string; cwd: string; turns: number }[]> {
	const out: { id: string; timestamp: string; cwd: string; turns: number }[] = [];
	for (const id of listSessions(sessionDir)) {
		const loaded = await loadSessionTranscript(id, sessionDir);
		if (!loaded) continue;
		const turns = loaded.history.filter((m) => m.role === "user").length;
		out.push({ id: loaded.header.id, timestamp: loaded.header.timestamp, cwd: loaded.header.cwd, turns });
	}
	return out;
}
