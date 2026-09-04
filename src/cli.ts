#!/usr/bin/env node
// bi CLI — minimal pi fork entry point (Orion's first name is Orion, CLI is `bi`).
// Commands mirror pi's provider/model surface that bi actually ports:
//   bi list-providers | list-models [--provider id] | get-model <id> | run <prompt>
// No external deps — uses bi's own provider/models/agent BAML port.

import { getModel, listAllModels, listModels } from "./models.js";
import { getProvider, listProviders } from "./provider.js";
import { runAgent } from "./agent.js";
import { HttpKeeperHub, LeaseKeeper } from "./keeper.js";
import { HubSubscriber } from "./notify.js";
import { loadBaisIssues, readyBaisIssues, filterReadyIssues, createBaisIssue, moveBaisIssue, checkBaisIssues, graphBaisIssues } from "./bais.js";
import { listTools, handleTool } from "./tools.js";
import { listImageModels } from "./image.js";
import { runAuthStatus, runLogin, runLogout } from "./auth_cli.js";
import { parse_args, format_help, is_valid_thinking_level, builtin_slash_commands_async, hotkeys_text_async, format_model_list_async, format_thinking_list_async, format_repl_footer_async, resolve_model_ref_async, format_session_info_async, format_resume_list_async, render_markdown_text_async, format_tool_start_async, format_tool_done_async, get_theme_async, format_theme_list_async, theme_preview_async, format_settings_list_async, validate_settings_async, is_setting_key_async, resolve_backend_async, format_tree_async, tree_skip_names_async, format_attachment_async, GuidanceFor_async } from "../baml_sdk/index.js";
import { loadSkills, formatSkills, skillBody, resolveSlash, type Skill } from "./skills.js";
import { runResultToJsonLines, finalText } from "./events.js";
import { getBiSessionsDir, createSessionFile, listSessions, findMostRecentSession, validateSessionIdOrThrow, appendSessionEntries, loadSessionTranscript, sessionResumeList, sessionIdFromFile } from "./session.js";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

// REPL input history (~/.bi/history, next to the sessions dir). One line
// per entry, oldest-first on disk; readline wants most-recent-first live.
function historyFile(): string {
	return join(dirname(getBiSessionsDir()), "history");
}

function readHistoryFile(file: string): string[] {
	try {
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
		return lines.slice(-200);
	} catch { return []; }
}

function writeHistoryFile(file: string, oldestFirst: string[]): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, oldestFirst.slice(-200).join("\n") + "\n");
	} catch {}
}

// bi#33: active theme (~/.bi/theme.json, next to history). BAML owns the
// palettes; the host owns WHEN styling applies — TTY stdout only, with
// NO_COLOR respected. Pipes, tests, and json mode resolve null, which
// renders byte-identical plain text.
function themeFile(): string {
	return join(dirname(getBiSessionsDir()), "theme.json");
}

async function readActiveTheme(): Promise<string> {
	try {
		if (!existsSync(themeFile())) return "default";
		const raw = JSON.parse(readFileSync(themeFile(), "utf8"));
		const name = typeof raw?.name === "string" ? raw.name : "default";
		return (await get_theme_async(name)) ? name : "default";
	} catch {
		return "default";
	}
}

async function activeTheme(): Promise<string | null> {
	if (!process.stdout.isTTY || process.env.NO_COLOR != null) return null;
	return readActiveTheme();
}

// bi#29: user settings (~/.bi/settings.json). Three backend-default keys
// in v1; BAML owns schema + validation + precedence, host owns FS.
// Unknown keys on disk are ignored (forward-compatible); a corrupt file
// resolves empty with a warning instead of bricking startup.
export interface UserSettings {
	default_provider?: string;
	default_model?: string;
	default_thinking?: string;
}

function settingsFile(): string {
	return join(dirname(getBiSessionsDir()), "settings.json");
}

export function loadUserSettings(): UserSettings {
	try {
		if (!existsSync(settingsFile())) return {};
		const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
		const out: UserSettings = {};
		if (typeof raw?.default_provider === "string") out.default_provider = raw.default_provider;
		if (typeof raw?.default_model === "string") out.default_model = raw.default_model;
		if (typeof raw?.default_thinking === "string") out.default_thinking = raw.default_thinking;
		return out;
	} catch {
		console.error("[bi] settings file unreadable — using builtins (`/settings` to repair)");
		return {};
	}
}

function saveUserSettings(s: UserSettings): void {
	mkdirSync(dirname(settingsFile()), { recursive: true });
	writeFileSync(settingsFile(), JSON.stringify(s, null, 2) + "\n");
}

// The SDK's UserSettings is null-based; the host's is undefined-based.
function bamlSettings(s: UserSettings): { default_provider: string | null; default_model: string | null; default_thinking: string | null } {
	return { default_provider: s.default_provider ?? null, default_model: s.default_model ?? null, default_thinking: s.default_thinking ?? null };
}

// BAML VM errors arrive as "baml error: baml.errors.Kind: message" —
// strip the wrapper so users see the policy message BAML wrote.
function bamlErrorMessage(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return raw.replace(/^baml error: (baml\.errors\.\w+: )?/, "").split("\n")[0];
}
import { HostTui, HostStatus, renderReadyScreen } from "./tui.js";
import { format_status, format_turn_summary } from "../baml_sdk/index.js";
import { runBiLoop } from "./agent_loop.js";
import { editInExternalEditor, editorCommand } from "./editor.js";

function printHelp(): void {
	// BAML is spec: format_help() is bi-renamed pi help (APP_NAME bi, .bi)
	// Keep TS help in sync — if it diverges, BAML is truth.
	console.log(format_help());
	console.log(`\nBi extensions (BAML-owns-LLM, .bais is first-class):
  bi list-providers
  bi list-models [--provider <id>]
  bi list-image-models [--provider <id>]
  bi get-model <id>
  bi login [provider] [--oauth]
  bi logout <provider>
  bi auth status
  bi run <prompt> [--provider <id>] [--model <id>] [--api-key <key>] [--base-url <url>] [--temperature <n>] [--max-turns <n>]
                   [--azure-resource <r> --azure-deployment <d> [--azure-api-version <v>]]
  bi bais list [--json]
  bi bais ready [--json]
  bi bais new "title" --kind <Kind> [--area <area>] [--status <Status>] [--body <md>]
  bi bais move <id> <Status>
  bi bais check [--json]
  bi bais graph --from <id> [--json]
`);
}

function getFlag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
	if (name.startsWith("--")) {
		const eq = args.find((a) => a.startsWith(`${name}=`));
		if (eq) return eq.slice(name.length + 1);
	}
	return undefined;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

// Unparseable .bais files no longer masquerade as issues (see loadBaisIssues),
// so a bad file simply drops out of list/ready. Say so on stderr — a silently
// short list is the failure mode we traded the fabrication for, and it should
// not also be an invisible one.
async function warnBaisFailures(): Promise<void> {
	const { failures } = await loadBaisIssues();
	if (!failures.length) return;
	console.error(
		`[bais] skipped ${failures.length} unparseable file(s): ${failures.map((f) => f.file).join(", ")} — \`bi bais check\` for details`,
	);
}

// Abort cooperation (bi#16): fetch lives inside the BAML VM with no signal
// passthrough, so mid-turn Ctrl-C cannot cancel the socket — it abandons the
// turn instead. The flag is set by the REPL race; runOnePrompt checks it
// after the turn resolves and discards late results.
export interface TurnSignal {
	aborted: boolean;
}

// Live REPL backend (bi#28): /model and /thinking mutate this in place;
// every turn after the switch runs on the new provider/model/thinking.
// `bi run` never creates one — it passes explicit flags per invocation.
// Slash dispatch (bi#12): /builtin + /skill-name in the interactive prompt.
// Skill slashes expand the SKILL.md body into the prompt (pi runs skill
// content as the prompt); builtins execute directly. Returns the (possibly
// advanced) history, "quit" to end the REPL, "none" for ordinary prompts.
// History threads through so skill turns join the transcript like any turn.
export interface ReplBackend {
	provider: string;
	model: string;
	thinking: string | null;
}

// bi#30: mutable REPL session pointer — /new /resume /fork switch files
// (and reset persisted/turn) while history flows through the return value.
export interface ReplSessionState {
	file: string;
	turn: number;
	persisted: number;
	// bi#32: last /tree listing (numbers resolve against it) + staged
	// attachment paths (consumed by the next turn).
	tree: { path: string; is_dir: boolean; depth: number }[];
	treeRoot: string;
	attachments: string[];
}

// bi#32: directory walk for /tree. Depth- and count-capped; skips the
// BAML skip-names set, dotfiles except .bais/.bi (mirrors
// tree_should_skip inline — a hot path running per directory entry, so
// one skip-set fetch instead of a VM call per name; BAML stays truth),
// and all symlinks (cycle-safe v1).
async function buildTree(root: string, maxDepth = 3, cap = 200): Promise<{ rows: { path: string; is_dir: boolean; depth: number }[]; capped: boolean }> {
	const skip = new Set(await tree_skip_names_async());
	const rows: { path: string; is_dir: boolean; depth: number }[] = [];
	let capped = false;
	const walk = (dir: string, prefix: string, depth: number): void => {
		if (depth > maxDepth || rows.length >= cap) return;
		let ents;
		try {
			ents = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const sorted = [...ents].sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		for (const e of sorted) {
			if (rows.length >= cap) {
				capped = true;
				return;
			}
			if (skip.has(e.name)) continue;
			if (e.name.startsWith(".") && e.name !== ".bais" && e.name !== ".bi") continue;
			if (e.isSymbolicLink()) continue;
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) {
				rows.push({ path: rel, is_dir: true, depth });
				walk(join(dir, e.name), rel, depth + 1);
			} else if (e.isFile()) {
				rows.push({ path: rel, is_dir: false, depth });
			}
		}
	};
	walk(root, "", 0);
	return { rows, capped };
}

async function handleSlash(line: string, skills: Skill[], history: any[], signal?: TurnSignal, backend?: ReplBackend, sess?: ReplSessionState): Promise<any[] | "quit" | "none"> {
	// Decision (BAML-backed) lives in skills.ts; this keeps only effects.
	const t = await resolveSlash(line, skills);
	if (t.kind === "none") return "none";
	if (t.kind === "unknown") {
		console.error(`unknown slash /${t.word} — /help lists commands`);
		return history;
	}
	if (t.kind === "builtin") {
		if (t.name === "quit") return "quit";
		if (t.name === "help") {
			const builtins = await builtin_slash_commands_async();
			console.log("slash commands:");
			for (const b of builtins) console.log(`  /${b.name} — ${b.description}`);
			for (const s of skills) console.log(`  /${s.name} — ${s.description} (skill)`);
			return history;
		}
		if (t.name === "reload") {
			const fresh = await loadSkills();
			console.error(`[bi] reloaded ${fresh.skills.length} skill(s)`);
			return history;
		}
		if (t.name === "compact") {
			console.error("[bi] per-run compaction already ran inside each turn (history is never truncated without a summary)");
			return history;
		}
		if (t.name === "login") {
			// The REPL engages on a TTY only, so the hidden prompt works;
			// piped `bi run "/login x"` surfaces readSecret's clean
			// refusal instead. Errors stay in-session (no process.exit).
			try {
				await runLogin(["login", ...t.args.split(/\s+/).filter((s) => s.length > 0)]);
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
			}
			return history;
		}
		if (t.name === "logout") {
			try {
				await runLogout(["logout", ...t.args.split(/\s+/).filter((s) => s.length > 0)]);
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
			}
			return history;
		}
		if (t.name === "hotkeys") {
			console.log(await hotkeys_text_async());
			return history;
		}
		// bi#33: bare /theme lists (current marked), `preview` samples
		// every role in each palette, a name persists the choice.
		if (t.name === "theme") {
			if (!t.args || t.args === "list") {
				console.log(await format_theme_list_async(await readActiveTheme()));
				return history;
			}
			if (t.args === "preview") {
				for (const name of ["default", "light", "none"]) {
					console.log(`${name}:\n${await theme_preview_async(name)}`);
				}
				return history;
			}
			if (!(await get_theme_async(t.args))) {
				console.error(`unknown theme "${t.args}" — /theme lists default/light/none`);
				return history;
			}
			try {
				mkdirSync(dirname(themeFile()), { recursive: true });
				writeFileSync(themeFile(), JSON.stringify({ name: t.args }) + "\n");
			} catch (e) {
				console.error(`[bi] theme persist failed (${e instanceof Error ? e.message : e})`);
				return history;
			}
			console.error(`[bi] theme now ${t.args}`);
			return history;
		}
		// bi#32 slice 1: /tree browses (numbers resolve against the last
		// listing), /attach stages files for the next turn, /editor
		// composes the prompt in $EDITOR. Image paste and custom hotkeys
		// stay scoped (turn image pipeline / raw-mode input layer).
		if (t.name === "tree") {
			let root = process.cwd();
			const arg = t.args.trim();
			if (arg) {
				if (/^\d+$/.test(arg) && sess) {
					const row = sess.tree[Number(arg) - 1];
					if (!row) {
						console.error(`no tree row ${arg} — bare /tree re-lists`);
						return history;
					}
					if (!row.is_dir) {
						console.error(`row ${arg} is a file — /attach ${arg} stages it`);
						return history;
					}
					root = join(sess.treeRoot, row.path);
				} else {
					root = resolve(process.cwd(), arg);
				}
			}
			let st;
			try {
				st = statSync(root);
			} catch {
				console.error(`unknown directory "${t.args}"`);
				return history;
			}
			if (!st.isDirectory()) {
				console.error(`not a directory: ${root}`);
				return history;
			}
			const { rows, capped } = await buildTree(root);
			if (sess) {
				sess.tree = rows;
				sess.treeRoot = root;
			}
			console.log(await format_tree_async(rows));
			if (capped) console.error("[bi] tree capped at 200 entries, depth 3 — narrow with /tree <dir>");
			return history;
		}
		if (t.name === "attach") {
			if (!t.args.trim()) {
				if (!sess || !sess.attachments.length) console.log("(no staged files)");
				else for (const f of sess.attachments) console.log(`staged: ${f}`);
				return history;
			}
			const arg = t.args.trim();
			let file: string;
			if (/^\d+$/.test(arg) && sess) {
				const row = sess.tree[Number(arg) - 1];
				if (!row) {
					console.error(`no tree row ${arg} — bare /tree re-lists`);
					return history;
				}
				if (row.is_dir) {
					console.error(`row ${arg} is a directory — /tree ${arg} browses it`);
					return history;
				}
				file = join(sess.treeRoot, row.path);
			} else {
				file = resolve(process.cwd(), arg);
			}
			let st;
			try {
				st = statSync(file);
			} catch {
				console.error(`unknown file "${t.args}" — /tree browses, /attach <n|path> stages`);
				return history;
			}
			if (!st.isFile()) {
				console.error(`not a file: ${file}`);
				return history;
			}
			if (st.size > 100_000) {
				console.error(`refusing ${(st.size / 1024).toFixed(0)}kb file (100kb cap) — excerpt it first`);
				return history;
			}
			if (sess && !sess.attachments.includes(file)) sess.attachments.push(file);
			console.error(`[bi] staged ${file} (${sess?.attachments.length ?? 0} staged — sent with the next turn)`);
			return history;
		}
		if (t.name === "editor") {
			const res = await editInExternalEditor(editorCommand(), t.args);
			if (res.status === "failed") {
				console.error("[bi] editor exited nonzero — nothing sent");
				return history;
			}
			if (!res.content.trim()) {
				console.error("[bi] empty — nothing sent");
				return history;
			}
			// The composed text runs as the turn (a leading / still
			// dispatches as a slash — composed slashes stay meaningful).
			return runOnePrompt(res.content, skills, history, signal ? { signal } : undefined, backend, sess);
		}
		// bi#28: bare /model lists the catalog (current marked), with an
		// argument it switches the live backend — provider follows the
		// resolved model record, so `xai/grok-4.6` moves both at once.
		if (t.name === "model") {
			if (!t.args) {
				console.log(await format_model_list_async(backend?.model ?? "claude-haiku-4-5", { theme: await activeTheme() }));
				return history;
			}
			const m = await resolve_model_ref_async(t.args);
			if (!m) {
				console.error(`unknown model "${t.args}" — bare /model lists the catalog (try provider/id)`);
				return history;
			}
			if (backend) {
				backend.provider = m.provider;
				backend.model = m.id;
			}
			console.error(`[bi] backend now ${m.provider}/${m.id}`);
			return history;
		}
		// bi#28: bare /thinking lists levels with pi's descriptions, with
		// an argument it sets the live level (validated by BAML). Budgets
		// reach anthropic turns via thinking_config_for_level; other APIs
		// ignore the config, and non-reasoning models are guarded out.
		if (t.name === "thinking") {
			if (!t.args) {
				console.log(await format_thinking_list_async(backend?.thinking ?? "off", { theme: await activeTheme() }));
				return history;
			}
			if (!is_valid_thinking_level(t.args)) {
				console.error(`unknown thinking level "${t.args}" — bare /thinking lists off/minimal/low/medium/high/xhigh/max`);
				return history;
			}
			if (backend) backend.thinking = t.args;
			console.error(`[bi] thinking now ${t.args}`);
			return history;
		}
		// bi#30: session commands. History flows through the return value;
		// the sess pointer (file/turn/persisted) mutates in place.
		if (t.name === "session") {
			const file = sess?.file ?? "(no session file)";
			const id = sess ? sessionIdFromFile(sess.file) : "(none)";
			let parent: string | null = null;
			if (sess) {
				const loaded = await loadSessionTranscript(id);
				parent = loaded?.header.parent_session ?? null;
			}
			console.log(
				await format_session_info_async(id, file, process.cwd(), parent, backend?.provider ?? "anthropic", backend?.model ?? "claude-haiku-4-5", backend?.thinking ?? null, sess?.turn ?? 0, history.length),
			);
			return history;
		}
		if (t.name === "new") {
			const f = createSessionFile({ cwd: process.cwd() });
			if (sess) {
				sess.file = f;
				sess.turn = 0;
				sess.persisted = 0;
			}
			console.error(`[bi] new session ${f}`);
			return [];
		}
		if (t.name === "resume") {
			if (!t.args) {
				const rows = await sessionResumeList();
				console.log(await format_resume_list_async(rows, sess ? sessionIdFromFile(sess.file) : null));
				return history;
			}
			const loaded = await loadSessionTranscript(t.args);
			if (!loaded) {
				console.error(`unknown session "${t.args}" — bare /resume lists saved sessions`);
				return history;
			}
			if (sess) {
				sess.file = loaded.file;
				sess.turn = loaded.history.filter((m) => m.role === "user").length;
				sess.persisted = loaded.history.length;
			}
			console.error(`[bi] resumed ${t.args} (${loaded.history.length} messages)`);
			return loaded.history;
		}
		if (t.name === "fork") {
			if (!sess) return history;
			const parentId = sessionIdFromFile(sess.file);
			const f = createSessionFile({ cwd: process.cwd(), parentSession: parentId });
			// The branch keeps the transcript: copy persisted + pending
			// lines into the fork file so both files stand alone.
			appendSessionEntries(
				f,
				history.map((m: any) => ({ role: String(m.role ?? "user"), text: String(m.text ?? ""), provider: backend?.provider ?? null, model: backend?.model ?? null, thinking: backend?.thinking ?? null })),
			);
			sess.file = f;
			sess.persisted = history.length;
			console.error(`[bi] forked ${parentId} → ${sessionIdFromFile(f)} (transcript kept, turn continues at ${sess.turn})`);
			return history;
		}
		// bi#29 slice 1: bare lists, get reads, set validates through
		// BAML before persisting, unset drops the key. Trust/config/oauth/
		// extension selectors stay scoped until their stores exist.
		if (t.name === "settings") {
			const parts = t.args ? t.args.split(/\s+/) : [];
			const stored = loadUserSettings();
			if (parts.length === 0) {
				console.log(await format_settings_list_async(bamlSettings(stored)));
				return history;
			}
			const [verb, key, ...rest] = parts;
			if ((verb === "get" || verb === "set" || verb === "unset") && key && !(await is_setting_key_async(key))) {
				console.error(`unknown setting "${key}" — bare /settings lists default_provider/default_model/default_thinking`);
				return history;
			}
			if (verb === "get" && key) {
				const v = (stored as Record<string, string | undefined>)[key];
				console.log(`${key} = ${v ?? "(unset)"}`);
				return history;
			}
			if (verb === "set" && key) {
				const value = rest.join(" ");
				if (!value) {
					console.error(`usage: /settings set ${key} <value>`);
					return history;
				}
				const merged = { ...stored, [key]: value };
				const errors = await validate_settings_async(bamlSettings(merged as UserSettings));
				if (errors.length) {
					for (const e of errors) console.error(e);
					return history;
				}
				try {
					saveUserSettings(merged);
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				console.error(`[bi] ${key} now ${value}`);
				return history;
			}
			if (verb === "unset" && key) {
				const merged = { ...stored };
				delete (merged as Record<string, string | undefined>)[key];
				try {
					saveUserSettings(merged);
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				console.error(`[bi] ${key} unset`);
				return history;
			}
			console.error("usage: /settings [get <key> | set <key> <value> | unset <key>]");
			return history;
		}
		// bi#31: scoped but unwired — name the owning issue instead of
		// failing silent or pretending the command ran.
		if (t.scope) {
			console.error(`/${t.name} isn't wired yet — tracked in ${t.scope}`);
			return history;
		}
		return history;
	}
	return runOnePrompt(`${skillBody(t.skill)}\n\n${t.args}`.trim(), skills, history, signal ? { signal } : undefined);
}

// bi#27: tool executions announce themselves — start line before the
// call, done line after (failures show the first output line, successes
// a char count). Same wrapper for REPL and `bi run`; throw semantics
// unchanged (runAgent has no handler try/catch today).
async function runToolWithStatus(name: string, args: Record<string, unknown>): Promise<string> {
	const theme = await activeTheme();
	console.log(await format_tool_start_async(name, JSON.stringify(args), { theme }));
	try {
		const out = await handleTool(name, args);
		console.log(await format_tool_done_async(name, out, false, { theme }));
		return out;
	} catch (e) {
		console.log(await format_tool_done_async(name, e instanceof Error ? e.message : String(e), true, { theme }));
		throw e;
	}
}

// One prompt through the loop. Returns the full message history (prior +
// this turn) so the REPL threads conversation across turns, or "quit".
// opts.aborted resolves when the user hits Ctrl-C mid-turn: the turn is
// abandoned (flagged via opts.signal), the spinner stops now, and the late
// VM result is discarded on arrival — transcript and prompt survive.
async function runOnePrompt(q: string, skills: Skill[] = [], history: any[] = [], opts: { signal?: TurnSignal; aborted?: Promise<void> } = {}, backend: ReplBackend = { provider: "anthropic", model: "claude-haiku-4-5", thinking: null }, sess?: ReplSessionState): Promise<any[] | "quit"> {
	const slash = await handleSlash(q, skills, history, opts.signal, backend, sess);
	if (slash === "quit") return "quit";
	if (slash !== "none") return slash;
	const skillsSection = skills.length ? `\n\n${await formatSkills(skills)}` : "";
	// bi#32: staged files inject above the prompt, then clear — read fresh
	// at send time so edits between /attach and send are picked up.
	// Binary content refuses (NUL byte); unreadable files warn and skip.
	let attachSection = "";
	if (sess?.attachments.length) {
		const blocks: string[] = [];
		for (const f of sess.attachments) {
			let content: string;
			try {
				content = readFileSync(f, "utf8");
			} catch {
				console.error(`[bi] attached file unreadable, skipped: ${f}`);
				continue;
			}
			if (content.split('').some((ch) => ch.charCodeAt(0) === 0)) {
				console.error(`[bi] attached file looks binary, skipped: ${f}`);
				continue;
			}
			const name = relative(process.cwd(), f) || basename(f);
			blocks.push(await format_attachment_async(name, content, 200));
		}
		sess.attachments = [];
		if (blocks.length) attachSection = `\n\n[Attachments]\n${blocks.join("\n")}`;
	}
	const fullPrompt = q + skillsSection + `\n\n[BAIS ready]\n${(await readyBaisIssues()).map((f) => `- ${f.issue.id} ${f.issue.title}`).join("\n")}` + attachSection;
	// BAML loop validation — runBiLoop wraps runAgent with LoopContext (agent_loop.baml).
	// Same first-class tools as `bi run` so the interactive agent manages .bais too.
	// The raw user line (not the injected context) joins history — fresh BAIS
	// context is re-injected every turn, never baked into the transcript.
	const withUser = [...history, { role: "user", text: q }];
	let loopTools: any[] = [];
	try {
		loopTools = await listTools();
	} catch {}
	// Live status on stderr (in-place spinner on TTY, plain lines on pipes);
	// BAML shapes every line, the host only schedules repaints.
	const status = new HostStatus("thinking", { formatStatus: format_status, formatSummary: format_turn_summary });
	status.start();
	// BI_BASE_URL lets the REPL talk to a local gateway/proxy (and makes
	// slow-turn behavior testable without real provider latency).
	const turnP = runBiLoop(fullPrompt, { provider: backend.provider, model: backend.model, thinking: backend.thinking, maxTurns: 5, baseUrl: process.env.BI_BASE_URL ?? null, onEvent: (e) => status.onEvent(e), tools: loopTools, toolHandler: runToolWithStatus, history });
	type Settled = { done: true; result: Awaited<typeof turnP> } | { done: false };
	let settled: Settled;
	if (opts.aborted) {
		settled = await Promise.race([
			turnP.then((result) => ({ done: true as const, result })),
			opts.aborted.then(() => ({ done: false as const })),
		]);
	} else {
		settled = { done: true, result: await turnP };
	}
	if (!settled.done) {
		if (opts.signal) opts.signal.aborted = true;
		status.stop({ failed: true, detail: "aborted", turns: 0, messages: history.length });
		console.error("[bi] turn aborted — transcript unchanged (a late VM result is discarded on arrival)");
		void turnP.then(
			() => console.error("[bi] late turn result discarded"),
			(e) => console.error(`[bi] late turn failed: ${String(e?.message ?? e).split("\n")[0]}`),
		);
		return history;
	}
	const result = settled.result;
	if (opts.signal?.aborted) {
		console.error("[bi] turn finished after abort — result discarded");
		return history;
	}
	const assistantCount = result.messages.filter((m: any) => m.role === "assistant").length;
	if (result.failure) {
		status.stop({ failed: true, detail: `TurnFailure ${result.failure.kind}`, turns: Math.max(assistantCount, 1), messages: result.messages.length });
		console.error(`TurnFailure ${result.failure.message}`);
		// bi#21: guidance names the fix where bi knows one (the REPL loop
		// is anthropic-pinned today, so the provider is static here).
		const guidance = await GuidanceFor_async(result.failure.kind, "anthropic");
		if (guidance) console.error(guidance);
		return withUser;
	}
	status.stop({ failed: false, detail: "", turns: Math.max(assistantCount, 1), messages: result.messages.length });
	// bi#27: assistant text renders through the BAML markdown shaper.
	const theme = await activeTheme();
	for (const m of result.messages) {
		if ((m as any).role !== "assistant") continue;
		console.log(await render_markdown_text_async((m as any).text ?? JSON.stringify((m as any).content), { theme }));
	}
	return result.messages;
}

// One readline interface for the whole REPL session, so ↑ history works
// across turns and persists to ~/.bi/history (next to the sessions dir).
// ask() resolves "\x03" on Ctrl-C at the prompt (hint, keep looping) and
// rejects with EOF when stdin closes (Ctrl-D / piped input ends).
class ReplReader {
	private r: any;
	private historyFile: string;
	private submitted: string[] = [];
	private pending: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
	onMidTurnInterrupt: (() => void) | null = null;
	constructor() {
		this.historyFile = historyFile();
		const lines = readHistoryFile(this.historyFile);
		this.r = createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
		// File is oldest-first; unshifting in file order leaves the newest
		// at the head, which is where Up starts (verified live: a fresh
		// process recalls the file's last line first).
		for (const l of lines) (this.r as any).history.unshift(l);
		// Ctrl-C with no question pending means mid-turn: the REPL arms
		// onMidTurnInterrupt per turn to abandon it (bi#16). At the prompt
		// the pending question resolves "\x03" and the loop re-prompts.
		this.r.on("SIGINT", () => {
			if (this.pending) this.pending.resolve("\x03");
			else this.onMidTurnInterrupt?.();
		});
		this.r.on("close", () => this.pending?.reject(new Error("EOF")));
	}
	ask(prompt: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			this.pending = { resolve, reject };
			this.r.question(prompt, (a: string) => {
				this.pending = null;
				if (a.trim().length > 0) this.submitted.push(a);
				resolve(a);
			});
		});
	}
	// Trailing backslash continues onto the next line ("... " prompt),
	// so multi-line prompts survive the line editor.
	async askMultiline(prompt: string): Promise<string> {
		const parts: string[] = [];
		let p = prompt;
		for (;;) {
			const line = await this.ask(p);
			if (line === "\x03") return "\x03";
			if (line.endsWith("\\") && !line.endsWith("\\\\")) {
				parts.push(line.slice(0, -1));
				p = "... ";
				continue;
			}
			parts.push(line);
			return parts.join("\n");
		}
	}
	close(): void {
		// Persist from our own submission log (chronological by
		// construction) merged over the loaded file — never trust the
		// live array's endianness for the on-disk order.
		try {
			const prior = readHistoryFile(this.historyFile);
			const merged = [...prior, ...this.submitted.map((l) => l.replace(/\s*\n\s*/g, " ").trim()).filter((l) => l.length > 0)];
			const seen = new Set<string>();
			const deduped = merged.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
			writeHistoryFile(this.historyFile, deduped);
		} catch {}
		try { this.r.close(); } catch {}
		this.pending = null;
	}
}

// Persistent REPL: one session file, conversation history threaded across
// turns, /quit or Ctrl-D to leave, Ctrl-C at the prompt just re-prompts.
// Ctrl-C mid-turn aborts the process (same as `bi run`) — the session file
// and printed transcript remain.
async function repl(skills: Skill[]): Promise<void> {
	const sessFile = createSessionFile({ cwd: process.cwd() });
	console.error(`[bi] new session ${sessFile}`);
	const reader = new ReplReader();
	let history: any[] = [];
	// bi#28 live backend, bi#29 stored defaults: flags are absent in the
	// REPL, so stored settings apply. Invalid stored settings warn and
	// fall back to builtins — never brick startup on a bad file.
	let backend: ReplBackend;
	try {
		const r = await resolve_backend_async(null, null, null, bamlSettings(loadUserSettings()));
		backend = { provider: r.provider, model: r.model, thinking: r.thinking ?? null };
	} catch (e) {
		console.error(`[bi] stored settings invalid (${bamlErrorMessage(e)}) — using builtins`);
		backend = { provider: "anthropic", model: "claude-haiku-4-5", thinking: null };
	}
	// bi#30: session pointer — file/turn/persisted mutate via /new /resume
	// /fork; turns append to the file as they land (memory authoritative).
	const sess: ReplSessionState = { file: sessFile, turn: 0, persisted: 0, tree: [], treeRoot: process.cwd(), attachments: [] };
	try {
		for (;;) {
			let line: string;
			try {
				line = await reader.askMultiline(`bi[${sess.turn}]> `);
			} catch {
				console.error("\n[bi] EOF — session kept at " + sess.file);
				return;
			}
			if (line === "\x03" || !line.trim()) {
				if (line === "\x03") console.error("(Ctrl-D or /quit to exit)");
				continue;
			}
			// Mid-turn Ctrl-C abandons the turn (bi#16): the VM request has
			// no signal passthrough, so the turn is orphaned and discarded
			// on arrival — the prompt and transcript survive.
			const signal: TurnSignal = { aborted: false };
			let fireAbort: () => void = () => {};
			const aborted = new Promise<void>((res) => { fireAbort = res; });
			reader.onMidTurnInterrupt = () => fireAbort();
			const out = await runOnePrompt(line.trim(), skills, history, { signal, aborted }, backend, sess);
			reader.onMidTurnInterrupt = null;
			if (out === "quit") {
				console.error(`[bi] session kept at ${sess.file} (${history.length} messages)`);
				return;
			}
			// Slash/empty lines return the same history — only real turns advance.
			// /new returns [] on purpose: history resets with no turn counted.
			if (out !== history) {
				history = out;
				if (out.length > 0) {
					sess.turn += 1;
					// bi#30: persist only the not-yet-written tail.
					appendSessionEntries(
						sess.file,
						out.slice(sess.persisted).map((m: any) => ({ role: String(m.role ?? "user"), text: String(m.text ?? ""), provider: backend.provider, model: backend.model, thinking: backend.thinking })),
					);
					sess.persisted = out.length;
					// bi#28: footer readout after every turn (BAML-shaped).
					console.error(await format_repl_footer_async(backend.provider, backend.model, backend.thinking ?? "default", sess.turn, history.length, { theme: await activeTheme() }));
				}
			}
		}
	} finally {
		reader.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const cmd = args[0];

	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		printHelp();
		process.exit(0);
	}
	// first-class: `bi` with no args shows ready BAIS issues (like pi shows session)
	// BAML is spec for args: parse_args validates --thinking/--mode etc. before dispatch
	try {
		const parsed = await parse_args(args);
		if (parsed.diagnostics.length) {
			for (const d of parsed.diagnostics) console.error(`[${d.type}] ${d.message}`);
		}
		if (parsed.help) { printHelp(); process.exit(0); }
	} catch {}
	if (!cmd) {
		await warnBaisFailures();
		const ready = await readyBaisIssues();
		// HostTui differential — BAML owns Component/diff_lines, host renders (pi TUI spec)
		const tui = new HostTui();
		if (ready.length === 0) {
			tui.render(renderReadyScreen([], process.stdout.columns ?? 80));
			console.log("(no ready BAIS issues — `bi bais list` to see all)");
		} else {
			tui.render(renderReadyScreen(ready, process.stdout.columns ?? 80));
			for (const f of ready) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
		}
		// session hint — bi native .bi (not .pi), validated via BAML SessionHeader
		console.log(`\nSessions: ${getBiSessionsDir()} (${listSessions().length} saved) — try \`bi --continue\` or \`bi run "hello"\``);
		console.log("`bi --help` for commands, `bi bais new \"title\"` to add, `bi run \"prompt\"` to run agent");
		if (process.stdin.isTTY && process.stdout.isTTY) console.log("interactive REPL below — ↑ history, trailing \\ continues lines, /help slashes, /quit or Ctrl-D to leave");
		// interactive REPL: persistent loop with cross-turn history (Ctrl-D or
		// /quit to leave, Ctrl-C at the prompt re-prompts, Ctrl-C mid-turn aborts)
		if (process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, "--print") && !hasFlag(args, "-p")) {
			const { skills, diagnostics } = await loadSkills().catch(() => ({ skills: [], diagnostics: [] }));
			for (const d of diagnostics) console.error(`[skills] ${d.file}: ${d.message}`);
			await repl(skills);
		}
		process.exit(0);
	}
	// session flags — host handles FS, BAML validates ids (bi/.bi, not .pi)
	if (hasFlag(args, "--continue") || hasFlag(args, "-c")) {
		const id = findMostRecentSession();
		if (!id) console.error("No sessions to continue — `bi` will start fresh");
		else console.error(`[bi] continuing ${id} @ ${getBiSessionsDir()}`);
		// `--continue` is a flag, not a command — don't fall through to unknown
		if (cmd?.startsWith("-")) return;
	}
	if (hasFlag(args, "--resume") || hasFlag(args, "-r")) {
		console.error(`[bi] sessions: ${listSessions().join(", ") || "(none)"} — pick with --session <id>`);
		if (cmd?.startsWith("-")) return;
	}

	if (cmd === "list-providers") {
		const providers = await listProviders();
		for (const p of providers) {
			console.log(`${p.id}\t${p.name}\t${p.base_url}\t${p.api}`);
		}
		return;
	}

	if (cmd === "list-models") {
		const provider = getFlag(args, "--provider");
		const models = provider ? await listModels(provider) : await listAllModels();
		if (provider && models.length === 0) {
			console.error(`Unknown provider: ${provider}`);
			process.exit(1);
		}
		for (const m of models) {
			console.log(`${m.id}\t${m.provider}\t${m.api}\t${m.name}\treasoning=${m.reasoning}\t${m.context_window}ctx`);
		}
		return;
	}
	if (cmd === "list-image-models") {
		const provider = getFlag(args, "--provider") ?? null;
		const models = await listImageModels(provider);
		if (provider && models.length === 0) {
			console.error(`Unknown image provider: ${provider}`);
			process.exit(1);
		}
		for (const m of models) {
			console.log(`${m.id}\t${m.provider}\t${m.name}`);
		}
		return;
	}

	if (cmd === "get-model") {
		const id = args[1];
		if (!id) {
			console.error("get-model requires <id>");
			process.exit(1);
		}
		const m = await getModel(id);
		if (!m) {
			console.error(`Unknown model: ${id}`);
			process.exit(1);
		}
		console.log(JSON.stringify(m, null, 2));
		return;
	}

	// Auth commands (bi#20) — effects live in auth_cli.ts, errors surface
	// as message + exit 1 like the blocks above.
	if (cmd === "login" || cmd === "logout" || cmd === "auth") {
		const sub = cmd === "auth" ? args[1] : cmd;
		const subArgs = cmd === "auth" ? ["auth", ...args.slice(2)] : args;
		try {
			if (sub === "login") await runLogin(subArgs);
			else if (sub === "logout") await runLogout(subArgs);
			else if (sub === "status") await runAuthStatus();
			else {
				console.error("usage: bi login [provider] | bi logout <provider> | bi auth status");
				process.exit(1);
			}
		} catch (e) {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		}
		return;
	}

	if (cmd === "run") {
		// prompt is everything after `run` until a flag
		let prompt = "";
		const promptParts: string[] = [];
		for (let i = 1; i < args.length; i++) {
			if (args[i].startsWith("--")) break;
			promptParts.push(args[i]);
		}
		prompt = promptParts.join(" ");
		if (!prompt) {
			console.error("run requires <prompt>");
			process.exit(1);
		}
		// bi#29: backend resolves flag > settings > builtin in BAML;
		// mismatched or unknown pairs fail here instead of misrouting.
		const storedSettings = loadUserSettings();
		let provider: string;
		let model: string;
		let thinkingLevel: string | null;
		try {
			const r = await resolve_backend_async(getFlag(args, "--provider") ?? null, getFlag(args, "--model") ?? null, getFlag(args, "--thinking") ?? null, bamlSettings(storedSettings));
			provider = r.provider;
			model = r.model;
			thinkingLevel = r.thinking ?? null;
		} catch (e) {
			console.error(`bi run: ${bamlErrorMessage(e)}`);
			process.exit(1);
		}
		const apiKey = getFlag(args, "--api-key") ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
		const baseUrl = getFlag(args, "--base-url") ?? null;
		const tempStr = getFlag(args, "--temperature");
		const temperature = tempStr != null ? Number(tempStr) : null;
		const maxTurnsStr = getFlag(args, "--max-turns");
		const maxTurns = maxTurnsStr != null ? Number(maxTurnsStr) : 5;
		// Azure scoping (bi#15): explicit flags win, else AZURE_OPENAI_*
		// env inside the VM (see turn.baml azure-responses arm).
		const azureResource = getFlag(args, "--azure-resource") ?? null;
		const azureDeployment = getFlag(args, "--azure-deployment") ?? null;
		const azureApiVersion = getFlag(args, "--azure-api-version") ?? null;
		// bi#28: the parsed-but-dropped --thinking flag now reaches turns.
		// thinkingLevel resolved above (invalid values exit 1 with the fix named).

		const providerInfo = await getProvider(provider);
		if (!providerInfo) {
			console.error(`Unknown provider: ${provider}`);
			process.exit(1);
		}
		const modelInfo = await getModel(model);
		if (!modelInfo) {
			console.error(`Unknown model: ${model}`);
			process.exit(1);
		}

		// first-class BAIS: inject ready issues into prompt context (BAML is validator for issues)
		let baisContext = "";
		let baisReadyCount = 0;
		try {
			await warnBaisFailures();
			const ready = await readyBaisIssues();
			if (ready.length) {
				baisReadyCount = ready.length;
				baisContext = `\n\n[BAIS ready issues — .bais is first-class, BAML-validated via bais parser]\n${ready.map((f) => `- ${f.issue.id} [${f.issue.status}/${f.issue.kind}] ${f.issue.title}${f.issue.area ? ` (${f.issue.area})` : ""}`).join("\n")}\n`;
			}
		} catch {}

		const fullPrompt = prompt + baisContext;
		// First-class BAIS: the agent gets all 15 tools (7 pi + 8 bais_*) with
		// the host executors, so it can list → ready → new → move issues itself
		// instead of only reading the injected ready list.
		let runTools: any[] = [];
		try {
			runTools = await listTools();
		} catch (e: any) {
			console.error(`[bi] tool registry unavailable (${String(e?.message ?? e).split("\n")[0]}) — running tool-free`);
		}
		// Skills (bi#12): project + user SKILL.md dirs format into the prompt
		// (XML per agentskills.io) so the model lists skill-provided guidance
		// alongside the tool registry. Diagnostics warn, never block.
		let skillsSection = "";
		let skillNames: string[] = [];
		try {
			const { skills, diagnostics } = await loadSkills();
			for (const d of diagnostics) console.error(`[skills] ${d.file}: ${d.message}`);
			if (skills.length) {
				skillsSection = `\n\n${await formatSkills(skills)}`;
				skillNames = skills.map((s) => s.name);
			}
		} catch (e: any) {
			console.error(`[bi] skills unavailable (${String(e?.message ?? e).split("\n")[0]})`);
		}
		console.error(`bi run — provider=${provider} model=${model} prompt="${prompt}"${baisContext ? ` (+${baisReadyCount} BAIS ready)` : ""} tools=${runTools.length} skills=${skillNames.length ? skillNames.join(",") : "none"}`);
		// bi#62: leased run mode. --hub URL + --task ID claim the task
		// through the hub coordinator before the first turn: the keeper
		// holds + auto-renews (the LLM never renews), the subscriber feeds
		// hub notifications as prompt context (the LLM never polls), and
		// the lease releases when the run settles. Without --hub, behavior
		// is exactly as before (fail-open: no coordinator, no claims).
		const hubUrl = getFlag(args, "--hub");
		const taskId = getFlag(args, "--task");
		let keeper: LeaseKeeper | undefined;
		let subscriber: HubSubscriber | undefined;
		if (hubUrl !== undefined || taskId !== undefined) {
			if (!hubUrl || !taskId) {
				console.error("bi run: --hub and --task go together (leased mode needs both)");
				process.exit(1);
			}
			const holder = getFlag(args, "--holder") ?? `did:key:bi-run-${process.pid}`;
			const ttl = Number(getFlag(args, "--ttl") ?? 1000);
			if (!Number.isFinite(ttl) || ttl <= 0) {
				console.error("bi run: --ttl needs a positive number of lc ticks");
				process.exit(1);
			}
			keeper = new LeaseKeeper({
				hub: new HttpKeeperHub(hubUrl), task: taskId, holder, ttl,
				onStatus: (m) => console.error(`[keeper] ${m}`),
			});
			try {
				const claimed = await keeper.acquire();
				console.error(`[keeper] claimed ${taskId} fencing=${claimed.fencing} expires_lc=${claimed.expires_lc}`);
			} catch (e: any) {
				console.error(`[keeper] claim failed: ${e instanceof Error ? e.message : e} (task may be held — pick another from the ready list)`);
				process.exit(1);
			}
			subscriber = new HubSubscriber({
				baseUrl: hubUrl, watch: [taskId],
				onStatus: (m) => console.error(`[hub] ${m}`),
			});
			subscriber.start();
		}
		let result: Awaited<ReturnType<typeof runAgent>>;
		try {
			result = await runAgent(fullPrompt + skillsSection, {
				provider,
				model,
				apiKey,
				baseUrl,
				temperature,
				thinkingLevel,
				maxTurns,
				azureResource,
				azureDeployment,
				azureApiVersion,
				tools: runTools,
				toolHandler: runToolWithStatus,
				notify: subscriber?.queue,
				keeper,
			});
		} finally {
			// Deliberate free, not a loss: release first so leaseError()
			// stays null and the run is judged on its work, then stop the
			// subscriber. Errors here warn; the run's own result stands.
			if (keeper) {
				try {
					await keeper.release();
					console.error(`[keeper] released ${taskId}`);
				} catch (e: any) {
					console.error(`[keeper] release failed: ${e instanceof Error ? e.message : e}`);
				}
			}
			if (subscriber) await subscriber.stop();
		}

		// bi#14 run modes: --mode json emits one JSON RunEvent per line on
		// stdout (schema in events.baml, BAML-validated); --print/-p emits
		// final text only. Default prints human-readable text + tool lines.
		// RPC stays out of scope by design (single-binary agent, no
		// client/server/protocol) — rejected explicitly.
		const mode = getFlag(args, "--mode");
		if (mode === "rpc") {
			console.error("bi run --mode rpc is out of scope by design (no client/server/protocol — bi is a single-binary agent)");
			process.exit(1);
		}
		if (mode === "json") {
			const lines = await runResultToJsonLines(result, provider, model);
			for (const l of lines) console.log(l);
			process.exit(result.failure ? 1 : 0);
		}
		if (result.failure) {
			console.error(`TurnFailure: kind=${result.failure.kind} retry_safe=${result.failure.retry_safe} message=${result.failure.message}`);
			// bi#21: human mode only — --mode json stays machine-clean.
			const guidance = await GuidanceFor_async(result.failure.kind, provider);
			if (guidance) console.error(guidance);
			process.exit(1);
		}
		// bi#33: one theme resolution for the whole result dump.
		const runTheme = await activeTheme();
		if (hasFlag(args, "--print") || hasFlag(args, "-p")) {
			const t = finalText(result);
			// bi#27: human print path renders markdown; json mode above stays raw.
			if (t) console.log(await render_markdown_text_async(t, { theme: runTheme }));
			return;
		}
		// bi#27: history display shapes text blocks and tool calls alike.
		for (const msg of result.messages) {
			if (msg.role === "assistant" && "text" in msg) {
				console.log(await render_markdown_text_async(msg.text, { theme: runTheme }));
			} else if (msg.role === "assistant" && "content" in msg) {
				for (const b of (msg as any).content) {
					if (b.type === "text") console.log(await render_markdown_text_async(b.text, { theme: runTheme }));
					else if (b.type === "toolUse") console.log(await format_tool_start_async(b.name, JSON.stringify(b.args), { theme: runTheme }));
				}
			}
		}
		return;
	}

	if (cmd === "bais") {
		const sub = args[1];
		const asJson = hasFlag(args, "--json");
		if (sub === "list") {
			const { issues: files, failures } = await loadBaisIssues();
			if (asJson) console.log(JSON.stringify({ issues: files, unparseable: failures }, null, 2));
			else {
				for (const f of files) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
				for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
				if (files.length === 0 && failures.length === 0) console.error("(no .bais/issues/*.toml — run bais init or add issues)");
			}
			return;
		}
		if (sub === "ready") {
			// JSON shape matches `bais ready --json`: {ready, unparseable}.
			// Unparseable files are absent from the graph, so both the ready
			// set and the edges that would have constrained it are short.
			const { issues, failures } = await loadBaisIssues();
			const ready = filterReadyIssues(issues);
			if (asJson) console.log(JSON.stringify({ ready, unparseable: failures }, null, 2));
			else {
				for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}`);
				if (ready.length === 0) console.log("(no ready issues)");
				if (failures.length) console.error(`[bais] ${failures.length} unparseable file(s) excluded — \`bi bais check\` for details`);
			}
			return;
		}
		if (sub === "new") {
			const title = args[2];
			if (!title) { console.error('bais new requires "title"'); process.exit(1); }
			const kind = getFlag(args, "--kind") ?? getFlag(args, "--Kind") ?? "Feat";
			const area = getFlag(args, "--area");
			const status = getFlag(args, "--status") ?? "Open";
			const body = getFlag(args, "--body");
			const file = await createBaisIssue({ title, kind, area, body, status });
			console.log(`${file.issue.id}\t${file.issue.title}`);
			return;
		}
		if (sub === "move") {
			const id = args[2];
			const status = args[3];
			if (!id || !status) { console.error("bais move requires <id> <Status>"); process.exit(1); }
			const file = await moveBaisIssue(id, status);
			console.log(`${file.issue.id}\t${file.issue.status}`);
			return;
		}
		if (sub === "check") {
			const { ok, bad, dangling, cycles } = await checkBaisIssues();
			const missing = dangling.filter((d) => d.status === "Missing");
			const external = dangling.filter((d) => d.status === "External");
			if (asJson) console.log(JSON.stringify({ ok: ok.length, bad, dangling, cycles }, null, 2));
			else {
				for (const f of ok) console.log(`ok\t${f.issue.id}`);
				for (const b of bad) console.log(`bad\t${b.file}\t${b.error}`);
				// A Blocks edge naming an id that does not exist parks its target
				// indefinitely — is_blocked treats an unresolvable blocker as
				// blocking — so a missing reference is a defect, not a warning.
				for (const d of missing) console.log(`dangling\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
				// Another project's id is not resolvable from here. Reported so a
				// typo'd prefix stays visible, but not a failure.
				for (const d of external) console.log(`external\t${d.declaredBy}\t${d.side}=${d.id}\t${d.kind} ${d.from} -> ${d.to}`);
				// Nothing in a dependency cycle can ever become ready — and
				// ready_issues reports that as silence. cycles is the diagnosis.
				if (cycles.length) console.log(`cycle\t${cycles.join(", ")}`);
			}
			// Applies to both output modes — --json previously always exited 0,
			// which made it useless as a CI gate. External alone never fails.
			if (bad.length || missing.length || cycles.length) process.exit(1);
			return;
		}
		if (sub === "graph") {
			const from = getFlag(args, "--from");
			if (!from) { console.error("bais graph requires --from <id>"); process.exit(1); }
			const files = await graphBaisIssues(from);
			if (asJson) console.log(JSON.stringify(files, null, 2));
			else for (const f of files) console.log(`${f.issue.id}\t${f.issue.title}\t[${f.edges.map((e) => e.kind).join(",")}]`);
			return;
		}
		console.error(`Unknown bais subcommand: ${sub ?? ""} (try: bais list | ready | new | move | check | graph)`);
		printHelp();
		process.exit(1);
	}

	if (cmd?.startsWith("-")) {
		// e.g. `bi --continue` or `bi --thinking high` — already handled above / via parse_args diagnostics
		// show ready BAIS as default interactive hint
		const ready = await readyBaisIssues();
		if (ready.length) for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}`);
		return;
	}
	console.error(`Unknown command: ${cmd}`);
	printHelp();
	process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
