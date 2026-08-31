// bi/src/session.ts — host SessionManager + trust (bi/.bi, not .pi)
// BAML owns SessionHeader/create_session_header/validate_session_id, host owns FS.
// Mirrors pi/src/core/session-manager.ts + project-trust.ts (vendor/pi-*.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { validate_session_id, create_session_header, format_project_trust_prompt } from "../baml_sdk/index.js";

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
