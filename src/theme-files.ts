// bi/src/theme-files.ts — custom theme files (bi#105).
//
// Pi themes are JSON files (theme/dark.json, light.json, plus a custom
// themes dir) validated against theme-schema.json and picked through
// theme-selector.ts with live preview (onSelectionChange → preview).
// Bi ports the shape reduced to its six roles:
//
//   {"name": "...", "description": "...",
//    "accent": "#268bd2"|"", "dim": ..., "good": ..., "bad": ...,
//    "busy": ..., "brand": ...}
//
// A role spec is "" (terminal default) or a #RRGGBB hex color. BAML
// owns the schema (validate_theme_file → row-level refusal reasons,
// preview_custom_theme, format_custom_theme_rows); the host owns FS
// (dirs, read, JSON.parse) + spec→ANSI conversion + the merged
// list/preview/commit paths in cli.ts.
//
// SCOPE NOTE: a committed custom theme persists by name and previews
// in full color, but block chrome (BAML format fns take a builtin
// theme NAME) still resolves it to plain — same degrade path as an
// unknown name. Full custom-palette rendering needs dynamic palettes
// (a follow-up); this issue is validate + preview-before-commit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	format_custom_theme_rows_async,
	format_theme_list_async,
	preview_custom_theme_async,
	theme_preview_async,
	validate_chrome_tokens_async,
	validate_theme_file_async,
} from "../baml_sdk/index.js";
import { getBiSessionsDir } from "./session.js";

export const BUILTIN_THEME_NAMES = ["default", "light", "none"];

export type ThemeRole = "accent" | "dim" | "good" | "bad" | "busy" | "brand";
export const THEME_ROLES: ThemeRole[] = ["accent", "dim", "good", "bad", "busy", "brand"];

export interface CustomTheme {
	name: string;
	description: string;
	specs: Record<ThemeRole, string>;
	path: string;
}

// Custom files live next to theme.json (~/.bi/themes/*.json), mirroring
// pi's custom themes dir. Missing dir = no customs, never an error.
export function customThemesDir(): string {
	return join(dirname(getBiSessionsDir()), "themes");
}

// Validated-spec → FG ANSI (truecolor, pi's fgAnsi shape). Only called
// after BAML validation; anything else degrades to "" (plain).
export function hexSpecToAnsi(spec: string): string {
	if (spec === "") return "";
	const m = /^#([0-9a-fA-F]{6})$/.exec(spec);
	if (!m) return "";
	const hex = m[1]!;
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function firstLine(e: unknown): string {
	return String(e instanceof Error ? e.message : e).split("\n")[0];
}

function asRecord(json: unknown): Record<string, unknown> | null {
	return typeof json === "object" && json !== null && !Array.isArray(json)
		? (json as Record<string, unknown>)
		: null;
}

// One file → validated theme or row-level refusal reasons. Host-side
// reasons cover what BAML cannot receive (unreadable file, non-JSON,
// non-object, non-string fields); BAML owns the schema itself.
export async function validateCustomFile(path: string): Promise<{ theme: CustomTheme } | { reasons: string[] }> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		return { reasons: [`${path}: unreadable (${firstLine(e)})`] };
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		return { reasons: [`${path}: not JSON (${firstLine(e)})`] };
	}
	const obj = asRecord(json);
	if (!obj) return { reasons: [`${path}: theme must be a JSON object`] };
	const typeReasons: string[] = [];
	const str = (key: string): string => {
		const v = obj[key];
		if (v === undefined) return "";
		if (typeof v !== "string") {
			typeReasons.push(`${key}: expected a string, got ${Array.isArray(v) ? "array" : typeof v}`);
			return "";
		}
		return v;
	};
	const name = str("name");
	const description = str("description");
	const specs = {} as Record<ThemeRole, string>;
	for (const role of THEME_ROLES) specs[role] = str(role);
	const schemaReasons = (await validate_theme_file_async(
		name,
		description,
		specs.accent,
		specs.dim,
		specs.good,
		specs.bad,
		specs.busy,
		specs.brand,
	)) as string[];
	const reasons = [...typeReasons, ...schemaReasons];
	if (reasons.length > 0) return { reasons: reasons.map((r) => `${path}: ${r}`) };
	return { theme: { name, description, specs, path } };
}

// Valid customs only, sorted by name (pi's getAvailableThemesWithPaths
// shape). Invalid files are ignored HERE and refused loudly at use
// (saveTheme prints their row-level reasons) — same split as pi, whose
// resource loader reports them during startup/reload.
export async function listCustomThemes(): Promise<CustomTheme[]> {
	const dir = customThemesDir();
	if (!existsSync(dir)) return [];
	const out: CustomTheme[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const loaded = await validateCustomFile(join(dir, file));
		if ("theme" in loaded) {
			// First file wins on duplicate names (pi's seen-set).
			if (!out.some((t) => t.name === loaded.theme.name)) out.push(loaded.theme);
		}
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

export async function customThemeNames(): Promise<string[]> {
	return (await listCustomThemes()).map((t) => t.name);
}

export async function allThemeNames(): Promise<string[]> {
	return [...BUILTIN_THEME_NAMES, ...(await customThemeNames())];
}

export function customCodesToAnsi(theme: CustomTheme): Record<ThemeRole, string> {
	const out = {} as Record<ThemeRole, string>;
	for (const role of THEME_ROLES) out[role] = hexSpecToAnsi(theme.specs[role]);
	return out;
}

// Live preview for one name: builtins through theme_preview, customs
// through preview_custom_theme over host-converted codes. Null = the
// name resolves nowhere (caller prints the not-found hint).
export async function previewForTheme(name: string): Promise<string | null> {
	if ((BUILTIN_THEME_NAMES as string[]).includes(name)) {
		return `${name}:\n${await theme_preview_async(name)}`;
	}
	for (const theme of await listCustomThemes()) {
		if (theme.name !== name) continue;
		const codes = customCodesToAnsi(theme);
		const body = await preview_custom_theme_async(
			codes.accent,
			codes.dim,
			codes.good,
			codes.bad,
			codes.busy,
			codes.brand,
		);
		return `${name}:\n${body}`;
	}
	return null;
}

// Merged listing: builtins (BAML) + custom rows (BAML). No customs →
// the builtin block alone, byte-identical to today's pipe output.
export async function mergedThemeList(current: string): Promise<string> {
	const base = await format_theme_list_async(current);
	const customs = await listCustomThemes();
	if (customs.length === 0) return base;
	return base + (await format_custom_theme_rows_async(
		customs.map((t) => t.name),
		customs.map((t) => t.description),
		current,
	));
}

// ---------------------------------------------------------------------------
// bi#185: chrome palette tokens (text / text_dim / text_muted / primary /
// border), kimi colors.ts:17-134 mirror, hex-tokens-only.
//
// Render-time access, no cached chalk: chromeAnsi converts a token's hex
// to a truecolor SGR at call time. BI_THEME selects the palette ("dark"
// default, "none" = escape-free chrome; "light" is reserved and currently
// rides the dark tokens with a named warning); NO_COLOR suppresses like
// the six-role theme path. An optional override file
// ~/.bi/chrome-palette.json ({"text": "#…", …}, partial merges over the
// dark defaults) is loaded + validated through BAML; bad rows are LOUD
// named warnings and the palette resets to defaults (warn-first, never
// fail-closed — bi#55). Callers gate on TTY, so pipes stay escape-free.

export type ChromeTokenName = "text" | "text_dim" | "text_muted" | "primary" | "border";
export const CHROME_TOKEN_NAMES: ChromeTokenName[] = ["text", "text_dim", "text_muted", "primary", "border"];
export type ChromeTokens = Record<ChromeTokenName, string>;

// Mirror of theme.baml chrome_palettes()["dark"] — pinned equal to the
// BAML data by scripts/theme-chrome.mjs (one-test→one-impl tracer).
export const DEFAULT_CHROME_TOKENS: ChromeTokens = {
	text: "#E0E0E0",
	text_dim: "#888888",
	text_muted: "#6B6B6B",
	primary: "#4FA8FF",
	border: "#5A5A5A",
};

let currentChromeTokens: ChromeTokens = { ...DEFAULT_CHROME_TOKENS };

export function chromeTokens(): ChromeTokens {
	return { ...currentChromeTokens };
}

// Suppression check + BI_THEME resolution. Unknown values warn ONCE with
// the setting named and fall back to dark (warn-first for the new gate).
let themeWarned = false;
export function chromeSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_COLOR != null) return true;
	const setting = env.BI_THEME ?? "dark";
	if (setting === "none") return true;
	if (setting === "light" && !themeWarned) {
		themeWarned = true;
		console.error('[bi] BI_THEME="light" has no chrome palette yet — using dark tokens');
	}
	if (setting !== "dark" && setting !== "light" && !themeWarned) {
		themeWarned = true;
		console.error(`[bi] BI_THEME="${setting}" is not a chrome palette (dark|light|none) — using dark`);
	}
	return false;
}

// Render-time token → truecolor SGR. "" when suppressed or the token
// holds no valid hex (styling degrades to plain, never broken escapes).
export function chromeAnsi(token: ChromeTokenName, env: NodeJS.ProcessEnv = process.env): string {
	if (chromeSuppressed(env)) return "";
	return hexSpecToAnsi(currentChromeTokens[token] ?? "");
}

export function chromePalettePath(): string {
	return join(dirname(getBiSessionsDir()), "chrome-palette.json");
}

// Load + validate the override file through the BAML schema. Missing
// file = keep current tokens, silent. Any bad row warns LOUDLY with the
// token named and the palette RESETS to the dark defaults — a bad
// palette file never bricks chrome and never half-applies (bi#55).
export async function loadChromePalette(
	path: string = chromePalettePath(),
	warn: (msg: string) => void = (m) => console.error(`[bi] ${m}`),
): Promise<ChromeTokens> {
	if (!existsSync(path)) return chromeTokens();
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		currentChromeTokens = { ...DEFAULT_CHROME_TOKENS };
		warn(`chrome palette ${path}: not JSON (${firstLine(e)}) — using defaults`);
		return chromeTokens();
	}
	const obj = asRecord(json);
	if (!obj) {
		currentChromeTokens = { ...DEFAULT_CHROME_TOKENS };
		warn(`chrome palette ${path}: must be a JSON object — using defaults`);
		return chromeTokens();
	}
	const merged: ChromeTokens = { ...DEFAULT_CHROME_TOKENS };
	const typeReasons: string[] = [];
	for (const token of CHROME_TOKEN_NAMES) {
		const v = obj[token];
		if (v === undefined) continue;
		if (typeof v !== "string") {
			typeReasons.push(`${token}: expected a string, got ${Array.isArray(v) ? "array" : typeof v}`);
			continue;
		}
		merged[token] = v;
	}
	const schemaReasons = (await validate_chrome_tokens_async(
		merged.text,
		merged.text_dim,
		merged.text_muted,
		merged.primary,
		merged.border,
	)) as string[];
	const reasons = [...typeReasons, ...schemaReasons];
	if (reasons.length > 0) {
		currentChromeTokens = { ...DEFAULT_CHROME_TOKENS };
		for (const r of reasons) warn(`chrome palette ${path}: ${r} — using defaults`);
		return chromeTokens();
	}
	currentChromeTokens = merged;
	return chromeTokens();
}
