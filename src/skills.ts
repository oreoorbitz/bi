// bi/src/skills.ts — host side of skills + slash commands (bi#12).
//
// Split per bi's rule: BAML (skills.baml) owns REGISTRY rules — name/
// description validation, XML prompt format, slash lookup. This file owns
// DISCOVERY (SKILL.md scan, frontmatter parse) and CONTENT (skill bodies).
// Dispatch lives in cli.ts (interactive /slash); prompt injection in run.
//
// Discovery mirrors pi's rules minus the `ignore` dep: a dir containing
// SKILL.md is a skill root (no deeper recursion); otherwise load direct .md
// children at the root and recurse into subdirectories; skip dotfiles and
// node_modules. Name defaults to the parent dir, description is required,
// validation warnings never block (except a missing description, per pi).
// Slash dispatch DECISIONS also live here (resolveSlash, BAML-backed);
// cli.ts keeps only the effects (print, exit, run prompt).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	builtin_slash_commands_async,
	format_skills_for_prompt_async,
	lookup_slash_async,
	validate_skill_description_async,
	validate_skill_name_async,
	type Skill,
} from "../baml_sdk/index.js";

export type { Skill };
export type SkillDiagnostic = { file: string; message: string };

export function skillDirs(cwd = process.cwd()): string[] {
	return [join(cwd, ".bi", "skills"), join(homedir(), ".bi", "skills")];
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { frontmatter: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: raw };
	const fm: Record<string, unknown> = {};
	for (const line of raw.slice(4, end).split("\n")) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (m) {
			const v = m[2].trim();
			fm[m[1]] = v === "true" ? true : v === "false" ? false : v.replace(/^["']|["']$/g, "");
		}
	}
	return { frontmatter: fm, body: raw.slice(end + 4).replace(/^\r?\n/, "") };
}

async function loadSkillFile(filePath: string, diagnostics: SkillDiagnostic[]): Promise<Skill | null> {
	const isDeclared = basename(filePath) === "SKILL.md";
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (e: any) {
		if (isDeclared) diagnostics.push({ file: filePath, message: String(e?.message ?? e).split("\n")[0] });
		return null;
	}
	const { frontmatter } = parseFrontmatter(raw);
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!isDeclared && description.trim() === "") return null;
	for (const w of await validate_skill_description_async(description)) diagnostics.push({ file: filePath, message: w });
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : basename(dirname(filePath));
	for (const w of await validate_skill_name_async(name)) diagnostics.push({ file: filePath, message: w });
	if (description.trim() === "") return null;
	return { name, description, file_path: filePath, disable_model_invocation: frontmatter["disable-model-invocation"] === true };
}

function scanDir(dir: string, includeRootFiles: boolean, out: string[]): void {
	if (!existsSync(dir)) return;
	let entries: any[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name !== "SKILL.md") continue;
		const full = join(dir, e.name);
		if (!e.isFile()) continue;
		out.push(full);
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			scanDir(full, false, out);
		} else if (includeRootFiles && e.isFile() && e.name.endsWith(".md")) {
			out.push(full);
		}
	}
}

export async function loadSkills(dirs = skillDirs()): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	const found: string[] = [];
	for (const d of dirs) scanDir(d, true, found);
	// Dedupe by name with dir priority: project dirs come first, so the first
	// valid skill of a given name wins (mirrors pi's source precedence).
	const out: Skill[] = [];
	const seen = new Set<string>();
	for (const filePath of found) {
		const s = await loadSkillFile(filePath, diagnostics);
		if (s && !seen.has(s.name)) {
			seen.add(s.name);
			out.push(s);
		}
	}
	return { skills: out, diagnostics };
}

export async function formatSkills(skills: Skill[]): Promise<string> {
	return format_skills_for_prompt_async(skills as any);
}

// Skill body for /slash expansion: frontmatter stripped, content verbatim.
export function skillBody(skill: Skill): string {
	return parseFrontmatter(readFileSync(skill.file_path, "utf8")).body;
}

export type SlashTarget =
	| { kind: "none" }
	| { kind: "unknown"; word: string }
	| { kind: "builtin"; name: string; args: string; scope: string | null }
	| { kind: "skill"; skill: Skill; args: string };

// Pure split of a raw input line into slash word + trailing args.
// Null when the line is not a slash command.
export function parseSlash(line: string): { word: string; args: string } | null {
	if (!line.startsWith("/")) return null;
	const word = line.split(/\s+/)[0].slice(1);
	return { word, args: line.slice(word.length + 2).trim() };
}

// Slash dispatch decision (BAML-backed, no side effects): lookup_slash owns
// word matching, builtin_slash_commands owns which names are builtins —
// no hardcoded command list on the host side.
export async function resolveSlash(line: string, skills: Skill[]): Promise<SlashTarget> {
	const p = parseSlash(line);
	if (!p) return { kind: "none" };
	const hit = await lookup_slash_async(p.word, skills as any);
	if (!hit) return { kind: "unknown", word: p.word };
	const builtins = await builtin_slash_commands_async();
	const record = builtins.find((b) => b.name === hit);
	if (record) return { kind: "builtin", name: hit, args: p.args, scope: record.scope ?? null };
	const skill = skills.find((s) => s.name === hit);
	return skill ? { kind: "skill", skill, args: p.args } : { kind: "unknown", word: p.word };
}
