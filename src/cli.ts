#!/usr/bin/env node
// bi CLI — minimal pi fork entry point (Orion's first name is Orion, CLI is `bi`).
// Commands mirror pi's provider/model surface that bi actually ports:
//   bi list-providers | list-models [--provider id] | get-model <id> | run <prompt>
// No external deps — uses bi's own provider/models/agent BAML port.

import { getModel, listAllModels, listModels } from "./models.js";
import { getProvider, listProviders } from "./provider.js";
import { runAgent, runSingleImageTurn } from "./agent.js";
import { HttpKeeperHub, LeaseKeeper } from "./keeper.js";
import { HubSubscriber } from "./notify.js";
import { loadBaisIssues, readyBaisIssues, filterReadyIssues, createBaisIssue, moveBaisIssue, checkBaisIssues, graphBaisIssues, scanBaisHeaders, scannedBlockers, loadStagedIssues } from "./bais.js";
import { listTools, handleTool, emitToolDiff, setTrustReader } from "./tools.js";
import { listImageModels } from "./image.js";
import { runAuthStatus, runLogin, runLogout } from "./auth_cli.js";
import { listCredentials } from "./auth.js";
import { parse_args, format_help, is_valid_thinking_level, builtin_slash_commands_async, hotkeys_text_async, format_model_list_async, format_thinking_list_async, format_repl_footer_async, render_footer_frame_async, resolve_model_ref_async, pick_model_async, model_list_cursor_async, format_session_info_async, format_resume_list_async, render_markdown_text_async, format_tool_start_async, format_tool_done_async, get_theme_async, format_theme_list_async, theme_preview_async, format_settings_list_async, validate_settings_async, is_setting_key_async, resolve_backend_async, format_tree_async, tree_skip_names_async, format_attachment_async, parse_trust_answer_async, format_trust_status_async, format_project_trust_prompt_async, ModelSupportsImage_async, ListProviders_async, ProviderAuthEnv_async, OAuthRow, format_oauth_status_async, format_skills_list_async, is_model_enabled_async, format_scoped_models_async, all_model_ids_async, validate_session_label_async, format_session_markdown_async, gist_description_async, parse_changelog_async, format_changelog_async, complete_slash_async, complete_arg_async, render_divider_async, setting_keys_async, format_issue_row_async, format_issue_context_async, render_ready_frame_async, GuidanceFor_async } from "../baml_sdk/index.js";
import { loadSkills, formatSkills, skillBody, resolveSlash, skillDirs, type Skill } from "./skills.js";
import { getStoredTrust, setStoredTrust, forgetStoredTrust, type TrustDecision } from "./trust.js";
import { readClipboardImage, writeClipboardText, clipboardSupportsImage } from "./clipboard.js";
import { runResultToJsonLines, finalText } from "./events.js";
import { getBiSessionsDir, createSessionFile, listSessions, findMostRecentSession, validateSessionIdOrThrow, appendSessionEntries, loadSessionTranscript, sessionResumeList, sessionIdFromFile, setSessionLabel, importSessionFile, shareSessionGist } from "./session.js";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CHANGELOG.md ships at the package root; the running module is
// dist/src/cli.js, so two levels up. A relocated install without
// the file reads clean at the call site (never throws here).
function changelogFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md");
}
import { homedir } from "node:os";

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

// Block chrome: a BAML-shaped faint rule closes each REPL output block
// (turn on stderr, slash listings on stdout) so the next prompt never
// crowds the last line. Width follows the stream being written.
async function stderrRule(theme: string | null): Promise<void> {
	process.stderr.write((await render_divider_async(process.stderr.columns ?? process.stdout.columns ?? 80, { theme })) + "\n");
}

async function printBlock(text: string): Promise<void> {
	console.log(text);
	process.stdout.write((await render_divider_async(process.stdout.columns ?? 80, { theme: await activeTheme() })) + "\n");
}

// Second-word Tab pools per slash command. Static pools mirror the
// BAML-validated sets (thinking levels, theme names, trust verbs);
// dynamic pools come from the VM (model catalog, setting keys).
// Unknown commands complete nothing — never guess.
async function argCandidates(cmd: string, names: string[]): Promise<string[]> {
	try {
		switch (cmd) {
			case "model":
				return await all_model_ids_async();
			case "thinking":
				return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			case "theme":
				return ["default", "light", "none"];
			case "trust":
				return ["allow", "deny", "session", "forget"];
			case "changelog":
				return ["all"];
			case "settings":
				return await setting_keys_async();
			case "issues":
				return [...scanBaisHeaders().headers.map((h) => h.id), "all", "drop"];
			case "help":
				return names.map((n) => n.replace(/^\//, ""));
			default:
				return [];
		}
	} catch {
		return [];
	}
}

// bi#29: user settings (~/.bi/settings.json). Three backend-default keys
// in v1; BAML owns schema + validation + precedence, host owns FS.
// Unknown keys on disk are ignored (forward-compatible); a corrupt file
// resolves empty with a warning instead of bricking startup.
export interface UserSettings {
	default_provider?: string;
	default_model?: string;
	default_thinking?: string;
	enabled_models?: string[];
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
		if (Array.isArray(raw?.enabled_models) && raw.enabled_models.every((e: unknown) => typeof e === "string")) out.enabled_models = raw.enabled_models;
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
function bamlSettings(s: UserSettings): { default_provider: string | null; default_model: string | null; default_thinking: string | null; enabled_models: string[] | null } {
	return { default_provider: s.default_provider ?? null, default_model: s.default_model ?? null, default_thinking: s.default_thinking ?? null, enabled_models: s.enabled_models ?? null };
}

// BAML VM errors arrive as "baml error: baml.errors.Kind: message" —
// strip the wrapper so users see the policy message BAML wrote.
function bamlErrorMessage(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return raw.replace(/^baml error: (baml\.errors\.\w+: )?/, "").split("\n")[0];
}
import { HostTui, HostStatus, HostFooter, renderSelectList } from "./tui.js";
import { format_status, format_turn_summary, format_turn_error } from "../baml_sdk/index.js";
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
	// attachment paths (consumed by the next turn) + staged clipboard
	// images (one consumed per image turn).
	tree: { path: string; is_dir: boolean; depth: number }[];
	treeRoot: string;
	attachments: string[];
	images: string[];
	// bi#29: reload project skills when /trust changes the decision.
	skillsDirty: boolean;
	// bi#79: staged BAIS working set (sticky across turns until dropped)
	// + the ids behind the last /issues listing (numbers resolve by it).
	stagedIssues: string[];
	issueList: string[];
}

// bi#29: effective project trust, resolved once per process. Stored
// allow/deny wins; undecided asks on an interactive TTY and fails
// closed (deny) headless — pi parity without a UI. /trust mutates this
// mid-session (persisting allow/deny, never session-only).
let effectiveTrust: TrustDecision | null = null;

// Write/edit executors read live loop trust (stored file + in-memory
// session answer) through this reader — a mid-session `/trust deny`
// refuses the very next model write.
setTrustReader(() => effectiveTrust ?? getStoredTrust(process.cwd()));

function askOneLine(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(prompt, (a) => {
			rl.close();
			resolve(a);
		});
	});
}

async function ensureTrust(interactive: boolean): Promise<TrustDecision> {
	if (effectiveTrust) return effectiveTrust;
	const stored = getStoredTrust(process.cwd());
	if (stored) {
		effectiveTrust = stored;
		return stored;
	}
	if (!interactive || !process.stdin.isTTY) {
		effectiveTrust = "deny";
		return "deny";
	}
	console.error(await format_project_trust_prompt_async(process.cwd()));
	const parsed = await parse_trust_answer_async((await askOneLine("Trust this project? [y]es / [n]o / [s]ession-only: ")).trim());
	if (parsed === "allow" || parsed === "deny") {
		try {
			setStoredTrust(process.cwd(), parsed);
		} catch (e) {
			console.error(`[bi] trust persist failed (${e instanceof Error ? e.message : e}) — session-only from here`);
			effectiveTrust = "session";
			return "session";
		}
		effectiveTrust = parsed;
	} else if (parsed === "session") {
		effectiveTrust = "session";
	} else {
		// Fail closed with a named reason (bi#55): the answer was not
		// recognized, so the project stays untrusted; /trust re-decides.
		console.error(`[bi] unrecognized answer — project denied (${process.cwd()} stays untrusted; /trust to decide)`);
		effectiveTrust = "deny";
	}
	return effectiveTrust;
}

// Skill dirs minus the project dir unless trusted — the one enforcement
// point: project SKILL.md bodies enter prompts, so deny excludes them.
async function trustedSkillDirs(interactive: boolean): Promise<string[]> {
	const trust = await ensureTrust(interactive);
	const dirs = skillDirs();
	if (trust === "allow" || trust === "session") return dirs;
	return dirs.filter((d) => d === join(homedir(), ".bi", "skills"));
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
			const lines = ["slash commands:"];
			for (const b of builtins) lines.push(`  /${b.name} — ${b.description}`);
			for (const s of skills) lines.push(`  /${s.name} — ${s.description} (skill)`);
			await printBlock(lines.join("\n"));
			return history;
		}
		if (t.name === "reload") {
			const fresh = await loadSkills(await trustedSkillDirs(true));
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
		if (t.name === "oauth") {
			// bi#29: pi's oauth-selector as a status board. Rows are
			// secret-free (winning chain link + stored kind + env var);
			// BAML shapes every line, unconfigured rows name their fix.
			try {
				const providers = await ListProviders_async();
				const stored = await listCredentials();
				const rows = [];
				for (const p of providers) {
					const env = await ProviderAuthEnv_async(p.id);
					const s = stored.find((c) => c.provider_id === p.id);
					if (s) rows.push(new OAuthRow({ provider_id: p.id, source: "stored", cred_type: s.type, auth_env: env }));
					else if (env && process.env[env]) rows.push(new OAuthRow({ provider_id: p.id, source: "env", cred_type: null, auth_env: env }));
					else rows.push(new OAuthRow({ provider_id: p.id, source: "none", cred_type: null, auth_env: env }));
				}
				await printBlock(await format_oauth_status_async(rows));
			} catch (e) {
				console.error(`[bi] oauth status failed (${e instanceof Error ? e.message : e})`);
			}
			return history;
		}
		if (t.name === "hotkeys") {
			await printBlock(await hotkeys_text_async());
			return history;
		}
		if (t.name === "changelog") {
			// bi#31: entries live in CHANGELOG.md next to the install
			// (dist/src/cli.js → package root). Missing file reads
			// clean, never throws; BAML splits + shapes the sections.
			const arg = t.args.trim();
			if (arg && arg !== "all") {
				console.error("usage: /changelog [all]");
				return history;
			}
			let raw: string;
			try {
				raw = readFileSync(changelogFile(), "utf8");
			} catch {
				console.error("[bi] no CHANGELOG.md found next to the bi install");
				return history;
			}
			await printBlock(await format_changelog_async(await parse_changelog_async(raw), arg === "all"));
			return history;
		}
		if (t.name === "skills") {
			// bi#29: pi's extension-selector as an inventory list. Same
			// trust-gated discovery the loop sees (project dir excluded
			// on deny); BAML shapes the rows, host reports load warnings.
			try {
				const { skills, diagnostics } = await loadSkills(await trustedSkillDirs(true));
				await printBlock(await format_skills_list_async(skills));
				for (const d of diagnostics) console.error(`[bi] skill ${d.file}: ${d.message}`);
			} catch (e) {
				console.error(`[bi] skills list failed (${e instanceof Error ? e.message : e})`);
			}
			return history;
		}
		// bi#33: bare /theme lists (current marked), `preview` samples
		// every role in each palette, a name persists the choice.
		if (t.name === "theme") {
			if (!t.args || t.args === "list") {
				await printBlock(await format_theme_list_async(await readActiveTheme()));
				return history;
			}
			if (t.args === "preview") {
				const previews: string[] = [];
				for (const name of ["default", "light", "none"]) {
					previews.push(`${name}:\n${await theme_preview_async(name)}`);
				}
				await printBlock(previews.join("\n"));
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
		// bi#29: trust decisions persist (allow/deny) or hold for the
		// session; project skills reload on change (sess.skillsDirty).
		if (t.name === "trust") {
			const cwd = process.cwd();
			const verb = (t.args ?? "").trim().split(/\s+/)[0] ?? "";
			if (!verb) {
				await printBlock(await format_trust_status_async(cwd, effectiveTrust));
				return history;
			}
			if (verb === "allow" || verb === "deny") {
				try {
					setStoredTrust(cwd, verb);
				} catch (e) {
					console.error(`[bi] trust persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				effectiveTrust = verb;
				if (sess) sess.skillsDirty = true;
				console.error(`[bi] trust ${cwd}: ${verb} (persisted — project skills reload next turn)`);
				return history;
			}
			if (verb === "session") {
				effectiveTrust = "session";
				if (sess) sess.skillsDirty = true;
				console.error(`[bi] trust ${cwd}: session-only (not persisted)`);
				return history;
			}
			if (verb === "forget") {
				let had = false;
				try {
					had = forgetStoredTrust(cwd);
				} catch (e) {
					console.error(`[bi] trust persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				effectiveTrust = "session";
				if (sess) sess.skillsDirty = true;
				console.error(had ? `[bi] forgot stored decision for ${cwd} (session-only from here)` : `[bi] no stored decision for ${cwd}`);
				return history;
			}
			console.error("usage: /trust [allow|deny|session|forget]");
			return history;
		}
		// bi#32: /copy writes the last assistant text to the clipboard
		// (reads need no command — text pastes through the terminal).
		if (t.name === "copy") {
			let text: string | null = null;
			for (let i = history.length - 1; i >= 0; i--) {
				const m = history[i];
				if (m?.role !== "assistant") continue;
				if (typeof m.text === "string" && m.text) {
					text = m.text;
					break;
				}
				if (Array.isArray(m.content)) {
					const block = m.content.find((b: any) => b?.type === "text" && typeof b.text === "string" && b.text);
					if (block) {
						text = block.text;
						break;
					}
				}
			}
			if (!text) {
				console.error("nothing to copy yet — no assistant messages");
				return history;
			}
			if (!writeClipboardText(text)) {
				console.error("clipboard write failed on this platform");
				return history;
			}
			console.error(`[bi] copied ${text.length} chars`);
			return history;
		}
		// bi#32: /paste stages a clipboard image for the next turn (PNG
		// only, 5mb cap). macOS/Linux via stock tools; elsewhere clean.
		if (t.name === "paste") {
			if (t.args.trim() === "clear") {
				const n = sess?.images.length ?? 0;
				if (sess) sess.images = [];
				console.error(n ? `[bi] dropped ${n} staged image(s)` : "[bi] no staged images");
				return history;
			}
			if (!clipboardSupportsImage()) {
				console.error("image paste needs macOS or Linux with xclip/wl-paste");
				return history;
			}
			const img = readClipboardImage();
			if (!img) {
				console.error("no image on the clipboard (text pastes normally through the terminal)");
				return history;
			}
			if (img.bytes.length > 5_000_000) {
				console.error(`clipboard image is ${(img.bytes.length / 1_048_576).toFixed(1)}mb (5mb cap)`);
				return history;
			}
			const dir = join(dirname(getBiSessionsDir()), "paste");
			const file = join(dir, `paste-${Date.now()}.png`);
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, img.bytes);
			} catch (e) {
				console.error(`[bi] paste save failed (${e instanceof Error ? e.message : e})`);
				return history;
			}
			if (sess) sess.images.push(file);
			console.error(`[bi] pasted image ${(img.bytes.length / 1024).toFixed(0)}kb — sent with the next turn (${sess?.images.length ?? 0} staged, one per turn, no tools on image turns)`);
			return history;
		}
		// bi#32 slice 1: /tree browses (numbers resolve against the last
		// listing), /attach stages files for the next turn, /editor
		// composes the prompt in $EDITOR. Custom hotkeys stay scoped
		// (raw-mode input layer).
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
			// bi#68: tree lists through the shared select frame (cursor
			// parks on the first row — picks stay numeric against
			// sess.tree until the bi#69 raw-mode layer).
			await renderSelectList(await format_tree_async(rows), 0, undefined, await activeTheme());
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
			const scoped = loadUserSettings().enabled_models ?? null;
			if (!t.args) {
				// bi#68: model catalog lists through the shared select
				// frame; the cursor highlights the live backend (same
				// BAML walk as the numbers, so `/model <n>` still agrees).
				const currentModel = backend?.model ?? "claude-haiku-4-5";
				await renderSelectList(
					await format_model_list_async(currentModel, { theme: await activeTheme(), enabled: scoped }),
					await model_list_cursor_async(currentModel),
					undefined,
					await activeTheme(),
				);
				return history;
			}
			const numeric = /^\d+$/.test(t.args);
			const m = numeric ? await pick_model_async(Number(t.args)) : await resolve_model_ref_async(t.args);
			if (!m) {
				console.error(numeric ? `no model #${t.args} — bare /model lists numbers` : `unknown model "${t.args}" — bare /model lists the catalog (try provider/id or a number)`);
				return history;
			}
			// Disabled models refuse with their own fix; startup stays
			// permissive (resolve_backend ignores the list) so a bad
			// stored set never bricks the REPL.
			if (!(await is_model_enabled_async(scoped, m.id))) {
				console.error(`model "${m.id}" is disabled — /scoped-models enable ${m.id} to use it`);
				return history;
			}
			if (backend) {
				backend.provider = m.provider;
				backend.model = m.id;
			}
			console.error(`[bi] backend now ${m.provider}/${m.id}`);
			return history;
		}
		if (t.name === "scoped-models") {
			// bi#28: pi's scoped-models selector as verbs over the
			// persisted enablement list (null = all). Refs resolve
			// before any save, so an unknown ref aborts atomically.
			const parts = t.args ? t.args.split(/\s+/) : [];
			const [verb, ...refs] = parts;
			const stored = loadUserSettings();
			if (!verb) {
				await printBlock(await format_scoped_models_async(stored.enabled_models ?? null));
				return history;
			}
			if (verb === "all") {
				try {
					saveUserSettings({ ...stored, enabled_models: undefined });
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				await printBlock(await format_scoped_models_async(null));
				return history;
			}
			if ((verb === "enable" || verb === "disable" || verb === "only") && refs.length > 0) {
				const ids: string[] = [];
				for (const r of refs) {
					const rec = await resolve_model_ref_async(r);
					if (!rec) {
						console.error(`unknown model "${r}" — bare /model lists the catalog (try provider/id)`);
						return history;
					}
					ids.push(rec.id);
				}
				const cur = stored.enabled_models ?? null;
				let next: string[] | null;
				if (verb === "only") {
					next = [...new Set(ids)];
				} else if (verb === "enable") {
					if (cur === null) {
						console.error("[bi] all models already enabled — nothing to do");
						return history;
					}
					next = [...new Set([...cur, ...ids])];
				} else {
					const base = cur ?? await all_model_ids_async();
					next = base.filter((id) => !ids.includes(id));
				}
				const errors = await validate_settings_async(bamlSettings({ ...stored, enabled_models: next ?? undefined }));
				if (errors.length) {
					for (const e of errors) console.error(e);
					return history;
				}
				try {
					saveUserSettings({ ...stored, enabled_models: next ?? undefined });
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				await printBlock(await format_scoped_models_async(next));
				return history;
			}
			console.error("usage: /scoped-models [enable|disable|only <ref...> | all]");
			return history;
		}
		// bi#28: bare /thinking lists levels with pi's descriptions, with
		// an argument it sets the live level (validated by BAML). Budgets
		// reach anthropic turns via thinking_config_for_level; other APIs
		// ignore the config, and non-reasoning models are guarded out.
		if (t.name === "thinking") {
			if (!t.args) {
				await printBlock(await format_thinking_list_async(backend?.thinking ?? "off", { theme: await activeTheme() }));
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
			let label: string | null = null;
			if (sess) {
				const loaded = await loadSessionTranscript(id);
				parent = loaded?.header.parent_session ?? null;
				label = loaded?.header.label ?? null;
			}
			await printBlock(
				await format_session_info_async(id, file, process.cwd(), parent, backend?.provider ?? "anthropic", backend?.model ?? "claude-haiku-4-5", backend?.thinking ?? null, sess?.turn ?? 0, history.length, { label }),
			);
			return history;
		}
		// bi#79: /issues lists BAIS issues through the shared select
		// frame and stages picks into a sticky working set the agent sees
		// every turn. Listing is the VM-free header scan (readdir + line
		// scan); only staged files pay BAML validation, one file each.
		if (t.name === "issues") {
			if (!sess) {
				console.error("[bi] /issues needs a REPL session");
				return history;
			}
			const arg = (t.args ?? "").trim();
			const scan = scanBaisHeaders();
			const byId = new Map(scan.headers.map((h) => [h.id, h]));
			if (arg === "" || arg === "all") {
				const listed = (arg === "all" ? [...scan.headers] : scan.headers.filter((h) => h.status === "Open"))
					.sort((a, b) => a.id.localeCompare(b.id));
				if (!listed.length) {
					console.error(arg === "all" ? "[bi] no BAIS issues — `bi bais new \"title\"` to add one" : "[bi] no open BAIS issues — /issues all lists every status");
					return history;
				}
				// Numbers resolve by position: unparseable rows hold an
				// empty slot so every number stays aligned with its row.
				sess.issueList = listed.map((h) => (h.parseable ? h.id : ""));
				const rows: string[] = [];
				for (let i = 0; i < listed.length; i++) {
					const h = listed[i];
					rows.push(
						h.parseable
							? await format_issue_row_async(i + 1, h.id, h.status, h.kind, h.title, scannedBlockers(h.id, scan, byId))
							: await format_issue_row_async(i + 1, h.file, "?", "?", "(unparseable — bais check names the fix)", []),
					);
				}
				await renderSelectList(rows.join("\n"), 0, undefined, await activeTheme());
				return history;
			}
			const dropM = arg.match(/^drop(?:\s+(.+))?$/);
			if (dropM) {
				const which = (dropM[1] ?? "").trim();
				if (!which || which === "all") {
					const n = sess.stagedIssues.length;
					sess.stagedIssues = [];
					console.error(n ? `[bi] dropped ${n} staged issue(s)` : "[bi] no staged issues");
				} else {
					const at = sess.stagedIssues.indexOf(which);
					if (at === -1) console.error(`[bi] ${which} is not staged (${sess.stagedIssues.length} staged)`);
					else {
						sess.stagedIssues.splice(at, 1);
						console.error(`[bi] dropped ${which} (${sess.stagedIssues.length} staged)`);
					}
				}
				return history;
			}
			let stageId: string;
			if (/^\d+$/.test(arg)) {
				const pick = sess.issueList[Number(arg) - 1];
				if (!pick) {
					console.error(`no issue row ${arg} — bare /issues re-lists (unparseable rows cannot stage)`);
					return history;
				}
				stageId = pick;
			} else {
				stageId = arg;
			}
			const header = byId.get(stageId);
			if (!header || !header.parseable) {
				console.error(`unknown issue "${stageId}" — bare /issues lists numbers and ids`);
				return history;
			}
			// Single-file BAML validation: the only VM call on this path.
			const loaded = await loadStagedIssues([stageId]);
			if (!loaded.staged.length) {
				console.error(`[bi] ${stageId} failed validation — bais check names the fix`);
				return history;
			}
			if (!sess.stagedIssues.includes(stageId)) sess.stagedIssues.push(stageId);
			console.error(`[bi] staged ${stageId} (${sess.stagedIssues.length} staged — full body + ${loaded.staged[0].neighbors.length} neighbor(s) ride every turn until /issues drop)`);
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
				// bi#68: resume lists through the shared select frame; the
				// cursor highlights the live session (same array the
				// numeric pick resolves against, so `/resume <n>` agrees).
				const cur = sess ? sessionIdFromFile(sess.file) : null;
				const at = cur ? rows.findIndex((r) => r.id === cur) : -1;
				await renderSelectList(await format_resume_list_async(rows, cur), at < 0 ? 0 : at, undefined, await activeTheme());
				return history;
			}
			let resumeId = t.args;
			if (/^\d+$/.test(t.args)) {
				const rows = await sessionResumeList();
				const row = rows[Number(t.args) - 1];
				if (!row) {
					console.error(`no session #${t.args} — bare /resume lists numbers`);
					return history;
				}
				resumeId = row.id;
			}
			const loaded = await loadSessionTranscript(resumeId);
			if (!loaded) {
				console.error(`unknown session "${t.args}" — bare /resume lists saved sessions (try an id or number)`);
				return history;
			}
			if (sess) {
				sess.file = loaded.file;
				sess.turn = loaded.history.filter((m) => m.role === "user").length;
				sess.persisted = loaded.history.length;
			}
			console.error(`[bi] resumed ${resumeId} (${loaded.history.length} messages)`);
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
		if (t.name === "clone") {
			// bi#30: pi's "duplicate at the current position" — same
			// transcript under a fresh id with no parent link (unlike
			// /fork), and the REPL switches to the copy.
			if (!sess) return history;
			const srcId = sessionIdFromFile(sess.file);
			const loaded = await loadSessionTranscript(srcId);
			const f = createSessionFile({ cwd: process.cwd(), label: loaded?.header.label ?? undefined });
			appendSessionEntries(
				f,
				history.map((m: any) => ({ role: String(m.role ?? "user"), text: String(m.text ?? ""), provider: backend?.provider ?? null, model: backend?.model ?? null, thinking: backend?.thinking ?? null })),
			);
			sess.file = f;
			sess.persisted = history.length;
			console.error(`[bi] cloned ${srcId} → ${sessionIdFromFile(f)} (independent copy, no parent link)`);
			return history;
		}
		if (t.name === "name") {
			// bi#30: pi's session display name. Bare shows, text sets
			// (BAML-validated, header rewritten in place).
			if (!sess) return history;
			const id = sessionIdFromFile(sess.file);
			const arg = t.args.trim();
			if (!arg) {
				const loaded = await loadSessionTranscript(id);
				console.log(loaded?.header.label ?? "(unnamed — /name <text> to label)");
				return history;
			}
			const problems = await validate_session_label_async(arg);
			if (problems.length) {
				for (const p of problems) console.error(p);
				return history;
			}
			if (!setSessionLabel(sess.file, arg)) {
				console.error(`[bi] name failed — session file unreadable (${sess.file})`);
				return history;
			}
			console.error(`[bi] session ${id} named "${arg}"`);
			return history;
		}
		if (t.name === "export") {
			// bi#30: transcript as markdown (pi exports HTML; bi has no
			// HTML renderer, and the transcript is markdown-shaped).
			if (!sess) return history;
			const id = sessionIdFromFile(sess.file);
			const loaded = await loadSessionTranscript(id);
			if (!loaded) {
				console.error(`[bi] export failed — session file unreadable (${sess.file})`);
				return history;
			}
			// Loaded history keeps role/text only; rehydrate the BAML
			// HistoryEntry shape with null provenance for the export.
			const entries = loaded.history.map((m) => ({ type: "history", role: m.role, text: m.text, provider: null, model: null, thinking: null }));
			const md = await format_session_markdown_async(id, loaded.header.label, loaded.header.timestamp, loaded.header.cwd, entries);
			const dest = t.args.trim() || join(process.cwd(), `${id}.md`);
			try {
				writeFileSync(dest, md);
			} catch (e) {
				console.error(`[bi] export failed (${e instanceof Error ? e.message : e})`);
				return history;
			}
			console.error(`[bi] exported ${loaded.history.length} messages → ${dest}`);
			return history;
		}
		if (t.name === "share") {
			// bi#30: pi's secret-gist fallback as the whole share (no
			// Radius in bi). Same markdown body as /export; gh owns
			// transport, BAML owns the filename + description.
			if (!sess) return history;
			const id = sessionIdFromFile(sess.file);
			const loaded = await loadSessionTranscript(id);
			if (!loaded) {
				console.error(`[bi] share failed — session file unreadable (${sess.file})`);
				return history;
			}
			const entries = loaded.history.map((m) => ({ type: "history", role: m.role, text: m.text, provider: null, model: null, thinking: null }));
			const md = await format_session_markdown_async(id, loaded.header.label, loaded.header.timestamp, loaded.header.cwd, entries);
			const desc = await gist_description_async(id, loaded.header.label);
			const res = shareSessionGist(id, md, desc);
			if ("error" in res) {
				console.error(`[bi] ${res.error}`);
				return history;
			}
			console.error(`[bi] shared ${loaded.history.length} messages (secret gist) → ${res.url}`);
			return history;
		}
		if (t.name === "import") {
			// bi#30: adopt an external JSONL transcript (pi's
			// "import and resume from a JSONL file"). Stays put on
			// anything unimportable — no session switch, no files.
			const src = t.args.trim();
			if (!src) {
				console.error("usage: /import <file.jsonl>");
				return history;
			}
			const id = await importSessionFile(src);
			if (!id) {
				console.error(`[bi] import failed — no valid transcript in ${src}`);
				return history;
			}
			const loaded = await loadSessionTranscript(id);
			if (sess && loaded) {
				sess.file = loaded.file;
				sess.turn = loaded.history.filter((m) => m.role === "user").length;
				sess.persisted = loaded.history.length;
			}
			console.error(`[bi] imported ${src} → ${id} (${loaded?.history.length ?? 0} messages)`);
			return loaded?.history ?? history;
		}
		// bi#29 slice 1: bare lists, get reads, set validates through
		// BAML before persisting, unset drops the key. The remaining
		// bi#29 selectors live as /trust, /config, /oauth, /skills.
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
		if (t.name === "config") {
			// bi#29: pi's config-selector as an $EDITOR edit with BAML
			// revalidate. Temp-file edit, atomic apply: bad JSON or a
			// failed validation leaves settings.json untouched.
			const arg = t.args.trim();
			if (arg === "path") {
				console.log(settingsFile());
				return history;
			}
			if (arg) {
				console.error("usage: /config [path]");
				return history;
			}
			if (!process.stdin.isTTY) {
				console.error("/config needs an interactive terminal ($EDITOR edit)");
				return history;
			}
			const res = await editInExternalEditor(editorCommand(), JSON.stringify(loadUserSettings(), null, 2) + "\n");
			if (res.status !== "complete") {
				console.error("[bi] config edit cancelled — settings unchanged");
				return history;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(res.content);
			} catch {
				console.error("[bi] config is not valid JSON — settings unchanged");
				return history;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				console.error("[bi] config must be a JSON object — settings unchanged");
				return history;
			}
			// Same known-key filter as loadUserSettings: unknown keys
			// are ignored, never persisted.
			const r = parsed as Record<string, unknown>;
			const next: UserSettings = {};
			if (typeof r.default_provider === "string") next.default_provider = r.default_provider;
			if (typeof r.default_model === "string") next.default_model = r.default_model;
			if (typeof r.default_thinking === "string") next.default_thinking = r.default_thinking;
			if (Array.isArray(r.enabled_models) && (r.enabled_models as unknown[]).every((e) => typeof e === "string")) next.enabled_models = r.enabled_models as string[];
			const errors = await validate_settings_async(bamlSettings(next));
			if (errors.length) {
				for (const e of errors) console.error(e);
				console.error("[bi] config invalid — settings unchanged");
				return history;
			}
			try {
				saveUserSettings(next);
			} catch (e) {
				console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
				return history;
			}
			console.error("[bi] config saved");
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
		// bi#71: edit/write results render the BAML-shaped unified diff
		// inline; anything not diffable adds no lines (output unchanged).
		await emitToolDiff(name, out);
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
	// bi#79: staged working set rides every turn (fresh single-file
	// reads, mtime-memoized validation). Missing files prune the set
	// instead of showing ghosts; the raw line stays out of history.
	let issueSection = "";
	if (sess?.stagedIssues.length) {
		const loaded = await loadStagedIssues(sess.stagedIssues);
		if (loaded.missing.length) sess.stagedIssues = sess.stagedIssues.filter((id) => !loaded.missing.includes(id));
		const contexts: string[] = [];
		for (const s of loaded.staged) {
			const f = s.file;
			contexts.push(
				await format_issue_context_async(
					f.issue.id,
					f.issue.title,
					f.issue.status,
					f.issue.kind,
					f.issue.area,
					f.issue.body,
					4000,
					f.edges.map((e) => e.from),
					f.edges.map((e) => e.to),
					f.edges.map((e) => e.kind),
					s.neighbors.map((n) => n.id),
					s.neighbors.map((n) => n.title),
					s.neighbors.map((n) => n.status),
				),
			);
		}
		if (contexts.length) issueSection = `\n\n[BAIS issues — staged via /issues, single-file BAML-validated reads]\n${contexts.join("\n\n")}`;
	}
	const fullPrompt = q + skillsSection + `\n\n[BAIS ready]\n${(await readyBaisIssues()).map((f) => `- ${f.issue.id} ${f.issue.title}`).join("\n")}` + attachSection + issueSection;
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
	// Turn chrome theme, hoisted: every stop/result path below closes
	// with the same palette (summary good/bad, divider, error lines).
	const turnTheme = await activeTheme();
	// bi#32: staged images take a single-shot image turn (no tools — the
	// SendTurnWithImage wire carries none by construction). The first
	// staged image goes with this prompt; the rest wait their turn.
	// Attachments ride along inside fullPrompt. Failures keep the image
	// staged so a retry (login, backend switch) can resend it.
	let imageB64: string | null = null;
	if (sess?.images.length) {
		try {
			imageB64 = readFileSync(sess.images[0]).toString("base64");
		} catch {
			console.error(`[bi] staged image unreadable, dropped: ${sess.images[0]}`);
			sess.images = sess.images.slice(1);
		}
	}
	if (imageB64 && sess) {
		// BAML owns the capability call — offline, key-independent, so it
		// runs before any auth fail-fast inside the image turn.
		let supports = true;
		try {
			supports = await ModelSupportsImage_async(backend.model);
		} catch {}
		if (!supports) {
			status.stop({ failed: true, detail: "image unsupported", turns: 0, messages: withUser.length, theme: turnTheme });
			console.error(`[bi] ${backend.model} doesn't take image parts — /model an image-capable backend or /paste clear to drop the staged image`);
			await stderrRule(turnTheme);
			return withUser;
		}
		const img = await runSingleImageTurn(fullPrompt, {
			provider: backend.provider,
			model: backend.model,
			thinkingLevel: backend.thinking,
			baseUrl: process.env.BI_BASE_URL ?? null,
			imageBase64: imageB64,
			imageMime: "image/png",
		});
		if ("failure" in img) {
			status.stop({ failed: true, detail: `TurnFailure ${img.failure.kind}`, turns: 1, messages: withUser.length, theme: turnTheme });
			console.error(format_turn_error(`TurnFailure ${img.failure.message}`, { theme: turnTheme }));
			const guidance = await GuidanceFor_async(img.failure.kind, backend.provider);
			if (guidance) console.error(guidance);
			await stderrRule(turnTheme);
			return withUser;
		}
		sess.images = sess.images.slice(1);
		if (sess.images.length) console.error(`[bi] ${sess.images.length} image(s) still staged — one per turn`);
		const out = [...withUser, { role: "assistant", text: img.text, clientId: `${backend.provider}/${backend.model}` }];
		status.stop({ failed: false, detail: "", turns: 1, messages: out.length, theme: turnTheme });
		const theme = await activeTheme();
		console.log(await render_markdown_text_async(img.text, { theme }));
		await stderrRule(turnTheme);
		return out;
	}
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
		status.stop({ failed: true, detail: "aborted", turns: 0, messages: history.length, theme: turnTheme });
		console.error("[bi] turn aborted — transcript unchanged (a late VM result is discarded on arrival)");
		await stderrRule(turnTheme);
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
		status.stop({ failed: true, detail: `TurnFailure ${result.failure.kind}`, turns: Math.max(assistantCount, 1), messages: result.messages.length, theme: turnTheme });
		console.error(format_turn_error(`TurnFailure ${result.failure.message}`, { theme: turnTheme }));
		// bi#21: guidance names the fix where bi knows one (the REPL loop
		// is anthropic-pinned today, so the provider is static here).
		const guidance = await GuidanceFor_async(result.failure.kind, "anthropic");
		if (guidance) console.error(guidance);
		await stderrRule(turnTheme);
		return withUser;
	}
	status.stop({ failed: false, detail: "", turns: Math.max(assistantCount, 1), messages: result.messages.length, theme: turnTheme });
	// bi#27: assistant text renders through the BAML markdown shaper.
	const theme = await activeTheme();
	for (const m of result.messages) {
		if ((m as any).role !== "assistant") continue;
		console.log(await render_markdown_text_async((m as any).text ?? JSON.stringify((m as any).content), { theme }));
	}
	await stderrRule(turnTheme);
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
	setCompleter(fn: (line: string, cb: (err: unknown, res: [string[], string]) => void) => void): void {
		// Assigned post-construction: readline reads .completer fresh
		// on every Tab, so late wiring (after skill loads) just works.
		(this.r as any).completer = fn;
	}
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
	// bi#67: pinned bottom-row footer (scroll region + differential
	// repaint on TTY; plain printed line on pipes). Installed lazily on
	// the first turn-end paint, torn down when the REPL leaves.
	const footer = new HostFooter();
	// Tab completes first-word slashes (builtins + loaded skills, same
	// array the loop mutates on /trust reloads) and second-word
	// arguments for commands with a known pool (/model ids, /thinking
	// levels, /theme names, /trust verbs, /settings keys, /help names).
	// BAML owns the match; the callback form keeps readline's sync
	// contract over the VM call.
	try {
		const builtins = (await builtin_slash_commands_async()).map((b: any) => String(b.name));
		reader.setCompleter((line: string, cb: (err: unknown, res: [string[], string]) => void) => {
			const names = [...builtins, ...skills.map((s) => s.name)];
			const second = line.match(/^\/(\S+)[ \t]+(\S*)$/);
			if (!second) {
				complete_slash_async(line, names).then(
					(m: string[]) => cb(null, [m, line]),
					(e: unknown) => cb(null, [[], line]),
				);
				return;
			}
			const prefix = second[2];
			argCandidates(second[1], names).then((pool) =>
				complete_arg_async(prefix, pool).then(
					(m: string[]) => cb(null, [m, prefix]),
					(e: unknown) => cb(null, [[], prefix]),
				),
			);
		});
	} catch {
		// Completion is a convenience — never brick REPL startup.
	}
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
	const sess: ReplSessionState = { file: sessFile, turn: 0, persisted: 0, tree: [], treeRoot: process.cwd(), attachments: [], images: [], skillsDirty: false, stagedIssues: [], issueList: [] };
	try {
		for (;;) {
			// bi#29: /trust swaps the project skill set live — reload on
			// change so the next turn's context matches the decision.
			if (sess.skillsDirty) {
				sess.skillsDirty = false;
				const fresh = await loadSkills(await trustedSkillDirs(true)).catch(() => ({ skills: [], diagnostics: [] }));
				skills.length = 0;
				skills.push(...fresh.skills);
				for (const d of fresh.diagnostics) console.error(`[skills] ${d.file}: ${d.message}`);
				console.error(`[bi] project skills reloaded (${skills.length} active)`);
			}
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
					// bi#67: pinned to the bottom row on TTY, plain print on pipes.
					const theme = await activeTheme();
					const thinking = backend.thinking ?? "default";
					const fallback = await format_repl_footer_async(backend.provider, backend.model, thinking, sess.turn, history.length, { theme });
					footer.show(
						await render_footer_frame_async(backend.provider, backend.model, thinking, sess.turn, history.length, process.stdout.columns ?? 80, { theme }),
						fallback,
					);
				}
			}
		}
	} finally {
		footer.dispose();
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
		// Ready frame renders in BAML (tui.baml render_ready_frame) —
		// first production frame from the component model. HostTui
		// only diffs + writes lines.
		const tui = new HostTui();
		tui.render(
			await render_ready_frame_async(
				ready.map((f) => ({ id: f.issue.id, title: f.issue.title })),
				process.stdout.columns ?? 80,
			),
		);
		if (ready.length === 0) {
			console.log("(no ready BAIS issues — `bi bais list` to see all)");
		} else {
			for (const f of ready) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}`);
		}
		// session hint — bi native .bi (not .pi), validated via BAML SessionHeader
		console.log(`\nSessions: ${getBiSessionsDir()} (${listSessions().length} saved) — try \`bi --continue\` or \`bi run "hello"\``);
		console.log("`bi --help` for commands, `bi bais new \"title\"` to add, `bi run \"prompt\"` to run agent");
		if (process.stdin.isTTY && process.stdout.isTTY) console.log("interactive REPL below — ↑ history, trailing \\ continues lines, /help slashes, /quit or Ctrl-D to leave");
		// interactive REPL: persistent loop with cross-turn history (Ctrl-D or
		// /quit to leave, Ctrl-C at the prompt re-prompts, Ctrl-C mid-turn aborts)
		if (process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, "--print") && !hasFlag(args, "-p")) {
			const { skills, diagnostics } = await loadSkills(await trustedSkillDirs(true)).catch(() => ({ skills: [], diagnostics: [] }));
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
			const { skills, diagnostics } = await loadSkills(await trustedSkillDirs(false));
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
