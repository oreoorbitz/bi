// bi/src/trust.ts — project trust store (bi#29).
// BAML owns the decision vocabulary (parse_trust_answer) + status text;
// the host owns ~/.bi/trust.json FS. allow/deny persist per absolute
// directory; session-only lives in memory; absent is undecided.
// Enforcement: project skill dirs (<cwd>/.bi/skills) load only when the
// effective decision is allow or session — deny skips them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBiSessionsDir } from "./session.js";

export type StoredTrust = "allow" | "deny";
export type TrustDecision = StoredTrust | "session";

function trustFile(): string {
	return join(dirname(getBiSessionsDir()), "trust.json");
}

function readStore(): Record<string, string> {
	try {
		if (!existsSync(trustFile())) return {};
		const raw = JSON.parse(readFileSync(trustFile(), "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
		return {};
	} catch {
		return {};
	}
}

export function getStoredTrust(cwd: string): StoredTrust | null {
	const v = readStore()[cwd];
	return v === "allow" || v === "deny" ? v : null;
}

export function setStoredTrust(cwd: string, decision: StoredTrust): void {
	const store = readStore();
	store[cwd] = decision;
	mkdirSync(dirname(trustFile()), { recursive: true });
	writeFileSync(trustFile(), JSON.stringify(store, null, 2) + "\n");
}

export function forgetStoredTrust(cwd: string): boolean {
	const store = readStore();
	if (!(cwd in store)) return false;
	delete store[cwd];
	mkdirSync(dirname(trustFile()), { recursive: true });
	writeFileSync(trustFile(), JSON.stringify(store, null, 2) + "\n");
	return true;
}
