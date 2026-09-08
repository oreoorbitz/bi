// bi/src/keybindings.ts — user-editable keybindings file + manager (bi#91).
//
// Key parsing lives in pi-tui (`matchesKey` idiom, consumed via
// `KeybindingsManager`); this module owns FILE IO and the manager surface
// only: `~/.bi/keybindings.json` (`{ "<tui.*|bi.* id>": "<key>" | [...] }`,
// same shape as pi's file), BAML-validated on every load (unknown ids and
// bad key names fail LOUDLY on stderr — pi-tui would silently skip them),
// and a cached override set that `prompt.ts` feeds into every modal via
// `currentKeybindingsManager()` (library + bi-owned ids). Persistence
// across restarts is the file;
// `/reload` re-reads it live.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	KeybindingsManager,
	matchesKey,
	TUI_KEYBINDINGS,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
} from "@earendil-works/pi-tui";
import {
	format_keybinding_rows_async,
	keybinding_rows_async,
	validate_keybinding_entries_async,
} from "../baml_sdk/index.js";

export interface KeybindingFileEntry {
	id: string;
	keys: string[];
}

export interface KeybindingLoad {
	entries: KeybindingFileEntry[];
	// Structural file problems (bad JSON, non-object top level, non-string
	// values) — reported before BAML validation even runs.
	fileErrors: string[];
}

export function getKeybindingsPath(): string {
	return join(homedir(), ".bi", "keybindings.json");
}

// bi#156: bi-owned action ids, registered alongside TUI_KEYBINDINGS when
// building the manager — pi's own extension pattern
// (pi/packages/coding-agent/src/core/keybindings.ts: `declare module`
// merging + `{...TUI_KEYBINDINGS, ...}` spread), one id not forty. The
// manager is the live matching path (`prompt.ts` looks the id up per
// keystroke); the BAML table owns validation + listing for the same id.
export interface BiKeybindings {
	"bi.model.cycleForward": true;
}

declare module "@earendil-works/pi-tui" {
	interface Keybindings extends BiKeybindings {}
}

// pi's `app.model.cycleForward` default + description verbatim
// (pi/packages/coding-agent keybindings.ts: ctrl+p / "Cycle to next model").
export const BI_KEYBINDINGS: KeybindingDefinitions = {
	"bi.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
};

export const ALL_KEYBINDINGS: KeybindingDefinitions = { ...TUI_KEYBINDINGS, ...BI_KEYBINDINGS };

// bi#90 legacy: the hardcoded default + matcher the manager supersedes.
// Kept for import compat only — `prompt.ts` matches through the manager
// so keybindings.json can remap the id.
export const MODEL_CYCLE_FORWARD_DEFAULT = "ctrl+p";

export function matchesModelCycleForward(data: string): boolean {
	return matchesKey(data, MODEL_CYCLE_FORWARD_DEFAULT);
}

// Read + JSON-shape the file. Returns entries plus structural errors; BAML
// owns id/key-name validation (see validateKeybindings).
export function loadKeybindingsFile(path: string = getKeybindingsPath()): KeybindingLoad {
	if (!existsSync(path)) return { entries: [], fileErrors: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
	} catch (e) {
		return { entries: [], fileErrors: [`${path}: invalid JSON (${e instanceof Error ? e.message : e})`] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { entries: [], fileErrors: [`${path}: top level must be an object of id to key name(s)`] };
	}
	const entries: KeybindingFileEntry[] = [];
	const fileErrors: string[] = [];
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string") entries.push({ id, keys: [value] });
		else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
			entries.push({ id, keys: value as string[] });
		} else {
			fileErrors.push(`${path}: "${id}" must be a key name or an array of key names`);
		}
	}
	return { entries, fileErrors };
}

export interface ValidatedKeybindings {
	config: KeybindingsConfig;
	errors: string[];
}

// Full load: file shape + BAML validation. Invalid entries are DROPPED
// (never reach the manager) and every problem lands in `errors` for loud
// reporting — the valid subset still applies.
export async function validateKeybindings(path: string = getKeybindingsPath()): Promise<ValidatedKeybindings> {
	const { entries, fileErrors } = loadKeybindingsFile(path);
	const errors = [...fileErrors];
	if (entries.length === 0) return { config: {}, errors };
	const v = await validate_keybinding_entries_async(entries);
	const config: KeybindingsConfig = {};
	// Cast is the FFI seam: BAML `key_id_valid` already proved every key
	// against the KeyId grammar; TS cannot see that proof.
	for (const b of v.valid) config[b.id] = [...b.keys] as KeyId[];
	for (const e of v.errors) errors.push(`unknown or invalid keybinding "${e.id}": ${e.reason} (see \`bi keybindings list\`)`);
	return { config, errors };
}

let cached: KeybindingsConfig | null = null;

export function getUserKeybindings(): KeybindingsConfig {
	return cached ?? {};
}

// Refresh the cache from disk (startup + `/reload` + after every manager
// write). Reports loudly; keeps the previous cache when the file is bad?
// No — applies the valid subset and reports, so a fixed file recovers on
// the next reload without restarting.
export async function reloadKeybindings(path: string = getKeybindingsPath()): Promise<{ applied: number; errors: string[] }> {
	const { config, errors } = await validateKeybindings(path);
	cached = config;
	// Loud on problems only — callers (/reload, startup, manager) print
	// their own summary so a clean empty file stays silent.
	for (const e of errors) console.error(`[keybindings] ${e}`);
	return { applied: Object.keys(config).length, errors };
}

// What `prompt.ts runModal` installs per modal: library defaults plus
// bi-owned ids plus the user's validated overrides. Never subclasses input
// handling — the manager IS the library's matching (`kb.matches`,
// `matchesKey`).
export function currentKeybindingsManager(): KeybindingsManager {
	return new KeybindingsManager(ALL_KEYBINDINGS, getUserKeybindings());
}

// Persist entries (ordered: known ids in library order, extras sorted —
// pi's `orderKeybindingsConfig` shape) and refresh the cache.
export async function saveKeybindings(entries: KeybindingFileEntry[], path: string = getKeybindingsPath()): Promise<void> {
	const v = await validate_keybinding_entries_async(entries);
	if (v.errors.length > 0) {
		throw new Error(v.errors.map((e) => `"${e.id}": ${e.reason}`).join("; "));
	}
	const ordered: Record<string, string | string[]> = {};
	for (const id of Object.keys(ALL_KEYBINDINGS)) {
		const hit = entries.find((e) => e.id === id);
		if (hit) ordered[id] = hit.keys.length === 1 ? hit.keys[0] : [...hit.keys];
	}
	for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		if (!(e.id in ordered)) ordered[e.id] = e.keys.length === 1 ? e.keys[0] : [...e.keys];
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`);
	cached = {};
	for (const b of v.valid) cached[b.id] = [...b.keys] as KeyId[];
}

export function resetKeybindings(path: string = getKeybindingsPath()): boolean {
	if (!existsSync(path)) return false;
	unlinkSync(path);
	cached = {};
	return true;
}

export async function renderKeybindingList(path: string = getKeybindingsPath()): Promise<{ text: string; errors: string[] }> {
	const { entries, fileErrors } = loadKeybindingsFile(path);
	const rows = await keybinding_rows_async(entries);
	return { text: await format_keybinding_rows_async(rows), errors: [...fileErrors] };
}

export interface KeybindingRowData {
	id: string;
	description: string;
	default_keys: string[];
	current_keys: string[];
	overridden: boolean;
}

export async function listKeybindingRows(path: string = getKeybindingsPath()): Promise<{ rows: KeybindingRowData[]; errors: string[] }> {
	const { entries, fileErrors } = loadKeybindingsFile(path);
	const rows = await keybinding_rows_async(entries);
	return { rows, errors: [...fileErrors] };
}

export async function renderKeybindingJson(path: string = getKeybindingsPath()): Promise<unknown> {
	const { entries, fileErrors } = loadKeybindingsFile(path);
	const [rows, validation] = await Promise.all([
		keybinding_rows_async(entries),
		validate_keybinding_entries_async(entries),
	]);
	return {
		bindings: rows,
		errors: [...fileErrors, ...validation.errors.map((e) => `${e.id}: ${e.reason}`)],
		path,
	};
}
