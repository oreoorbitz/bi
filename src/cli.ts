#!/usr/bin/env node
// bi CLI — minimal pi fork entry point (Orion's first name is Orion, CLI is `bi`).
// Commands mirror pi's provider/model surface that bi actually ports:
//   bi list-providers | list-models [--provider id] | get-model <id> | run <prompt>
// No external deps — uses bi's own provider/models/agent BAML port.

import { getModel, listAllModels, listModels } from "./models.js";
import { getProvider, listProviders } from "./provider.js";
import { runAgent, runSingleImageTurn } from "./agent.js";
import { HttpKeeperHub, LeaseKeeper } from "./keeper.js";
import { HubSubscriber, TerminalNotifier, notifyApprovalRequired, notifyTurnComplete } from "./notify.js";
import { loadBaisIssues, readyBaisIssues, filterReadyIssues, blastRadii, dispatchPack, parseFileClaims, warnUnknownShared, warnUnknownWithheld, createBaisIssue, moveBaisIssue, linkBaisIssues, checkBaisIssues, graphBaisIssues, scanBaisHeaders, scannedBlockers, loadStagedIssues, parseClaimDuration, renewBaisClaim, reapBaisClaims } from "./bais.js";
import { listTools, handleTool, emitToolDiff, setTrustReader } from "./tools.js";
import { listImageModels } from "./image.js";
import { showStagedImage, teardownInlineImages } from "./image-display.js";
import { runAuthStatus, runLogin, runLogout, runOAuthLogin } from "./auth_cli.js";
import { getOAuthFlow } from "./oauth.js";
import { listCredentials } from "./auth.js";
import { parse_args, format_help, is_valid_thinking_level, builtin_slash_commands_async, hotkeys_text_async, format_model_list_async, format_thinking_list_async, format_repl_footer_async, render_footer_frame_async, render_model_line_async, resolve_model_ref_async, pick_model_async, model_list_cursor_async, format_session_info_async, format_resume_list_async, format_tool_start_async, format_tool_done_async, get_theme_async, format_theme_list_async, theme_preview_async, format_settings_list_async, validate_settings_async, is_setting_key_async, resolve_backend_async, format_tree_async, tree_skip_names_async, format_attachment_async, parse_trust_answer_async, format_trust_status_async, format_project_trust_prompt_async, trust_options_async, ModelSupportsImage_async, ListProviders_async, ProviderAuthEnv_async, OAuthRow, format_oauth_status_async, format_skills_list_async, format_skill_history_entry_async, is_model_enabled_async, format_scoped_models_async, all_model_ids_async, validate_session_label_async, format_session_markdown_async, gist_description_async, setup_theme_options_async, setup_analytics_options_async, format_first_run_theme_step_async, format_first_run_analytics_step_async, format_first_run_done_async, format_setup_skipped_async, format_setup_status_async, branch_row_prefix_async, format_branch_row_async, format_branches_list_async, format_branch_summary_async, format_fork_list_async, parse_changelog_async, format_changelog_async, complete_slash_async, complete_arg_async, render_divider_async, setting_keys_async, format_issue_row_async, format_issue_context_async, render_ready_frame_async, render_welcome_frame_async, format_prompt_label, format_image_placeholder_async, staged_image_label_async, GuidanceFor_async } from "../baml_sdk/index.js";
import { loadSkills, formatSkills, skillBody, resolveSlash, skillDirs, type Skill } from "./skills.js";
import { getStoredTrust, setStoredTrust, forgetStoredTrust, type TrustDecision } from "./trust.js";
import { readClipboardImage, writeClipboardText, clipboardSupportsImage, extensionForImageMime, sniffImageMime } from "./clipboard.js";
import { runResultToJsonLines, finalText } from "./events.js";
import { getBiSessionsDir, createSessionFile, listSessions, findMostRecentSession, validateSessionIdOrThrow, appendSessionEntries, loadSessionTranscript, sessionResumeList, sessionIdFromFile, setSessionLabel, importSessionFile, shareSessionGist, detectTerminalThemeFromEnv, sessionBranchList, orderBranchRows, branchSwitchState, BI_AGENT_DIR_ENV } from "./session.js";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { colorizeDiffLines } from "./diff-render.js";
import {
	parseUnifiedDiff, buildHunkQueue, assertQueueCoversDiffOnce, applyDecisionInputs,
	flagSpecFor, reviewToJson, provenanceForFile, gitDiffArgs, parseUntrackedFiles,
	assertSkepticReady, hunkLabel,
	type ReviewDecision, type ReviewDecisionInput, type ReviewProvenance,
} from "./review.js";
import {
	listPending, stageProposal, approveProposal, rejectProposal, ReviewStagingError,
	type ReviewIO, type StagedProposal,
} from "./review-turn.js";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";

// Machine-consumed JSON MUST go through printJson, never console.log:
// console.log to a pipe is async, and process.exit() truncates payloads past
// the 64KB pipe buffer. writeSync drains before exit. New --json emits: use this.
function printJson(obj: unknown): void {
	writeSync(1, JSON.stringify(obj, null, 2) + "\n");
}
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
		if (await get_theme_async(name)) return name;
		// bi#105: custom theme files resolve by validated content name.
		if ((await listCustomThemes()).some((t) => t.name === name)) return name;
		return "default";
	} catch {
		return "default";
	}
}

async function activeTheme(): Promise<string | null> {
	if (!process.stdout.isTTY || process.env.NO_COLOR != null) return null;
	return readActiveTheme();
}

// Shared theme persist (bi#101 submenu + /theme verb): validates the
// name, writes theme.json, reports. True on success. bi#105: custom
// theme files (BAML-validated) commit by content name; a malformed
// file refuses with its row-level reasons, never persisted.
async function saveTheme(name: string): Promise<boolean> {
	if (await get_theme_async(name)) return writeThemeName(name);
	if ((await listCustomThemes()).some((t) => t.name === name)) return writeThemeName(name);
	// Name a broken file precisely: it exists but refused validation.
	if (await refuseBrokenTheme(name)) return false;
	console.error(`unknown theme "${name}" — /theme lists ${(await allThemeNames()).join("/")}`);
	return false;
}

// A *.json file the user MEANT (stem or content name matches) but that
// refuses validation: print its row-level reasons, never persist.
async function refuseBrokenTheme(name: string): Promise<boolean> {
	const dir = customThemesDir();
	if (!existsSync(dir)) return false;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const path = join(dir, file);
		const loaded = await validateCustomFile(path);
		if (!("reasons" in loaded)) continue;
		let contentName = "";
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).name === "string") {
				contentName = (parsed as Record<string, unknown>).name as string;
			}
		} catch { /* reason already names the parse failure */ }
		if (file.slice(0, -5) === name || contentName === name) {
			for (const reason of loaded.reasons) console.error(`[bi] theme refused — ${reason}`);
			return true;
		}
	}
	return false;
}

function writeThemeName(name: string): boolean {
	try {
		mkdirSync(dirname(themeFile()), { recursive: true });
		writeFileSync(themeFile(), JSON.stringify({ name }) + "\n");
	} catch (e) {
		console.error(`[bi] theme persist failed (${e instanceof Error ? e.message : e})`);
		return false;
	}
	return true;
}

// Block chrome: a BAML-shaped faint rule closes each REPL output block
// (turn on stderr, slash listings on stdout) so the next prompt never
// crowds the last line. Width follows the stream being written.
async function stderrRule(theme: string | null): Promise<void> {
	const c = process.stderr.columns;
	process.stderr.write((await render_divider_async(typeof c === "number" && c > 0 ? c : termWidth(), { theme })) + "\n");
}

async function stdoutRule(theme: string | null): Promise<void> {
	process.stdout.write((await render_divider_async(termWidth(), { theme })) + "\n");
}

async function printBlock(text: string): Promise<void> {
	console.log(text);
	await stdoutRule(await activeTheme());
}

// Second-word Tab pools per slash command. Static pools mirror the
// BAML-validated sets (thinking levels, theme names, trust verbs);
// dynamic pools come from the VM (model catalog, setting keys,
// provider ids) or the host (session ids, filesystem paths).
// Free-text commands (name, copy payloads) complete nothing — never guess.
async function argCandidates(cmd: string, names: string[], prefix = ""): Promise<string[]> {
	try {
		switch (cmd) {
			case "model":
			case "scoped-models":
				return cmd === "model" ? await all_model_ids_async() : ["enable", "disable", "only", "all", ...(await all_model_ids_async())];
			case "thinking":
				return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			case "theme":
				// bi#105: completion follows the merged catalog
				// (builtins + valid custom theme files).
				return await allThemeNames();
			case "trust":
				return ["allow", "deny", "session", "forget"];
			case "changelog":
				return ["all"];
			case "settings":
				return await setting_keys_async();
			case "issues":
				return [...scanBaisHeaders().headers.map((h) => h.id), "all", "drop"];
			case "bais":
				return ["new", "move", "link", ...scanBaisHeaders().headers.map((h) => h.id)];
			case "help":
				return names.map((n) => n.replace(/^\//, ""));
			case "login":
			case "logout":
			case "oauth":
				return (await ListProviders_async()).map((p: any) => String(p.id ?? p));
			case "resume":
			case "branches":
				return (await sessionResumeList()).map((r) => r.id);
			case "tree":
			case "attach":
			case "import":
			case "export":
				return completePathPrefix(prefix);
			default:
				return [];
		}
	} catch {
		return [];
	}
}

// Filesystem-path completion lives in `./paths.js` (bi#159:
// recursive fuzzy, dotfile-aware, quote-round-tripped); call sites
// below use it unchanged.

// bi#29: user settings (~/.bi/settings.json). Three backend-default keys
// in v1; BAML owns schema + validation + precedence, host owns FS.
// Unknown keys on disk are ignored (forward-compatible); a corrupt file
// resolves empty with a warning instead of bricking startup.
export interface UserSettings {
	default_provider?: string;
	default_model?: string;
	default_thinking?: string;
	// bi#171: "off" | "unfocused" | "always"; absent = disabled (zero bytes).
	notifications?: string;
	enabled_models?: string[];
	// bi#93 first-run answers (bi#30): setup_done marks the install as
	// onboarded so bi never re-prompts; share_analytics records consent
	// only (bi collects no telemetry). Absent = predates the marker.
	setup_done?: boolean;
	share_analytics?: boolean;
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
		if (typeof raw?.notifications === "string") out.notifications = raw.notifications;
		if (Array.isArray(raw?.enabled_models) && raw.enabled_models.every((e: unknown) => typeof e === "string")) out.enabled_models = raw.enabled_models;
		if (typeof raw?.setup_done === "boolean") out.setup_done = raw.setup_done;
		if (typeof raw?.share_analytics === "boolean") out.share_analytics = raw.share_analytics;
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
function bamlSettings(s: UserSettings): { default_provider: string | null; default_model: string | null; default_thinking: string | null; notifications: string | null; enabled_models: string[] | null } {
	return { default_provider: s.default_provider ?? null, default_model: s.default_model ?? null, default_thinking: s.default_thinking ?? null, notifications: s.notifications ?? null, enabled_models: s.enabled_models ?? null };
}

// BAML VM errors arrive as "baml error: baml.errors.Kind: message" —
// strip the wrapper so users see the policy message BAML wrote.
function bamlErrorMessage(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return raw.replace(/^baml error: (baml\.errors\.\w+: )?/, "").split("\n")[0];
}
import { HostTui, HostFooter, renderSelectList, releaseReplTui, retainReplTui, runTranscriptSearch, termWidth, composeFrame } from "./tui.js";
import { FullscreenSession, fullscreenRequested, teeOutputTo } from "./screen-fullscreen.js";
import { KindStatus, statusEventTailUpdater } from "./status.js";
import { ActionLog, safeJson } from "./actionlog.js";
import { promptAvailable, askEdit, askText, pickList, pickListWithPreview, stageBaseFrame, type SlashPool } from "./prompt.js";
import { completePathPrefix, splitSecondWord, unquotePath } from "./paths.js";
import { allThemeNames, customThemesDir, listCustomThemes, mergedThemeList, previewForTheme, validateCustomFile } from "./theme-files.js";
import { getKeybindingsPath, getUserKeybindings, listKeybindingRows, loadKeybindingsFile, reloadKeybindings, renderKeybindingJson, renderKeybindingList, resetKeybindings, saveKeybindings, type KeybindingFileEntry } from "./keybindings.js";
import { screenModelAvailable, screenPickModel } from "./screen-model.js";
import { format_status, format_turn_summary, format_turn_error } from "../baml_sdk/index.js";
import { runBiLoop } from "./agent_loop.js";
import { streamTextIncremental } from "./incremental.js";
import { editInExternalEditor, editorCommand } from "./editor.js";
import { footerCwd, gitBranch } from "./footer_info.js";
import { printMarkdownText } from "./markdown.js";
import { replayCompactionBlocks } from "./compaction.js";
import { printCompactionSummary, printSkillBlock } from "./summary-blocks.js";
import { GoTuiSeam, goTuiRequested, fixtureLlmFn } from "./tui_seam.js";

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
                   [--image <path> stages one PNG/JPEG/WebP/GIF for a single-shot image turn]
                   [--azure-resource <r> --azure-deployment <d> [--azure-api-version <v>]]
  bi bais list [--json]
  bi bais ready [--json] [--order blast-radius]
  bi bais dispatch --agents N [--json] [--briefs]   # dry-run swarm pack, never mutates
  bi bais goal <start|sketch|commit|status|switch> [--approve]  # per-directory campaign interview (bi#132)
  bi bais new "title" --kind <Kind> [--area <area>] [--status <Status>] [--body <md>] [--blocks <id> --depends-on <id>]
  bi bais move <id> <Status> [--as <owner> --for 4h]
  bi bais link <from> <Kind> <to>   # no self-links, ends must exist, cycles refuse with the path
  bi bais renew <id> --as <owner> [--for 4h]
  bi bais reap [--now <instant>]
  bi bais check [--json]
  bi bais graph --from <id> [--json]
  bi review [<ref>] [--json] [--decide <file>] [--provenance <file>] [--apply]   # hunk queue with provenance (bi#138, read-only unless --apply)
  bi keybindings [list [--json] | set <id> <keys...> | unset <id> | reset]   # ~/.bi/keybindings.json, BAML-validated
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

// bi#111: repeatable edge flags (--blocks A --blocks B). Collects every
// `--name value` and `--name=value` occurrence in order.
function getAllFlags(args: string[], name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
		else if (name.startsWith("--") && args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1));
	}
	return out;
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
	// Slice 6: TTY gets the pi-tui trust selector (BAML rows, safe
	// middle preselected); Esc cancels to deny (fail closed, bi#55).
	// Pipes and BI_SCREEN=0 keep the one-line reader byte-identical.
	const opts = await trust_options_async();
	let parsed: string | null;
	if (promptAvailable()) {
		const at = await pickList(
			"Trust this project?",
			opts.map((o) => ({ label: o.label, description: o.description })),
			1,
		);
		if (at === null) {
			console.error(`[bi] trust cancelled — project denied (${process.cwd()} stays untrusted; /trust to decide)`);
			effectiveTrust = "deny";
			return "deny";
		}
		parsed = opts[at].decision;
	} else {
		parsed = await parse_trust_answer_async((await askOneLine("Trust this project? [y]es / [n]o / [s]ession-only: ")).trim());
	}
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

// raw carries the REPL's line-input suspend/resume for pi-tui modals;
// null off-REPL or on pipes (numeric fallback, byte-identical).
async function handleSlash(line: string, skills: Skill[], history: any[], signal?: TurnSignal, backend?: ReplBackend, sess?: ReplSessionState, raw?: { suspend(): void; resume(): void } | null): Promise<any[] | "quit" | "none"> {
	// bi#158: /search is a host viewport operation, not BAML dispatch —
	// it reads the in-memory history (same source /export serializes)
	// and writes no session state, so it never reaches resolveSlash
	// (no registry entry by design). Suspends readline exactly like a
	// modal (same suspend/resume pair) so the alt screen owns stdin.
	if (/^\s*\/search(?:\s|$)/.test(line)) {
		if (raw) raw.suspend();
		try {
			await runTranscriptSearch(history, dirname(getBiSessionsDir()));
		} finally {
			if (raw) raw.resume();
		}
		return history;
	}
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
			// bi#158: host viewport command (no BAML registry entry —
			// handleSlash intercepts before resolveSlash).
			lines.push("  /search — Search the session transcript in-terminal (TTY only; pipes use /export)");
			// bi#107: deliberate divergence — bi has no third-party
			// extension surface. Pi's extensions are TS modules running
			// code inside the agent loop (lifecycle/tools/commands/UI);
			// that would break bi's BAML-owns-LLM split, so skills
			// (auditable markdown in .bi/skills + ~/.bi/skills, /trust
			// gated, /skills to list) are the only command surface.
			lines.push("extensions: none by design — skills are the only third-party surface (bi#107)");
			await printBlock(lines.join("\n"));
			return history;
		}
		if (t.name === "reload") {
			const fresh = await loadSkills(await trustedSkillDirs(true));
			console.error(`[bi] reloaded ${fresh.skills.length} skill(s)`);
			// bi#91: /reload also picks up keybindings.json edits (loud on
			// unknown ids / bad key names, valid subset still applies).
			const kb = await reloadKeybindings();
			if (kb.errors.length) console.error(`[bi] keybindings reloaded with ${kb.errors.length} error(s) — valid overrides applied`);
			else console.error(`[bi] reloaded keybindings (${kb.applied} override(s))`);
			return history;
		}
		if (t.name === "compact") {
			console.error("[bi] per-run compaction already ran inside each turn (history is never truncated without a summary)");
			return history;
		}
		if (t.name === "login") {
			// bi#195: bare /login opens the interactive picker (provider
			// list → hidden key input or OAuth dialog). Suspend readline
			// around the modals like every other modal slash — the
			// askWithEditor finally already rebuilt it, and a live
			// readline echoes every typed byte (the key!) to stdout
			// (drill: scripts/login-flow.mjs lf-repl-hidden). The REPL
			// engages on a TTY only, so both prompts work; piped
			// `bi run "/login…"` surfaces the clean non-TTY refusal
			// instead. Errors stay in-session (no process.exit).
			if (raw) raw.suspend();
			try {
				await runLogin(["login", ...t.args.split(/\s+/).filter((s) => s.length > 0)]);
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
			} finally {
				if (raw) raw.resume();
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
			// bi#102: bare /oauth lists with live status; `/oauth <n|id>`
			// selects a row and starts its flow (OAuth where a flow is
			// registered, API-key login otherwise). Numbers address the
			// displayed board order 1:1.
			const arg = t.args.trim();
			try {
				const providers = await ListProviders_async();
				if (arg) {
					let id: string | undefined;
					if (/^\d+$/.test(arg)) {
						const p = providers[Number(arg) - 1] as any;
						id = p ? String(p.id ?? p) : undefined;
					} else {
						const p = providers.find((q: any) => String(q.id ?? q) === arg) as any;
						id = p ? String(p.id ?? p) : undefined;
					}
					if (!id) {
						console.error(`unknown provider "${arg}" — bare /oauth lists numbers and ids`);
						return history;
					}
					if (getOAuthFlow(id)) await runOAuthLogin(id);
					else await runLogin(["login", id]);
					return history;
				}
				const stored = await listCredentials();
				const rows = [];
				for (const p of providers) {
					const env = await ProviderAuthEnv_async(p.id);
					const s = stored.find((c) => c.provider_id === p.id);
					if (s) rows.push(new OAuthRow({ provider_id: p.id, source: "stored", cred_type: s.type, auth_env: env, expires: s.expires ?? null }));
					else if (env && process.env[env]) rows.push(new OAuthRow({ provider_id: p.id, source: "env", cred_type: null, auth_env: env, expires: null }));
					else rows.push(new OAuthRow({ provider_id: p.id, source: "none", cred_type: null, auth_env: env, expires: null }));
				}
				await printBlock(await format_oauth_status_async(rows, Date.now()));
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
		// bi#105: bare /theme on TTY opens the interactive selector
		// with LIVE preview (highlight repaints before Enter commits,
		// Esc keeps); pipes keep the verb paths byte-identical in
		// shape (list/preview/set, now including custom theme files).
		if (t.name === "theme") {
			if (!t.args || t.args === "list") {
				// TTY picks interactively (Enter commits, Esc keeps the
				// printed list); pipes keep today's print path.
				if (!t.args && raw && promptAvailable()) {
					const names = await allThemeNames();
					const customs = await listCustomThemes();
					const descs = new Map(customs.map((c) => [c.name, c.description]));
					const rows = names.map((label) => ({
						label,
						description: descs.get(label) ?? "",
					}));
					const cur = await readActiveTheme();
					raw.suspend();
					let at: number | null;
					try {
						at = await pickListWithPreview(
							"Theme (↑↓ previews live · Enter sets · Esc keeps)",
							rows,
							Math.max(0, names.indexOf(cur)),
							async (i) => (await previewForTheme(names[i]!)) ?? `no preview for "${names[i]}"`,
						);
					} finally {
						raw.resume();
					}
					if (at === null) {
						await printBlock(await mergedThemeList(cur));
						return history;
					}
					if (!(await saveTheme(names[at]!))) return history;
					console.error(`[bi] theme now ${names[at]}`);
					return history;
				}
				await printBlock(await mergedThemeList(await readActiveTheme()));
				return history;
			}
			if (t.args === "preview") {
				const previews: string[] = [];
				for (const name of await allThemeNames()) {
					previews.push((await previewForTheme(name)) ?? `${name}: (unresolvable)`);
				}
				await printBlock(previews.join("\n"));
				return history;
			}
			if (!(await saveTheme(t.args))) return history;
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
			const file = join(dir, `paste-${Date.now()}.${extensionForImageMime(img.mime)}`);
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
			// bi#159: a quoted completion (`"my dir/"`) reads back whole.
			const arg = unquotePath(t.args);
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
			// parks on the first row). bi#69: TTY picks by arrows (Enter
			// reuses the numeric path — dirs browse, files hint /attach);
			// pipes keep today's path byte-identical.
			const treeText = await format_tree_async(rows);
			const treeTheme = await activeTheme();
			if (sess && rows.length > 0 && raw && promptAvailable()) {
				// Same 1:1 split as renderSelectList, so the picked index
				// addresses sess.tree directly. Static list on pipes and
				// BI_SCREEN=0.
				const disp = treeText.split("\n").filter((l) => l.length > 0);
				raw.suspend();
				let at: number | null;
				try {
					at = await pickList("Browse (Enter opens, Esc keeps)", disp.map((label) => ({ label })), 0);
				} finally {
					raw.resume();
				}
				if (at !== null && disp[at] && rows[at]) {
					return handleSlash(`/tree ${at + 1}`, skills, history, signal, backend, sess, raw);
				}
			}
			await renderSelectList(treeText, 0, undefined, treeTheme);
			if (capped) console.error("[bi] tree capped at 200 entries, depth 3 — narrow with /tree <dir>");
			return history;
		}
		if (t.name === "attach") {
			if (!t.args.trim()) {
				if (!sess || !sess.attachments.length) console.log("(no staged files)");
				else for (const f of sess.attachments) console.log(`staged: ${f}`);
				return history;
			}
			// bi#159: a quoted completion (`"my dir/file.md"`) reads back whole.
			const arg = unquotePath(t.args);
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
			const applyModelRef = async (ref: string) => {
				const numeric = /^\d+$/.test(ref);
				const m = numeric ? await pick_model_async(Number(ref)) : await resolve_model_ref_async(ref);
				if (!m) {
					console.error(numeric ? `no model #${ref} — bare /model lists numbers` : `unknown model "${ref}" — bare /model lists the catalog (try provider/id or a number)`);
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
				// bi#121: the switch persists — next launch resolves it
				// from settings.json (startup stays permissive: a stale
				// id falls back to builtins with a warning, never a brick).
				try {
					saveUserSettings({ ...loadUserSettings(), default_provider: m.provider, default_model: m.id });
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return history;
				}
				console.error(`[bi] backend now ${m.provider}/${m.id} (saved)`);
				return history;
			};
			if (!t.args) {
				// bi#68: model catalog lists through the shared select
				// frame; the cursor highlights the live backend (same
				// BAML walk as the numbers, so `/model <n>` still agrees).
				const currentModel = backend?.model ?? "claude-haiku-4-5";
				const theme = await activeTheme();
				const text = await format_model_list_async(currentModel, { theme, enabled: scoped });
				const cursor = await model_list_cursor_async(currentModel);
				// Screen mode (pi-tui SelectList): default on TTY unless
				// BI_SCREEN=0. Values are model ids, resolved through the
				// same apply path. A screen failure falls through to the
				// host picker below — /model never bricks on widgets.
				if (raw && screenModelAvailable()) {
					let failed = false;
					raw.suspend();
					try {
						const id = await screenPickModel(currentModel, scoped);
						if (id !== null) return applyModelRef(id);
					} catch (e) {
						failed = true;
						console.error(`[bi] screen picker failed (${e instanceof Error ? e.message : e}) — falling back`);
					} finally {
						raw.resume();
					}
					if (!failed) {
						await renderSelectList(text, cursor, undefined, theme);
						return history;
					}
				}
				// TTY picks by arrows (Enter switches, Esc keeps the list
				// with numbers still working); pipes keep today's path
				// byte-identical.
				if (raw && promptAvailable()) {
					// Same split as renderSelectList, so the picked index
					// addresses the displayed rows 1:1 (headers included).
					const rows = text.split("\n").filter((l) => l.length > 0);
					raw.suspend();
					let at: number | null;
					try {
						at = await pickList(
							"Pick model (↑↓ navigate · Enter switches · Esc keeps)",
							rows.map((label) => ({ label })),
							cursor,
						);
					} finally {
						raw.resume();
					}
					if (at === null) {
						await renderSelectList(text, cursor, undefined, theme);
						return history;
					}
					const line = rows[at] ?? "";
					const num = /^\d+/.exec(line.replace(/\x1b\[[0-9;]*m/g, ""));
					if (!num) {
						console.error("that row is a provider header — pick a numbered model");
						return history;
					}
					return applyModelRef(num[0]);
				}
				await renderSelectList(text, cursor, undefined, theme);
				return history;
			}
			return applyModelRef(t.args);
		}
		if (t.name === "scoped-models") {
			// bi#28: pi's scoped-models selector as verbs over the
			// persisted enablement list (null = all). Refs resolve
			// before any save, so an unknown ref aborts atomically.
			const parts = t.args ? t.args.split(/\s+/) : [];
			const [verb, ...refs] = parts;
			const stored = loadUserSettings();
			// Shared validate → persist → print tail (verbs and the
			// bare toggle below resolve refs first, so saves stay atomic).
			const commitEnabled = async (next: string[]): Promise<void> => {
				const errors = await validate_settings_async(bamlSettings({ ...stored, enabled_models: next }));
				if (errors.length) {
					for (const e of errors) console.error(e);
					return;
				}
				try {
					saveUserSettings({ ...stored, enabled_models: next });
				} catch (e) {
					console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
					return;
				}
				await printBlock(await format_scoped_models_async(next));
			};
			if (!verb) {
				const cur = stored.enabled_models ?? null;
				// TTY toggles by arrows (Enter flips the row, Esc keeps the
				// summary); pipes keep today's summary byte-identical.
				if (raw && promptAvailable()) {
					const ids = await all_model_ids_async();
					if (ids.length === 0) {
						await printBlock(await format_scoped_models_async(cur));
						return history;
					}
					const rows = ids.map((id) => `${cur === null || cur.includes(id) ? "[x]" : "[ ]"} ${id}`);
					raw.suspend();
					let at: number | null;
					try {
						at = await pickList("Toggle models (Enter flips, Esc keeps)", rows.map((label) => ({ label })), 0);
					} finally {
						raw.resume();
					}
					const id = at === null ? undefined : ids[at];
					if (!id) {
						await printBlock(await format_scoped_models_async(cur));
						return history;
					}
					const base = cur ?? ids;
					const next = cur === null || cur.includes(id) ? base.filter((e) => e !== id) : [...base, id];
					if (next.length === 0) {
						console.error("[bi] refusing to disable the last model — /scoped-models all resets to all-enabled");
						return history;
					}
					await commitEnabled(next);
					return history;
				}
				await printBlock(await format_scoped_models_async(cur));
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
				let next: string[];
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
				await commitEnabled(next);
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
			// bi#121: same persist rule as /model (startup resolves
			// default_thinking; invalid levels can't reach here).
			try {
				saveUserSettings({ ...loadUserSettings(), default_thinking: t.args });
			} catch (e) {
				console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
				return history;
			}
			console.error(`[bi] thinking now ${t.args} (saved)`);
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
			// Shared stage-by-id tail (numeric picks, raw picks, id args).
			const stageById = async (stageId: string): Promise<any[] | "quit" | "none"> => {
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
			};
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
					let row = h.parseable
						? await format_issue_row_async(i + 1, h.id, h.status, h.kind, h.title, scannedBlockers(h.id, scan, byId))
						: await format_issue_row_async(i + 1, h.file, "?", "?", "(unparseable — bais check names the fix)", []);
					// bi#112: the staged working set rides every turn but
					// was invisible — staged rows carry their mark in bare
					// and `all` listings (host-suffixed; the BAML row shape
					// is untouched). The mark derives from the live set, so
					// dropping clears both the set and the marks.
					if (h.parseable && sess.stagedIssues.includes(h.id)) row += " [staged]";
					rows.push(row);
				}
				const theme = await activeTheme();
				// TTY picks by arrows (Enter stages, Esc keeps the list with
				// numbers still working); pipes keep today's path
				// byte-identical.
				if (raw && promptAvailable()) {
					raw.suspend();
					let at: number | null;
					try {
						at = await pickList("Stage issue (Enter stages, Esc keeps)", rows.map((label) => ({ label })), 0);
					} finally {
						raw.resume();
					}
					if (at === null) {
						await stdoutRule(theme);
						return history;
					}
					const id = sess.issueList[at];
					if (!id) {
						console.error(`row ${at + 1} is unparseable — bais check names the fix`);
						await stdoutRule(theme);
						return history;
					}
					const out = await stageById(id);
					await stdoutRule(theme);
					return out;
				}
				await renderSelectList(rows.join("\n"), 0, undefined, theme);
				return history;
			}
			// bi#110: read the full body + edges as the human (same
			// loader and formatter the agent's staged context uses).
			const showM = arg.match(/^show\s+(\S+)\s*$/);
			if (showM) {
				let showId = showM[1];
				if (/^\d+$/.test(showId)) {
					const pick = sess.issueList[Number(showId) - 1];
					if (!pick) {
						console.error(`no issue row ${showId} — bare /issues re-lists`);
						return history;
					}
					showId = pick;
				}
				const loaded = await loadStagedIssues([showId]);
				const s = loaded.staged[0];
				if (!s) {
					console.error(`unknown issue "${showM[1]}" — bare /issues lists numbers and ids`);
					return history;
				}
				const f = s.file;
				await printBlock(
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
				return history;
			}
			// bi#112: the staged working set, listed — id + title +
			// neighbor count per row. Read-only (no picker); an empty set
			// reads empty, never errors. Unresolvable ids name their fix
			// instead of breaking the view.
			if (arg === "staged") {
				if (!sess.stagedIssues.length) {
					console.error("[bi] no staged issues — /issues <n|id> stages into the working set");
					return history;
				}
				const loaded = await loadStagedIssues(sess.stagedIssues);
				const byStagedId = new Map(loaded.staged.map((s) => [s.file.issue.id, s]));
				const stagedRows: string[] = [];
				let n = 1;
				for (const id of sess.stagedIssues) {
					const s = byStagedId.get(id);
					if (!s) {
						stagedRows.push(`${n}  ${id} (unresolvable — bais check names the fix)`);
					} else {
						const f = s.file;
						const title = f.issue.title.length > 60 ? f.issue.title.slice(0, 57) + "..." : f.issue.title;
						const nn = s.neighbors.length;
						stagedRows.push(`${n}  ${f.issue.id} [${f.issue.status}/${f.issue.kind}] ${title} (${nn} neighbor${nn === 1 ? "" : "s"})`);
					}
					n++;
				}
				const theme = await activeTheme();
				await renderSelectList(stagedRows.join("\n"), 0, undefined, theme);
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
			return stageById(stageId);
		}
		// bi#109: file or advance BAIS issues without leaving the REPL
		// (same host lib the `bi bais` CLI uses; errors stay in-session,
		// never process.exit).
		if (t.name === "bais") {
			const rest = (t.args ?? "").trim();
			const flag = (name: string): string | undefined => {
				const m = rest.match(new RegExp(`--${name}\\s+("[^"]+"|'[^']+'|\\S+)`));
				if (!m) return undefined;
				const v = m[1];
				return v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
			};
			const flagAll = (name: string): string[] => {
				const out: string[] = [];
				const re = new RegExp(`--${name}\\s+("[^"]+"|'[^']+'|\\S+)`, "g");
				for (const m of rest.matchAll(re)) {
					const v = m[1];
					out.push(v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v);
				}
				return out;
			};
			const newM = rest.match(/^new\s+("[^"]+"|'[^']+'|\S+)\s*([\s\S]*)$/);
			if (newM) {
				const rawTitle = newM[1];
				const title = rawTitle.length > 1 && ((rawTitle.startsWith('"') && rawTitle.endsWith('"')) || (rawTitle.startsWith("'") && rawTitle.endsWith("'"))) ? rawTitle.slice(1, -1) : rawTitle;
				try {
					// bi#111: edges at birth (repeatable --blocks/--depends-on).
					const edges = [
						...flagAll("blocks").map((to) => ({ kind: "Blocks", to })),
						...flagAll("depends-on").map((to) => ({ kind: "DependsOn", to })),
					];
					const file = await createBaisIssue({ title, kind: flag("kind"), area: flag("area"), body: flag("body"), status: flag("status"), edges });
					console.error(`[bi] filed ${file.issue.id} — ${file.issue.title}`);
				} catch (e) {
					console.error(`[bi] file failed (${e instanceof Error ? e.message : e})`);
				}
				return history;
			}
			const linkM = rest.match(/^link\s+(\S+)\s+(\S+)\s+(\S+)\s*$/);
			if (linkM) {
				try {
					const file = await linkBaisIssues(linkM[1], linkM[2], linkM[3]);
					console.error(`[bi] linked ${file.issue.id} ${linkM[2]} ${linkM[3]}`);
				} catch (e) {
					console.error(`[bi] link failed (${e instanceof Error ? e.message : e})`);
				}
				return history;
			}
			const moveM = rest.match(/^move\s+(\S+)\s+(\S+)\s*([\s\S]*)$/);
			if (moveM) {
				try {
					const as = flag("as");
					const forRaw = flag("for");
					let forMs: number | undefined;
					if (forRaw != null) {
						const p = parseClaimDuration(forRaw);
						if (p == null) throw new Error(`--for ${JSON.stringify(forRaw)} needs <n>s|m|h|d`);
						forMs = p;
					}
					const file = await moveBaisIssue(moveM[1], moveM[2], undefined, as != null ? { as, forMs } : undefined);
					console.error(`[bi] moved ${file.issue.id} → ${file.issue.status}`);
				} catch (e) {
					console.error(`[bi] move failed (${e instanceof Error ? e.message : e})`);
				}
				return history;
			}
			console.error('usage: /bais new "title" [--kind K] [--area A] [--body B] [--status S] [--blocks <id> --depends-on <id>] | /bais move <id> <Status> [--as O] [--for D] | /bais link <from> <Kind> <to>');
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
			let resumeId = t.args;
			if (!t.args) {
				const list = await sessionResumeList();
				// bi#68: resume lists through the shared select frame; the
				// cursor highlights the live session (same array the
				// numeric pick resolves against, so `/resume <n>` agrees).
				const cur = sess ? sessionIdFromFile(sess.file) : null;
				const at = cur ? list.findIndex((r) => r.id === cur) : -1;
				const theme = await activeTheme();
				const text = await format_resume_list_async(list, cur);
				// TTY picks by arrows (Enter resumes, Esc keeps the list with
				// numbers still working); pipes keep today's path
				// byte-identical.
				if (raw && promptAvailable() && list.length > 0) {
					// Same split as renderSelectList, so the picked index
					// addresses the displayed rows 1:1.
					const disp = text.split("\n").filter((l) => l.length > 0);
					raw.suspend();
					let pick: number | null;
					try {
						pick = await pickList("Resume session (Enter resumes, Esc keeps)", disp.map((label) => ({ label })), at < 0 ? 0 : at);
					} finally {
						raw.resume();
					}
					const row = pick === null ? undefined : list[pick];
					if (!row) {
						await renderSelectList(text, at < 0 ? 0 : at, undefined, theme);
						return history;
					}
					resumeId = row.id;
				} else {
					await renderSelectList(text, at < 0 ? 0 : at, undefined, theme);
					return history;
				}
				// bi#100: a bare-pick resumeId must not fall through to the
				// numeric/verb dispatch below (t.args is "" there, so the
				// verb filter matched everything and Enter never resumed).
			} else if (/^\d+$/.test(t.args)) {
				const rows = await sessionResumeList();
				const row = rows[Number(t.args) - 1];
				if (!row) {
					console.error(`no session #${t.args} — bare /resume lists numbers`);
					return history;
				}
				resumeId = row.id;
			} else {
				// bi#100: non-numeric args filter id/label/cwd
				// (case-insensitive). An exact id still resumes directly;
				// one match resumes it; several pick from the filtered
				// rows on TTY (pipes keep the printed frame + id hint);
				// zero matches read empty, never error.
				const rows = await sessionResumeList();
				const exact = rows.find((r) => r.id === t.args);
				if (exact) {
					resumeId = exact.id;
				} else {
					const q = t.args.toLowerCase();
					const filtered = rows.filter(
						(r) =>
							r.id.toLowerCase().includes(q) ||
							(r.label ?? "").toLowerCase().includes(q) ||
							r.cwd.toLowerCase().includes(q),
					);
					if (filtered.length === 0) {
						console.error(`no sessions match "${t.args}" — bare /resume lists saved sessions`);
						return history;
					}
					if (filtered.length === 1) {
						resumeId = filtered[0].id;
					} else {
						const cur = sess ? sessionIdFromFile(sess.file) : null;
						const theme = await activeTheme();
						const text = await format_resume_list_async(filtered, cur);
						// bi#100: TTY picks from the filtered rows directly
						// (Enter resumes, Esc keeps the printed list); pipes
						// keep the print+hint path byte-identical.
						if (raw && promptAvailable() && filtered.length > 0) {
							const disp = text.split("\n").filter((l) => l.length > 0);
							raw.suspend();
							let pick: number | null;
							try {
								pick = await pickList(`Resume — ${filtered.length} match "${t.args}" (Enter resumes, Esc lists)`, disp.map((label) => ({ label })), 0);
							} finally {
								raw.resume();
							}
							const row = pick === null ? undefined : filtered[pick];
							if (row) {
								resumeId = row.id;
							} else {
								await renderSelectList(text, 0, undefined, theme);
								console.error(`${filtered.length} match "${t.args}" — /resume <id> resumes (numbers above are display-only)`);
								return history;
							}
						} else {
							await renderSelectList(text, 0, undefined, theme);
							console.error(`${filtered.length} match "${t.args}" — /resume <id> resumes (numbers above are display-only)`);
							return history;
						}
					}
				}
			}
			const loaded = await loadSessionTranscript(resumeId);
			if (!loaded) {
				console.error(`unknown session "${resumeId}" — bare /resume lists saved sessions (try an id or number)`);
				return history;
			}
			if (sess) {
				sess.file = loaded.file;
				sess.turn = loaded.history.filter((m) => m.role === "user").length;
				sess.persisted = loaded.history.length;
			}
			console.error(`[bi] resumed ${resumeId} (${loaded.history.length} messages)`);
			// bi#97: compaction markers in the session file replay as
			// transcript blocks so the resumed transcript shows the folds.
			await replayCompactionBlocks(loaded.history, await activeTheme());
			return loaded.history;
		}
		if (t.name === "fork") {
			// bi#86: pi's user-message picker — user messages oldest-first,
			// one row each; picking N branches the transcript *before* the
			// Nth user message and the picked text stays as the retry draft
			// (pi preloads it into the editor; bi prints it, nothing lost).
			// Numbers resolve against the same array the list displays, so
			// `/fork <n>` agrees with bare-/fork rows (bi#68 contract).
			if (!sess) return history;
			const userAt: number[] = [];
			const userTexts: string[] = [];
			history.forEach((m: any, i: number) => {
				const text = String(m.text ?? "");
				if (String(m.role ?? "user") === "user" && text.length > 0) {
					userAt.push(i);
					userTexts.push(text);
				}
			});
			const forkAtMessage = async (n: number): Promise<any[]> => {
				const at = userAt[n - 1];
				if (at === undefined) {
					console.error(`no message #${t.args} — bare /fork lists user messages`);
					return history;
				}
				const kept = history.slice(0, at);
				const draft = userTexts[n - 1];
				const parentId = sessionIdFromFile(sess.file);
				const f = createSessionFile({ cwd: process.cwd(), parentSession: parentId });
				// The branch keeps the transcript: copy persisted + pending
				// lines into the fork file so both files stand alone.
				appendSessionEntries(
					f,
					kept.map((m: any) => ({ role: String(m.role ?? "user"), text: String(m.text ?? ""), provider: backend?.provider ?? null, model: backend?.model ?? null, thinking: backend?.thinking ?? null })),
				);
				sess.file = f;
				sess.persisted = kept.length;
				sess.turn = kept.filter((m: any) => String(m.role ?? "user") === "user").length;
				console.error(`[bi] forked ${parentId} → ${sessionIdFromFile(f)} (transcript kept, turn continues at ${sess.turn})`);
				// bi#88: transcript block naming parent, kept count, new id.
				console.error(await format_branch_summary_async("forked", parentId, kept.length, sessionIdFromFile(f)));
				// pi's editor preload, printed: the picked message is NOT in
				// the branch — send it again to retry from turn n.
				console.error(`[bi] retry draft from message #${n} (not in branch — send again to retry):`);
				console.error(draft);
				return kept;
			};
			const forkArg = t.args.trim();
			if (!forkArg) {
				if (userTexts.length === 0) {
					console.error("no messages to fork from");
					return history;
				}
				const text = await format_fork_list_async(userTexts);
				const theme = await activeTheme();
				// TTY picks by arrows (Enter forks at the row, Esc keeps
				// today); pipes keep the printed list, byte-identical to
				// /resume's path. Cursor starts on the most recent (pi's
				// initial selection).
				if (raw && promptAvailable()) {
					// Same split as renderSelectList, so the picked index
					// addresses the displayed rows 1:1.
					const disp = text.split("\n").filter((l) => l.length > 0);
					raw.suspend();
					let pick: number | null;
					try {
						pick = await pickList("Fork from message (Enter forks, Esc keeps)", disp.map((label) => ({ label })), disp.length - 1);
					} finally {
						raw.resume();
					}
					if (pick === null) {
						await renderSelectList(text, disp.length - 1, undefined, theme);
						return history;
					}
					return forkAtMessage(pick + 1);
				}
				await renderSelectList(text, userTexts.length - 1, undefined, theme);
				return history;
			}
			if (/^\d+$/.test(forkArg)) return forkAtMessage(Number(forkArg));
			console.error(`unknown fork "${forkArg}" — bare /fork lists user messages (try a number)`);
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
			// bi#88: same block shape as /fork (from = the source copy).
			console.error(await format_branch_summary_async("cloned", srcId, history.length, sessionIdFromFile(f)));
			return history;
		}
		// bi#87 (namespace decided: /tree stays the directory browser for
		// /attach, /branches is the session-branch switcher — registered
		// in skills.baml builtin_slash_commands, divergence noted there).
		// Walks parent_session links root-first (BAML gutters) and
		// switches the REPL onto the picked branch: TTY gets the pi-tui
		// modal picker first (pickList, arrows + filter), pipes keep the
		// printed list — same split as /resume and /fork.
		if (t.name === "branches") {
			const entries = await sessionBranchList();
			const rows = orderBranchRows(entries);
			const byId = new Map(entries.map((e) => [e.id, e]));
			const cur = sess ? sessionIdFromFile(sess.file) : null;
			const at = cur ? rows.findIndex((r) => r.id === cur) : -1;
			const lines: string[] = [];
			for (const r of rows) {
				const e = byId.get(r.id)!;
				lines.push(await format_branch_row_async(e.id, e.label, e.turns, cur !== null && cur === e.id, await branch_row_prefix_async(r.depth, r.is_last, r.guides)));
			}
			const switchToBranch = async (id: string): Promise<any[] | "quit" | "none"> => {
				const prev = sess ? sessionIdFromFile(sess.file) : "(none)";
				const loaded = await loadSessionTranscript(id);
				if (!loaded) {
					console.error(`[bi] branch ${id} vanished — staying put`);
					return history;
				}
				if (sess) {
					const next = branchSwitchState(loaded);
					sess.file = next.file;
					sess.turn = next.turn;
					sess.persisted = next.persisted;
				}
				console.error(`[bi] switched ${prev} → ${id} (${loaded.history.length} messages)`);
				// Same replay as /resume (bi#97): compaction markers in
				// the entered branch print as collapsed blocks.
				await replayCompactionBlocks(loaded.history, await activeTheme());
				// bi#88: branch switches emit the summary block too.
				console.error(await format_branch_summary_async("switched", prev, loaded.history.length, id));
				return loaded.history;
			};
			const arg = t.args.trim();
			if (arg) {
				let target = byId.get(arg);
				if (!target && /^\d+$/.test(arg)) {
					const rr = rows[Number(arg) - 1];
					target = rr ? byId.get(rr.id) : undefined;
				}
				if (!target) {
					console.error(`no branch "${arg}" — bare /branches lists the tree`);
					return history;
				}
				return switchToBranch(target.id);
			}
			const text = await format_branches_list_async(lines);
			const theme = await activeTheme();
			// TTY picks by arrows (Enter switches, Esc keeps); pipes
			// keep the printed list, byte-identical to /resume's path.
			if (raw && promptAvailable() && rows.length > 0) {
				raw.suspend();
				let pick: number | null;
				try {
					pick = await pickList("Branches (Enter switches, Esc keeps)", lines.map((label) => ({ label })), at < 0 ? 0 : at);
				} finally {
					raw.resume();
				}
				const row = pick === null ? undefined : rows[pick];
				if (!row) {
					await renderSelectList(text, at < 0 ? 0 : at, undefined, theme);
					return history;
				}
				return switchToBranch(row.id);
			}
			await renderSelectList(text, at < 0 ? 0 : at, undefined, theme);
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
			const dest = unquotePath(t.args) || join(process.cwd(), `${id}.md`);
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
			const src = unquotePath(t.args);
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
				// bi#101: TTY opens sections; pipes keep the printed list.
				// Every section aborts atomically on Esc (nothing written
				// until its final validated commit); verbs below keep
				// working as shortcuts into the same stores.
				if (raw && promptAvailable()) {
					const modal = async <T>(fn: () => Promise<T>): Promise<T> => {
						raw.suspend();
						try {
							return await fn();
						} finally {
							raw.resume();
						}
					};
					const sections = ["Backend: provider / model / thinking", "Theme", "Show all settings"];
					const at = await modal(() => pickList("Settings (Enter opens, Esc lists)", sections.map((label) => ({ label })), 0));
					if (at === null || at === 2) {
						await printSettingsList(stored);
						return history;
					}
					if (at === 1) {
						// bi#105: same merged catalog as /theme (custom
						// files commit by content name; malformed ones
						// refuse with reasons via saveTheme).
						const names = await allThemeNames();
						const cur = await readActiveTheme();
						const picked = await modal(() => pickList("Theme (Enter sets, Esc keeps)", names.map((label) => ({ label })), Math.max(0, names.indexOf(cur))));
						if (picked === null) return history;
						if (!(await saveTheme(names[picked]!))) return history;
						console.error(`[bi] theme now ${names[picked]}`);
						return history;
					}
					// Stepped backend flow: provider → model → thinking.
					// All three picks resolve first; the merged settings
					// validate before the single save + live apply.
					const providers = (await ListProviders_async()).map((p: any) => String(p.id ?? p));
					const curP = backend?.provider ?? "anthropic";
					const pAt = await modal(() =>
						pickList("Settings → provider (Esc aborts, nothing saved)", providers.map((label) => ({ label })), Math.max(0, providers.indexOf(curP))),
					);
					if (pAt === null) return history;
					const provider = providers[pAt]!;
					const models = (await listModels(provider)).map((m: any) => String(m.id ?? m));
					if (models.length === 0) {
						console.error(`[bi] provider "${provider}" lists no models — settings unchanged`);
						return history;
					}
					const curM = backend?.model ?? "claude-haiku-4-5";
					const mAt = await modal(() =>
						pickList(`Settings → model @ ${provider} (Esc aborts, nothing saved)`, models.map((label) => ({ label })), Math.max(0, models.indexOf(curM))),
					);
					if (mAt === null) return history;
					const m = await resolve_model_ref_async(models[mAt]!);
					if (!m) {
						console.error(`[bi] model "${models[mAt]}" no longer resolves — settings unchanged`);
						return history;
					}
					const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
					const curT = backend?.thinking ?? "off";
					const tAt = await modal(() =>
						pickList("Settings → thinking (Esc aborts, nothing saved)", levels.map((label) => ({ label })), Math.max(0, levels.indexOf(curT))),
					);
					if (tAt === null) return history;
					const merged = { ...stored, default_provider: m.provider, default_model: m.id, default_thinking: levels[tAt]! };
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
					if (backend) {
						backend.provider = m.provider;
						backend.model = m.id;
						backend.thinking = levels[tAt]!;
					}
					console.error(`[bi] backend now ${m.provider}/${m.id} + thinking ${levels[tAt]} (saved)`);
					return history;
				}
				await printSettingsList(stored);
				return history;
			}
			const [verb, key, ...rest] = parts;
			if ((verb === "get" || verb === "set" || verb === "unset") && key && !(await is_setting_key_async(key))) {
				console.error(`unknown setting "${key}" — bare /settings lists default_provider/default_model/default_thinking/notifications`);
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
			// bi#103: bare /config previews the live config (BAML-shaped)
			// with its file path; the edit moves to `/config edit`. Bi
			// keeps one settings file — no named profiles to switch
			// (deliberate divergence from pi's config-selector).
			const arg = t.args.trim();
			if (arg === "path") {
				console.log(settingsFile());
				return history;
			}
			if (!arg) {
				console.log(await format_settings_list_async(bamlSettings(loadUserSettings())));
				console.error(`[bi] ${settingsFile()} — /config edit to change, /config path for the path`);
				return history;
			}
			if (arg !== "edit") {
				console.error("usage: /config [edit|path]");
				return history;
			}
			if (!process.stdin.isTTY) {
				console.error("/config edit needs an interactive terminal ($EDITOR edit)");
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
	// bi#98: every skill invocation emits its named transcript block before
	// the guidance runs — skill use is visible in review, not just in the
	// prompt context. A shaping failure warns loud and the guidance still
	// runs; blocking the skill on a display error would fail closed.
	const skillExpanded = `${skillBody(t.skill)}\n\n${t.args}`.trim();
	try {
		await printSkillBlock({ name: t.skill.name, content: skillBody(t.skill), theme: await activeTheme() });
	} catch (e) {
		console.error(`[bi] skill block failed to print (${e instanceof Error ? e.message : e}) — guidance still runs`);
	}
	return runOnePrompt(skillExpanded, skills, history, {
		...(signal ? { signal } : {}),
		historyText: await format_skill_history_entry_async(t.skill.name, skillExpanded),
	});
}

// bi#27: tool executions announce themselves — start line before the
// call, done line after (failures show the first output line, successes
// a char count). Same wrapper for REPL and `bi run`; throw semantics
// unchanged (runAgent has no handler try/catch today).
// bi#75: every tool call crosses this wrapper on both paths (REPL +
// `bi run`), so the action log sees each one with zero per-site code.
// Effect records (edit.write, bais.*) derive from the same call — the
// executor stays untouched, the wrapper observes.
function loggingHandler(log: ActionLog | null, seam: GoTuiSeam | null = null): (name: string, args: Record<string, unknown>) => Promise<string> {
	return async (name: string, args: Record<string, unknown>): Promise<string> => {
		log?.record("tool.call", `${name} ${safeJson(args).slice(0, 120)}`);
		const out = await runToolWithStatus(name, args, seam);
		if (name === "write" || name === "edit") log?.record("edit.write", String((args as any)?.path ?? name));
		if (name === "bais_move") log?.record("bais.move", `${String((args as any)?.id ?? "?")} -> ${String((args as any)?.status ?? "?")}`);
		if (name === "bais_new") log?.record("bais.new", String((args as any)?.title ?? "").slice(0, 80));
		return out;
	};
}

// bi#188: ANSI for the seam — the Go shell styles its own lines; BAML
// shapes the text (theme null), the host strips any residual SGR so only
// plain data crosses.
function seamPlain(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function runToolWithStatus(name: string, args: Record<string, unknown>, seam: GoTuiSeam | null = null): Promise<string> {
	// bi#188: under a live BI_TUI=go seam the Go child owns every terminal
	// byte — tool start/done cross as tool/start + tool/done data instead
	// of console.log. A dead seam already warned (named, once); fall back
	// to the console path below.
	if (seam?.alive) {
		const tid = seam.toolStart(name, seamPlain(await format_tool_start_async(name, JSON.stringify(args), { theme: null })));
		try {
			const out = await handleTool(name, args);
			seam.toolDone(tid, true, seamPlain(await format_tool_done_async(name, out, false, { theme: null })));
			// bi#71 tool diffs are not routed across the seam yet (named
			// divergence — the Go tool line is one row; see bi#188 NOTES).
			return out;
		} catch (e) {
			seam.toolDone(tid, false, seamPlain(await format_tool_done_async(name, e instanceof Error ? e.message : String(e), true, { theme: null })));
			throw e;
		}
	}
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
async function runOnePrompt(q: string, skills: Skill[] = [], history: any[] = [], opts: { signal?: TurnSignal; aborted?: Promise<void>; raw?: { suspend(): void; resume(): void } | null; historyText?: string } = {}, backend: ReplBackend = { provider: "anthropic", model: "claude-haiku-4-5", thinking: null }, sess?: ReplSessionState): Promise<any[] | "quit"> {
	const slash = await handleSlash(q, skills, history, opts.signal, backend, sess, opts.raw ?? null);
	if (slash === "quit") return "quit";
	if (slash !== "none") return slash;
	// bi#75: the turn's own log lines (tool.* / edit.write / bais.*
	// arrive via loggingHandler on the loop below).
	const alog = sess ? new ActionLog(sessionIdFromFile(sess.file)) : null;
	alog?.record("turn.start", q.slice(0, 80));
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
	// bi#98: skill invocations persist the BAML-shaped [skill] label instead
	// of the raw line, so the session file (and /export) names which skill
	// fired. The model still receives q (the expanded body) via fullPrompt.
	const withUser = [...history, { role: "user", text: opts.historyText ?? q }];
	let loopTools: any[] = [];
	try {
		loopTools = await listTools();
	} catch {}
	// Live status on stderr (in-place spinner on TTY, plain lines on pipes);
	// BAML shapes every line, the host only schedules repaints.
	// bi#96: kind-aware (working/retry/compaction/branchSummary) — retry and
	// compaction waits report through the ambient sink; stop() resets so
	// no kind leaks into the next turn.
	const status = new KindStatus("thinking", { formatStatus: format_status, formatSummary: format_turn_summary });
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
			alog?.record("turn.end", "image-unsupported");
			await stderrRule(turnTheme);
			return withUser;
		}
		// bi#70: the staged part echoes in the transcript first (graphics
		// on kitty/iTerm2 TTYs, BAML placeholder elsewhere). Env-only
		// detection here — a live probe's reply bytes would land in the
		// TUI's own stdin.
		await showStagedImage(sess.images[0], imageB64, {
			labelForPath: (p) => staged_image_label_async(p),
			fallbackForLabel: (label) => format_image_placeholder_async(label, { theme: turnTheme }),
			probeLive: false,
		});
		const img = await runSingleImageTurn(fullPrompt, {
			provider: backend.provider,
			model: backend.model,
			thinkingLevel: backend.thinking,
			baseUrl: process.env.BI_BASE_URL ?? null,
			imageBase64: imageB64,
			imageMime: sniffImageMime(Buffer.from(imageB64, "base64")) ?? "image/png",
		});
		if ("failure" in img) {
			status.stop({ failed: true, detail: `TurnFailure ${img.failure.kind}`, turns: 1, messages: withUser.length, theme: turnTheme });
			console.error(format_turn_error(`TurnFailure ${img.failure.message}`, { theme: turnTheme }));
			const guidance = await GuidanceFor_async(img.failure.kind, backend.provider);
			if (guidance) console.error(guidance);
			alog?.record("turn.end", `failed:${img.failure.kind}`);
			await stderrRule(turnTheme);
			return withUser;
		}
		sess.images = sess.images.slice(1);
		if (sess.images.length) console.error(`[bi] ${sess.images.length} image(s) still staged — one per turn`);
		const out = [...withUser, { role: "assistant", text: img.text, clientId: `${backend.provider}/${backend.model}` }];
		status.stop({ failed: false, detail: "", turns: 1, messages: out.length, theme: turnTheme });
		const theme = await activeTheme();
		await printMarkdownText(img.text, theme);
		alog?.record("turn.end", "ok");
		await stderrRule(turnTheme);
		return out;
	}
	// BI_BASE_URL lets the REPL talk to a local gateway/proxy (and makes
	// slow-turn behavior testable without real provider latency).
	// bi#97: auto-compaction inside the turn emits its transcript block
	// (folded turns + reclaimed tokens) with the turn's theme.
	// bi#168/bi#191: TTY live stream — while the turn runs, the streaming
	// assistant text surfaces as the status line's event tail (word-boundary
	// window, BAML status_event_tail) instead of raw stderr deltas, which
	// wrapped mid-word and settled into scrollback as debris. The settled
	// stdout transcript below is untouched, so piped output stays
	// byte-identical single-shot with no control bytes. Abort (bi#16)
	// flips the guard: partials stop and history is untouched, exactly
	// as the no-stream path.
	const streamAlive = process.stdout.isTTY === true;
	// bi#191: window for the status-line draft tail (status_event_tail) —
	// sized to fit after `⠁ thinking · 22.3s · ` on an 80-col row.
	const STATUS_EVENT_TAIL_CHARS = 50;
	const streamSettled = { current: false };
	const cancelStream = (): boolean => streamSettled.current || (opts.signal?.aborted ?? false);
	const turnP = runBiLoop(fullPrompt, { provider: backend.provider, model: backend.model, thinking: backend.thinking, maxTurns: 5, baseUrl: process.env.BI_BASE_URL ?? null, onEvent: (e) => status.onEvent(e), tools: loopTools, toolHandler: loggingHandler(alog), history, compaction: { onCompacted: async (info) => { await printCompactionSummary({ summary: info.summary, tokensBefore: info.tokensBefore, tokensAfter: info.tokensAfter, foldedTurns: info.foldedTurns, theme: turnTheme }); } }, onAssistantText: streamAlive ? async (text) => {
		if (cancelStream()) return;
		// bi#191: the draft never touches stderr as raw deltas — appended
		// chunks shared the in-place status row, and wrapped upper rows
		// settled into scrollback as mid-word debris (`…ve`, `…i#190**`).
		// The draft rides the status event instead (statusEventTailUpdater),
		// width-clamped by the paint path, so the row the turn leaves behind
		// is only ever the BAML-shaped summary.
		const onDelta = statusEventTailUpdater(status, STATUS_EVENT_TAIL_CHARS);
		await streamTextIncremental(text, (delta) => {
			if (cancelStream()) return;
			onDelta(delta);
		}, { isCancelled: cancelStream });
	} : undefined });
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
		streamSettled.current = true;
		if (opts.signal) opts.signal.aborted = true;
		status.stop({ failed: true, detail: "aborted", turns: 0, messages: history.length, theme: turnTheme });
		console.error("[bi] turn aborted — transcript unchanged (a late VM result is discarded on arrival)");
		alog?.record("turn.end", "aborted");
		await stderrRule(turnTheme);
		void turnP.then(
			() => console.error("[bi] late turn result discarded"),
			(e) => console.error(`[bi] late turn failed: ${String(e?.message ?? e).split("\n")[0]}`),
		);
		return history;
	}
	const result = settled.result;
	streamSettled.current = true;
	if (opts.signal?.aborted) {
		console.error("[bi] turn finished after abort — result discarded");
		alog?.record("turn.end", "discarded");
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
		alog?.record("turn.end", `failed:${result.failure.kind}`);
		await stderrRule(turnTheme);
		return withUser;
	}
	status.stop({ failed: false, detail: "", turns: Math.max(assistantCount, 1), messages: result.messages.length, theme: turnTheme });
	// bi#27: assistant text renders through the BAML markdown shaper.
	const theme = await activeTheme();
	for (const m of result.messages) {
		if ((m as any).role !== "assistant") continue;
		await printMarkdownText((m as any).text ?? JSON.stringify((m as any).content), theme);
	}
	alog?.record("turn.end", "ok");
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
	private completerFn: ((line: string, cb: (err: unknown, res: [string[], string]) => void) => void) | null = null;
	setCompleter(fn: (line: string, cb: (err: unknown, res: [string[], string]) => void) => void): void {
		// Assigned post-construction: readline reads .completer fresh
		// on every Tab, so late wiring (after skill loads) just works.
		// Stored too so a suspend/resume rebuild keeps completing.
		this.completerFn = fn;
		try { (this.r as any).completer = fn; } catch {}
	}
	// Suspend line editing while a pi-tui modal owns stdin; resume
	// restores it. This must CLOSE the interface, not pause it: pause()
	// only pauses the shared stdin stream, and pi-tui's Terminal.start()
	// resumes that same stream for its own reading — the resume re-feeds
	// readline's still-attached 'data' listener, so kitty/DA replies get
	// parsed as keypresses and echoed to stdout ("7u", "64;…;52c" junk
	// below the footer). Close detaches the listener entirely; resume
	// rebuilds it with history/completer/handlers intact. stdin stays
	// paused between the modal's stop and the rebuild (same no-lose
	// ordering as before: the modal attaches first, we re-attach after).
	suspendLineInput(): void {
		if (!this.r) return;
		try { this.r.close(); } catch {}
		this.r = null;
	}
	resumeLineInput(): void {
		if (!this.r) this.r = this.buildInterface();
		else try { this.r.resume(); } catch {}
	}
	private buildInterface(): any {
		const r = createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
		// File is oldest-first; unshifting in file order leaves the newest
		// at the head, which is where Up starts (verified live: a fresh
		// process recalls the file's last line first). In-session
		// submissions are newer than the file, so they unshift after it.
		for (const l of readHistoryFile(this.historyFile)) (r as any).history.unshift(l);
		for (const s of this.submitted) (r as any).history.unshift(s);
		if (this.completerFn) (r as any).completer = this.completerFn;
		// Ctrl-C with no question pending means mid-turn: the REPL arms
		// onMidTurnInterrupt per turn to abandon it (bi#16). At the prompt
		// the pending question resolves "\x03" and the loop re-prompts.
		r.on("SIGINT", () => {
			if (this.pending) this.pending.resolve("\x03");
			else this.onMidTurnInterrupt?.();
		});
		// Suspend closes with no question pending, so this only fires on
		// real EOF (Ctrl-D / piped input ends), same as before.
		r.on("close", () => this.pending?.reject(new Error("EOF")));
		return r;
	}
	constructor() {
		this.historyFile = historyFile();
		this.r = this.buildInterface();
	}
	// bi#160: fullscreen forces readline line-mode (the docked prompt
	// row mirrors the label; keystroke routing into a docked editor is
	// follow-up). Set once at REPL start, read by ask/askMultiline.
	forceLineMode = false;
	editPool: SlashPool | null = null;
	// bi#181: active theme name for the modal editor's border colors
	// (null = plain; resolved by the REPL loop where activeTheme() is
	// already computed for the footer, so pipes/NO_COLOR stay plain).
	editorTheme: string | null = null;
	setEditPool(pool: SlashPool): void {
		this.editPool = pool;
	}
	// TTY prompts go through the pi-tui editor modal (Enter submits,
	// Ctrl-J newline, Up recalls, Tab completes); readline stays paused
	// underneath and remains the pipe fallback. History merges file +
	// this session's submissions.
	async askWithEditor(promptText: string): Promise<string> {
		if (!this.editPool) throw new Error("askWithEditor: no pool");
		this.suspendLineInput();
		this.pending = null;
		try {
			const text = await askEdit(
				promptText,
				[...readHistoryFile(this.historyFile), ...this.submitted],
				this.editPool,
				{ theme: this.editorTheme },
			);
			if (text !== "\x03" && text.trim().length > 0) this.submitted.push(text);
			return text;
		} finally {
			this.resumeLineInput();
		}
	}
	ask(prompt: string): Promise<string> {
		if (!this.forceLineMode && promptAvailable() && this.editPool) return this.askWithEditor(prompt);
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
	// so multi-line prompts survive the line editor. The TTY editor is
	// natively multiline (Ctrl-J), so one modal serves the whole turn.
	async askMultiline(prompt: string): Promise<string> {
		if (!this.forceLineMode && promptAvailable() && this.editPool) return this.askWithEditor(prompt);
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

// bi#93 first-run setup (via bi#30): fresh installs (settings.json
// absent) get a theme + analytics-consent pass on TTY before anything
// else renders, so the chosen theme styles the whole session. BAML owns
// the copy + choice schema; the host owns detection (env heuristic),
// preview (theme_preview), and persistence. Every exit — pick, answer,
// or Esc — writes setup_done, so bi never asks twice. Custom
// BI_AGENT_DIR, pipes, and non-TTY skip silently WITHOUT creating
// files, so a later interactive run still prompts. `bi run` and
// --print never enter repl(), so headless stays quiet.
async function maybeRunFirstTimeSetup(): Promise<void> {
	if (process.env[BI_AGENT_DIR_ENV]) return;
	if (!promptAvailable()) return;
	let fresh = false;
	try {
		fresh = !existsSync(settingsFile());
	} catch {
		return;
	}
	if (!fresh) return;
	const detected = detectTerminalThemeFromEnv();
	console.error(await format_first_run_theme_step_async(detected));
	const themeOpts = await setup_theme_options_async();
	const themeNames = themeOpts.map((o: any) => String(o.value));
	// Live preview: highlighting a row repaints its palette below the
	// list before Enter commits (pi's ThemeSelectorComponent shape:
	// onSelectionChange → preview). Esc skips the rest of setup but
	// still records setup_done, so bi never asks twice.
	const themeAt = await pickListWithPreview(
		"First run — pick a theme (↑↓ previews live · Enter confirms · Esc skips setup)",
		(themeOpts as any[]).map((o) => ({ label: `${String(o.label)} — ${String(o.description)}` })),
		Math.max(0, themeNames.indexOf(detected)),
		async (i) => `${themeNames[i]}:\n${await theme_preview_async(themeNames[i]!)}`,
	);
	if (themeAt === null) {
		try {
			saveUserSettings({ ...loadUserSettings(), setup_done: true });
		} catch (e) {
			console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
		}
		console.error(await format_setup_skipped_async());
		return;
	}
	const theme = themeNames[themeAt]!;
	await saveTheme(theme);
	console.error(await format_first_run_analytics_step_async());
	const analyticsOpts = await setup_analytics_options_async();
	// The safe default is preselected: Don't share (index 1). bi
	// collects no telemetry — this records consent state only.
	const analyticsAt = await pickList(
		"Analytics (Enter records, Esc skips)",
		(analyticsOpts as any[]).map((o) => ({ label: `${String(o.label)} — ${String(o.description)}` })),
		1,
	);
	const answered = analyticsAt !== null;
	try {
		saveUserSettings({ ...loadUserSettings(), setup_done: true, ...(answered ? { share_analytics: analyticsAt === 0 } : {}) });
	} catch (e) {
		console.error(`[bi] settings persist failed (${e instanceof Error ? e.message : e})`);
	}
	if (!answered) {
		console.error(await format_setup_skipped_async());
		return;
	}
	console.error(await format_first_run_done_async(theme, analyticsAt === 0));
}

// bi#93: /settings shows the recorded first-run choices next to the
// backend defaults — appended only once setup has spoken, so older
// settings files print byte-identical output.
async function printSettingsList(stored: UserSettings): Promise<void> {
	const list = await format_settings_list_async(bamlSettings(stored));
	if (stored.setup_done || stored.share_analytics !== undefined) {
		console.log(list + (await format_setup_status_async(await readActiveTheme(), stored.share_analytics ?? null, stored.setup_done ?? false)));
	} else {
		console.log(list);
	}
}

// bi#180: bi's own version for the welcome frame label column — read
// from package.json at runtime (dist/src/cli.js → bi/package.json);
// "dev" when unreadable. Never throws.
function biVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		const pkg = req("../../package.json") as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "dev";
	} catch {
		return "dev";
	}
}

// bi#180: welcome entry frame (BAML-shaped render_welcome_frame, kimi
// welcome.ts:49-107 mirror) with the ready-BAIS frame beneath it.
// Staged once from repl() AFTER the last startup modal (trust /
// first-run / session picker) hides; the first editor modal mounts it
// into the host's base layer (stageBaseFrame, prompt.ts) — never
// console.log (modal repaints erase bypass prints, how the pre-modal
// ready frame was lost) and never a direct ensureReplTui here (creating
// the host outside the modal envelope fires the kitty query while
// readline still owns stdin — its listener echoes the reply as
// caret-notation keypresses, the `^[[?64;1;2…52c` leak). A future
// /clear re-renders by calling this again (bi has no /clear today).
// Gates: interactive TTY, not fullscreen — pipes and the alt-screen
// shell stay byte-stable.
async function printWelcomeFrame(backend: ReplBackend, sess: ReplSessionState, fullscreen: boolean): Promise<void> {
	if (fullscreen || !promptAvailable()) return;
	try {
		const width = termWidth();
		const theme = await activeTheme();
		const [welcome, ready] = await Promise.all([
			render_welcome_frame_async(
				{ directory: process.cwd(), session: sessionIdFromFile(sess.file) ?? sess.file, model: backend.model, version: biVersion() },
				width,
				{ theme },
			),
			readyBaisIssues(),
		]);
		const readyLines = await render_ready_frame_async(
			ready.map((f) => ({ id: f.issue.id, title: f.issue.title })),
			width,
		);
		stageBaseFrame([...welcome, ...readyLines]);
	} catch {
		// The entry frame is cosmetic — never brick REPL startup.
	}
}

// Persistent REPL: one session file, conversation history threaded across
// turns, /quit or Ctrl-D to leave, Ctrl-C at the prompt just re-prompts.
// Ctrl-C mid-turn aborts the process (same as `bi run`) — the session file
// and printed transcript remain.
async function repl(skills: Skill[], opts: { skipPicker?: boolean } = {}): Promise<void> {
	// bi#188: BI_TUI=go covers the `bi run` turn-render path only — the
	// interactive REPL (startup modals, slash commands, session pickers,
	// prompt.ts runModal) is not routed through the Go shell yet. Named
	// fallback, never a silent swap (bi#55); the pi-tui path below mounts
	// exactly as without the flag.
	if (goTuiRequested()) {
		console.error("[bi] BI_TUI=go: interactive REPL is not routed through the Go shell yet (the flag covers `bi run` turn-render; bi#188) — falling back to pi-tui");
	}
	// bi#160: opt-in alt-screen shell (BI_FULLSCREEN=1 on a TTY).
	// The fullscreen session owns the single terminal: no modal host
	// lease (a second ProcessTerminal would split stdin), forced
	// readline line-mode, no first-run/resume modals. Unset or piped:
	// every line below is skipped and the REPL is byte-identical.
	const fullscreen = fullscreenRequested();
	// bi#162: hold the modal host for the whole REPL — every picker,
	// editor, and login dialog overlays one persistent TUI (one kitty
	// negotiation per session, not per modal). Released in the finally
	// below, which stops the host exactly once.
	if (!fullscreen) retainReplTui();
	if (!fullscreen) await maybeRunFirstTimeSetup();
	// bi#100: startup resume-vs-new offer. TTY with saved sessions gets a
	// New-first picker (no bi#69 raw layer needed — pickList is modal);
	// Esc/New mints fresh exactly like before (no litter otherwise:
	// adopting skips the mint). Pipes, empty stores, and --continue /
	// --session / --print keep today's paths byte-identical.
	// Unreachable default: every branch below either adopts (sessFile
	// unused) or mints before use — TS just can't see through them.
	let sessFile = "";
	let adopted: { file: string; history: any[] } | null = null;
	// bi#160: the resume picker is a main-screen modal — it would fight
	// the alt screen for stdin, so fullscreen mints fresh (documented).
	const rows = !opts.skipPicker && !fullscreen && promptAvailable() ? await sessionResumeList() : [];
	if (rows.length > 0) {
		const text = await format_resume_list_async(rows, null);
		const disp = ["New session", ...text.split("\n").filter((l) => l.length > 0)];
		const pick = await pickList("Start (Enter opens, Esc starts new)", disp.map((label) => ({ label })), 0);
		const row = pick === null ? undefined : rows[pick - 1];
		const loaded = row ? await loadSessionTranscript(row.id) : null;
		if (loaded) {
			adopted = { file: loaded.file, history: loaded.history };
			console.error(`[bi] resumed ${row!.id} (${loaded.history.length} messages)`);
			// bi#97: same replay as /resume — markers become blocks.
			await replayCompactionBlocks(loaded.history, await activeTheme());
		} else {
			if (row) console.error(`[bi] session ${row.id} vanished — starting fresh`);
			sessFile = createSessionFile({ cwd: process.cwd() });
			console.error(`[bi] new session ${sessFile}`);
		}
	} else {
		sessFile = createSessionFile({ cwd: process.cwd() });
		console.error(`[bi] new session ${sessFile}`);
	}
	const reader = new ReplReader();
	// bi#160: start the alt-screen shell before anything else prints —
	// the tee then mirrors the whole loop into the ScrollView. Readline
	// stays closed across the kitty negotiation (same reason modals
	// suspend it) plus a settle beat, so late replies never echo as
	// keypress junk into the pending prompt.
	let fsSession: FullscreenSession | null = null;
	let releaseTee: (() => void) | null = null;
	if (fullscreen) {
		reader.forceLineMode = true;
		reader.suspendLineInput();
		fsSession = new FullscreenSession();
		fsSession.start(dirname(getBiSessionsDir()));
		releaseTee = teeOutputTo(fsSession);
		await new Promise((r) => setTimeout(r, 150));
		reader.resumeLineInput();
	}
	// bi#67: pinned bottom-row footer (scroll region + differential
	// repaint on TTY; plain printed line on pipes). Installed lazily on
	// the first turn-end paint, torn down when the REPL leaves.
	// Fullscreen never installs it — the dock owns the footer frame.
	const footer = new HostFooter();
	// bi#171: exactly-once terminal page per completed REPL turn.
	const turnNotifier = new TerminalNotifier();
	// Tab completes first-word slashes (builtins + loaded skills, same
	// array the loop mutates on /trust reloads) and second-word
	// arguments for commands with a known pool (model ids, provider
	// ids, session ids, paths, levels, names, verbs, keys).
	// A bare exact command ("/model") completes the trailing space so
	// the next Tab reaches the argument pool — never a silent no-op.
	// BAML owns the match; the callback form keeps readline's sync
	// contract over the VM call.
	try {
		const builtinRows: { name: string; description: string | null }[] = (
			await builtin_slash_commands_async()
		).map((b: any) => ({ name: String(b.name), description: b.description != null ? String(b.description) : null }));
		const builtins = builtinRows.map((b) => b.name);
		// Slice 3: the modal editor's Tab provider shares the readline
		// pools (same names array the loop mutates on /trust reloads).
		reader.setEditPool({
			// bi#158: "search" is host-augmented (no BAML registry
			// entry) — completion offers it, skillNames stays pure.
			names: () => [...builtins, "search", ...skills.map((s) => s.name)],
			// bi#155: inline picker reads the same live skills array —
			// /trust reloads (sess.skillsDirty) show up next prompt.
			skillNames: () => skills.map((s) => s.name),
			describe: (name) => {
				if (name === "search") return "Search the session transcript in-terminal";
				const b = builtinRows.find((r) => r.name === name);
				if (b?.description) return b.description;
				const s = skills.find((k) => k.name === name);
				const d = (s as any)?.description;
				return d != null ? String(d) : null;
			},
			argPool: (cmd, prefix) =>
				argCandidates(cmd, [...builtins, ...skills.map((s) => s.name)], prefix),
		});
		reader.setCompleter((line: string, cb: (err: unknown, res: [string[], string]) => void) => {
			// bi#158: same host augmentation as the edit pool above.
			const names = [...builtins, "search", ...skills.map((s) => s.name)];
			// Second-word flow shared by the plain and quoted branches:
			// the match key is the typed token (quote included, so quoted
			// values keep their leading quote through BAML ranking).
			const runSecond = (cmd: string, prefix: string) => {
				argCandidates(cmd, names, prefix).then((pool) =>
					complete_arg_async(prefix, pool).then(
						(m: string[]) => cb(null, [m, prefix]),
						(e: unknown) => cb(null, [[], prefix]),
					),
				);
			};
			// bi#159: plain and quoted second words split in one helper;
			// anything else keeps today's fallthrough byte-identical.
			const split = splitSecondWord(line);
			if (!split) {
				const bare = line.match(/^\/(\S+)$/);
				if (bare && names.includes(bare[1])) {
					cb(null, [[`${line} `], line]);
					return;
				}
				complete_slash_async(line, names).then(
					(m: string[]) => cb(null, [m, line]),
					(e: unknown) => cb(null, [[], line]),
				);
				return;
			}
			runSecond(split.cmd, split.token);
		});
	} catch {
		// Completion is a convenience — never brick REPL startup.
	}
	let history: any[] = adopted?.history ?? [];
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
	// A startup-adopted session (bi#100) seeds all three from the file.
	const sess: ReplSessionState = {
		file: adopted?.file ?? sessFile,
		turn: adopted ? adopted.history.filter((m: any) => m.role === "user").length : 0,
		persisted: adopted?.history.length ?? 0,
		tree: [], treeRoot: process.cwd(), attachments: [], images: [], skillsDirty: false, stagedIssues: [], issueList: [],
	};
	// bi#67: pin the footer on load — not just first turn-end — so the
	// scroll region installs and rows N-1/N hold the frame before the
	// first prompt draws. Cosmetic only: never brick startup.
	try {
		const loadTheme = await activeTheme();
		const loadThinking = backend.thinking ?? "default";
		reader.editorTheme = loadTheme;
		footer.show(
			await render_footer_frame_async(backend.provider, backend.model, loadThinking, sess.turn, history.length, termWidth(), { theme: loadTheme, cwd: footerCwd(), branch: gitBranch() }),
			await render_model_line_async(backend.provider, backend.model, loadThinking, termWidth(), { theme: loadTheme }),
			await format_repl_footer_async(backend.provider, backend.model, loadThinking, sess.turn, history.length, { theme: loadTheme, cwd: footerCwd(), branch: gitBranch() }),
		);
	} catch {
		// No footer on load — the first turn-end paint installs it.
	}
	// bi#180: welcome entry frame + ready BAIS beneath it, printed AFTER
	// the last startup modal (trust / first-run / session picker) has
	// hidden — modal full-repaints erase anything printed earlier, which
	// is how the pre-modal ready frame was lost. TTY only and never in
	// fullscreen: pipes keep byte-stable output. Second render site for
	// render_ready_frame (the no-arg dump is the first). Named so a
	// future /clear can re-render it (bi has no /clear today).
	await printWelcomeFrame(backend, sess, fullscreen);
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
				// bi#67: the prompt draws as part of the footer block —
				// homed to the row directly above the pinned rows.
				footer.homeInput();
				// bi#160: the dock's prompt row mirrors the live label;
				// readline still owns the keystrokes (v1, see NOTES).
				// bi#181: the label text is BAML-shaped (format_prompt_label).
				const promptLabel = `${format_prompt_label(sess.turn)} `;
				if (fsSession) fsSession.setPrompt(promptLabel);
				line = await reader.askMultiline(promptLabel);
			} catch {
				console.error("\n[bi] EOF — session kept at " + sess.file);
				return;
			}
			if (line === "\x03" || !line.trim()) {
				if (line === "\x03") console.error("(Ctrl-D or /quit to exit)");
				continue;
			}
			// bi#160: record the submitted command in the mirror.
			// Readline's echo path doesn't cross stdout.write (traced
			// in a pty: the prompt + cursor moves arrive, typed bytes
			// never do — kernel echo is invisible to the tee), so
			// without this neither the live ScrollView nor the replay
			// names the command behind each turn.
			if (fsSession) {
				const cmdRows = line.split("\n");
				fsSession.pushLines(
					cmdRows.map((r, i) => (i === 0 ? `bi[${sess.turn}]> ${r.trim()}` : `... ${r.trim()}`)),
				);
			}
			// Mid-turn Ctrl-C abandons the turn (bi#16): the VM request has
			// no signal passthrough, so the turn is orphaned and discarded
			// on arrival — the prompt and transcript survive.
			const signal: TurnSignal = { aborted: false };
			let fireAbort: () => void = () => {};
			const aborted = new Promise<void>((res) => { fireAbort = res; });
			reader.onMidTurnInterrupt = () => fireAbort();
			let out: any[] | "quit";
			out = await runOnePrompt(line.trim(), skills, history, { signal, aborted, raw: { suspend: () => reader.suspendLineInput(), resume: () => reader.resumeLineInput() } }, backend, sess);
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
					reader.editorTheme = theme;
					const cwd = footerCwd();
					const branch = gitBranch();
					const fallback = await format_repl_footer_async(backend.provider, backend.model, thinking, sess.turn, history.length, { theme, cwd, branch });
					// bi#160: fullscreen routes the same BAML frame into
					// the dock (footer.show's DECSTBM region would fight
					// the alt screen); HostFooter stays uninstalled so its
					// dispose below is a silent no-op.
					if (fsSession) {
						fsSession.setFooter([
							await render_footer_frame_async(backend.provider, backend.model, thinking, sess.turn, history.length, termWidth(), { theme, cwd, branch }),
							await render_model_line_async(backend.provider, backend.model, thinking, termWidth(), { theme }),
						]);
					} else {
						footer.show(
							await render_footer_frame_async(backend.provider, backend.model, thinking, sess.turn, history.length, termWidth(), { theme, cwd, branch }),
							await render_model_line_async(backend.provider, backend.model, thinking, termWidth(), { theme }),
							fallback,
						);
					}
					// bi#171: page once per completed REPL turn (success or
					// TurnFailure both land here as new history; slash and
					// aborted paths return `history` above and stay silent).
					// Unset key = disabled = zero bytes (today's behavior).
					notifyTurnComplete(turnNotifier, sess.turn, { session: sess.file, setting: loadUserSettings().notifications });
				}
			}
		}
	} finally {
		// bi#160: release the tee before stopping the shell, then stop
		// the shell (drain + host replay into scrollback). Readline
		// closes after the stop so the drain never eats user input.
		if (releaseTee) {
			releaseTee();
			releaseTee = null;
		}
		if (fsSession) {
			const fs = fsSession;
			fsSession = null;
			await fs.stop();
		}
		// bi#167: delete live kitty images on session teardown (zero bytes
		// when nothing was shown) before the footer region resets.
		teardownInlineImages();
		footer.dispose();
		reader.close();
		// bi#162: drain/pop/stop the modal host last — stdin is closed,
		// so the drain eats only terminal stragglers, never user input.
		if (!fullscreen) await releaseReplTui();
	}
}

// hub#203: real fs IO + store sinks for review-turn.ts. pending/ lives at
// .bi/review/pending/ (project-local, beside the sessions/skills state).
// The three sinks are the ONLY host paths from a staged proposal to a
// store, and review-turn.ts hands them out exclusively from
// approveProposal after the pending gate — nothing else imports these.
function reviewTurnPendingDir(): string {
	return join(process.cwd(), ".bi", "review", "pending");
}

function reviewProposalSummary(p: StagedProposal): string {
	if (p.type === "MemoryAdd") return `${String(p.fields.op)}: ${String(p.fields.content).slice(0, 80)}`;
	if (p.type === "SkillPatch") return `${String(p.fields.action)} ${String(p.fields.skill)}/${String(p.fields.target_file)}`;
	if (p.type === "IssueProposal") return String(p.fields.title).slice(0, 80);
	return String(p.fields.reason ?? "").slice(0, 80);
}

function makeReviewTurnIO(): ReviewIO {
	const dir = reviewTurnPendingDir();
	const file = (id: string) => join(dir, `${id}.json`);
	return {
		writeProposal(id, json) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file(id), json);
		},
		readProposal(id) {
			return existsSync(file(id)) ? readFileSync(file(id), "utf8") : null;
		},
		removeProposal(id) {
			rmSync(file(id), { force: true });
		},
		listProposalIds() {
			if (!existsSync(dir)) return [];
			return readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -5))
				.sort();
		},
		applyMemory(fields) {
			const mem = join(homedir(), ".bi", "memory.jsonl");
			mkdirSync(dirname(mem), { recursive: true });
			writeFileSync(mem, JSON.stringify({ ...fields, applied_at: new Date().toISOString() }) + "\n", { flag: "a" });
		},
		applySkill(fields) {
			// Jail: a staged proposal's skill/target_file is model output,
			// never trusted — the write must stay under .bi/skills/<skill>/.
			const root = resolve(process.cwd(), ".bi", "skills");
			const skill = String(fields.skill ?? "");
			const targetFile = String(fields.target_file ?? "");
			const target = resolve(root, skill, targetFile);
			if (!skill || !target.startsWith(root + sep)) {
				throw new ReviewStagingError("skill_jail", `skill patch target ${JSON.stringify(`${skill}/${targetFile}`)} escapes ${root}`);
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, String(fields.content ?? ""));
		},
		async applyIssue(fields) {
			const f = await createBaisIssue({
				title: String(fields.title ?? ""),
				kind: String(fields.kind ?? "Feat"),
				area: fields.area == null ? undefined : String(fields.area),
				body: `${String(fields.body ?? "")}\n\nProposed by the post-turn review fork (hub#203); approved via \`bi review approve\`. Rationale: ${String(fields.rationale ?? "")}`,
			});
			console.error(`filed\t${f.issue.id}`);
		},
	};
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
	// bi#91: keybindings overrides load once at startup (file → cache, loud
	// on unknown ids / bad key names); /reload re-reads live, every prompt
	// modal consumes the cache via currentKeybindingsManager().
	try {
		const kb = await reloadKeybindings();
		if (kb.applied > 0 && kb.errors.length === 0) console.error(`[bi] ${kb.applied} keybinding override(s) from ${getKeybindingsPath()}`);
	} catch (e) {
		console.error(`[keybindings] ${e instanceof Error ? e.message : e}`);
	}
	if (!cmd) {
		await warnBaisFailures();
		const ready = await readyBaisIssues();
		// Ready frame renders in BAML (tui.baml render_ready_frame) —
		// first production frame from the component model. HostTui
		// only diffs + writes lines.
		const tui = new HostTui();
		// bi#163: the ready frame composes through composeFrame (transcript
		// region, grow) like every other frame — HostTui only diffs lines.
		const readyWidth = termWidth();
		tui.render(
			composeFrame(
				[
					{
						lines: await render_ready_frame_async(
							ready.map((f) => ({ id: f.issue.id, title: f.issue.title })),
							readyWidth,
						),
						grow: 1,
						shrink: 1,
						minSize: 0,
					},
				],
				{ width: readyWidth },
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
			await repl(skills, {
				skipPicker: hasFlag(args, "--continue") || hasFlag(args, "-c") || hasFlag(args, "--session") || hasFlag(args, "--print") || hasFlag(args, "-p"),
			});
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
		// bi#75: headless runs log under run-<pid>; leased runs add
		// claim/release lines so the drill replays who held what.
		const turnLog = new ActionLog(`run-${process.pid}`);
		turnLog.record("turn.start", String(prompt).slice(0, 80));
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
				turnLog.record("lease.claim", `${taskId} fencing=${claimed.fencing}`);
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
		// bi#70: --image <path> stages one file for a single-shot image
		// turn (no tools — the SendTurnWithImage wire carries none by
		// construction, same as the REPL staged-image path). The part
		// echoes in the transcript first: graphics bytes on kitty/iTerm2
		// TTYs (live probe upgrades an inconclusive env), the BAML
		// placeholder everywhere else (always on pipes). Machine modes
		// stay out: RunEvent JSON has no image event (events.baml,
		// BAML-validated), so --mode json/rpc refuse --image.
		const imagePath = getFlag(args, "--image");
		if (imagePath) {
			const imageMode = getFlag(args, "--mode");
			if (imageMode === "json" || imageMode === "rpc") {
				console.error("bi run --image is human-mode only (RunEvent JSON has no image event)");
				process.exit(1);
			}
			let imageBytes: Buffer;
			try {
				imageBytes = readFileSync(imagePath);
			} catch {
				console.error(`bi run: --image unreadable: ${imagePath}`);
				process.exit(1);
			}
			if (imageBytes.length > 5 * 1024 * 1024) {
				console.error(`bi run: --image is ${(imageBytes.length / 1_048_576).toFixed(1)}mb (5mb cap, same as /paste)`);
				process.exit(1);
			}
			const imageMime = sniffImageMime(imageBytes);
			if (!imageMime) {
				console.error("bi run: --image needs a PNG/JPEG/WebP/GIF file (sniffed, not extended)");
				process.exit(1);
			}
			let imageSupported = true;
			try {
				imageSupported = await ModelSupportsImage_async(model);
			} catch {}
			if (!imageSupported) {
				console.error(`bi run: ${model} doesn't take image parts — pick an image-capable model`);
				process.exit(1);
			}
			const echoTheme = await activeTheme();
			await showStagedImage(imagePath, imageBytes.toString("base64"), {
				labelForPath: (p) => staged_image_label_async(p),
				fallbackForLabel: (label) => format_image_placeholder_async(label, { theme: echoTheme }),
				probeLive: true,
			});
			const img = await runSingleImageTurn(fullPrompt + skillsSection, {
				provider, model, apiKey, baseUrl, temperature, thinkingLevel,
				imageBase64: imageBytes.toString("base64"),
				imageMime,
			});
			turnLog.record("turn.end", "failure" in img ? `failed:${img.failure.kind}` : "ok");
			if ("failure" in img) {
				console.error(`TurnFailure: kind=${img.failure.kind} retry_safe=${img.failure.retry_safe} message=${img.failure.message}`);
				const imageGuidance = await GuidanceFor_async(img.failure.kind, provider);
				if (imageGuidance) console.error(imageGuidance);
				process.exit(1);
			}
			await printMarkdownText(img.text, echoTheme);
			return;
		}
		// bi#188: BI_TUI=go routes the human turn-render path through the
		// Go Bubble Tea shell (bi/tui-go, bi#187) over the NDJSON/JSON-RPC
		// seam — tui_seam.ts is the only writer, and the Go process owns
		// every terminal byte while it lives. Machine modes (--mode
		// json/rpc), --print, pipes, and image turns stay on the host
		// path. Spawn failure or a mid-turn crash falls back to pi-tui
		// with a named warn (bi#55), never a silent swap.
		let seam: GoTuiSeam | null = null;
		if (goTuiRequested()) {
			const m = getFlag(args, "--mode");
			if (m === "json" || m === "rpc" || hasFlag(args, "--print") || hasFlag(args, "-p")) {
				console.error("[bi] BI_TUI=go ignored — machine/plain output modes stay on the host path");
			} else if (!process.stdout.isTTY) {
				console.error("[bi] BI_TUI=go ignored — stdout is not a TTY (the Go shell renders on /dev/tty)");
			} else {
				const started = await GoTuiSeam.start({
					onDead: (reason) => console.error(`[bi] BI_TUI=go: ${reason} — falling back to pi-tui output`),
				});
				if ("error" in started) {
					console.error(`[bi] BI_TUI=go requested but the Go shell did not start (${started.error}) — falling back to pi-tui`);
				} else {
					seam = started.seam;
				}
			}
		}
		// bi#188 drill seam: BI_LLM_FIXTURE=<json> scripts canned turns
		// offline (the issue's "scripted prompt fixtures" path — no API
		// key needed). Drill-only; never set in production.
		const fixturePath = process.env.BI_LLM_FIXTURE ?? null;
		const fixtureFn = fixturePath ? await fixtureLlmFn(fixturePath, seam) : null;
		if (seam) {
			seam.agentEvent("spinner_start", "Thinking…");
			seam.footerFrame({ provider, model, thinking: thinkingLevel ?? "default", tokensIn: 0, tokensOut: 0, cwd: footerCwd(), turn: 0, messages: 0, branch: gitBranch() ?? undefined });
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
				toolHandler: loggingHandler(turnLog, seam),
				notify: subscriber?.queue,
				keeper,
				...(fixtureFn ? { llmFn: fixtureFn } : {}),
				// bi#188: live stream across the seam — the same BAML-chunked
				// incremental path the REPL uses, deltas as plain data.
				...(seam
					? {
							onAssistantText: async (text: string) => {
								await streamTextIncremental(text, (delta) => {
									seam.assistantDelta(delta);
								}, { isCancelled: () => !seam.alive });
							},
						}
					: {}),
				// bi#97: human modes emit the compaction transcript block;
				// --mode json stays machine-clean (block data is in messages).
				// bi#188: under a live seam the block would poison the Go
				// frame — a status event carries the fact instead.
				...(getFlag(args, "--mode") === "json" ? {} : { compaction: { onCompacted: async (info: { summary: string; foldedTurns: number; tokensBefore: number; tokensAfter: number }) => { if (seam?.alive) { seam.agentEvent("status", `compacted ${info.foldedTurns} turn(s)`); return; } await printCompactionSummary({ summary: info.summary, tokensBefore: info.tokensBefore, tokensAfter: info.tokensAfter, foldedTurns: info.foldedTurns, theme: null }); } } }),
			});
			turnLog.record("turn.end", result.failure ? `failed:${result.failure.kind}` : "ok");
		} finally {
			// Deliberate free, not a loss: release first so leaseError()
			// stays null and the run is judged on its work, then stop the
			// subscriber. Errors here warn; the run's own result stands.
			if (keeper) {
				try {
					await keeper.release();
					console.error(`[keeper] released ${taskId}`);
					turnLog.record("lease.release", String(taskId));
				} catch (e: any) {
					console.error(`[keeper] release failed: ${e instanceof Error ? e.message : e}`);
				}
			}
			if (subscriber) await subscriber.stop();
		}

		// bi#188: with a live seam the Go shell rendered the whole turn —
		// stream, tool lines, footer — so the result crosses as turn/result
		// markdown data and the host prints nothing else to the terminal
		// until the child has exited. A dead seam already warned (named);
		// the run falls through to the normal host dump below.
		if (seam?.alive) {
			seam.agentEvent("spinner_stop", "");
			if (result.failure) {
				seam.turnResult(`**TurnFailure ${result.failure.kind}** (retry_safe=${result.failure.retry_safe})\n\n${result.failure.message}`);
			} else {
				let markdown = finalText(result) ?? "";
				// bi#188 drill fixture: a picker fired mid-stream settles
				// after the loop (the text turn ends it first) — surface
				// the choice in the committed markdown so the answer's
				// arrival at the host is visible in scrollback.
				const pickerAns = fixtureFn ? await fixtureFn.pickerAnswer() : null;
				if (pickerAns && typeof pickerAns === "object") markdown += `\n\nfollow-up chosen: ${pickerAns.itemId}`;
				else if (pickerAns === "cancelled") markdown += "\n\nfollow-up: cancelled";
				seam.turnResult(markdown);
			}
			seam.footerFrame({ provider, model, thinking: thinkingLevel ?? "default", tokensIn: 0, tokensOut: 0, cwd: footerCwd(), turn: result.turns.length, messages: result.messages.length, branch: gitBranch() ?? undefined });
			const seamExit = await seam.close();
			if (result.failure) {
				console.error(`TurnFailure: kind=${result.failure.kind} retry_safe=${result.failure.retry_safe} message=${result.failure.message}`);
				const guidance = await GuidanceFor_async(result.failure.kind, provider);
				if (guidance) console.error(guidance);
				process.exit(1);
			}
			console.error(`[bi] go-tui session closed (exit ${seamExit})`);
			return;
		}
		if (seam) {
			// Crash path: reap quietly — onDead already named the failure.
			await seam.close();
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
			if (t) await printMarkdownText(t, runTheme);
			return;
		}
		// bi#27: history display shapes text blocks and tool calls alike.
		for (const msg of result.messages) {
			if (msg.role === "assistant" && "text" in msg) {
				await printMarkdownText(msg.text, runTheme);
			} else if (msg.role === "assistant" && "content" in msg) {
				for (const b of (msg as any).content) {
					if (b.type === "text") await printMarkdownText(b.text, runTheme);
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
			if (getFlag(args, "--order") !== undefined) {
				console.error("bi bais list: --order is only supported by `bi bais ready`");
				process.exit(1);
			}
			const { issues: files, failures } = await loadBaisIssues();
			// bi#122 marker: trailing br=N column (open blast radius).
			const radii = new Map(blastRadii(files).map((r) => [r.id, r]));
			const brCol = (id: string): string => `\tbr=${radii.get(id)?.open_downstream ?? 0}`;
			if (asJson) printJson({ issues: files, unparseable: failures });
			else {
				for (const f of files) console.log(`${f.issue.id}\t${f.issue.status}\t${f.issue.kind}\t${f.issue.title}${brCol(f.issue.id)}`);
				for (const b of failures) console.log(`bad\t${b.file}\t${b.error}`);
				if (files.length === 0 && failures.length === 0) console.error("(no .bais/issues/*.toml — run bais init or add issues)");
			}
			return;
		}
		if (sub === "ready") {
			// JSON shape matches `bais ready --json`: {ready, unparseable}.
			// Unparseable files are absent from the graph, so both the ready
			// set and the edges that would have constrained it are short.
			const order = getFlag(args, "--order");
			if (order !== undefined && order !== "blast-radius") {
				console.error(`bi bais ready: --order ${JSON.stringify(order)} needs blast-radius (the only ordering)`);
				process.exit(1);
			}
			const { issues, failures } = await loadBaisIssues();
			const radii = new Map(blastRadii(issues).map((r) => [r.id, r]));
			let ready = filterReadyIssues(issues);
			if (order === "blast-radius") {
				ready = [...ready].sort(
					(a, b) => (radii.get(b.issue.id)?.open_downstream ?? 0) - (radii.get(a.issue.id)?.open_downstream ?? 0) || (a.issue.id < b.issue.id ? -1 : a.issue.id > b.issue.id ? 1 : 0),
				);
			}
			const brCol = (id: string): string => `\tbr=${radii.get(id)?.open_downstream ?? 0}`;
			if (asJson) printJson({ ready, unparseable: failures });
			else {
				for (const f of ready) console.log(`${f.issue.id}\t${f.issue.title}${brCol(f.issue.id)}`);
				if (ready.length === 0) console.log("(no ready issues)");
				if (failures.length) console.error(`[bais] ${failures.length} unparseable file(s) excluded — \`bi bais check\` for details`);
			}
			return;
		}
		if (sub === "dispatch") {
			// bi#123 dry-run swarm pack. Scan-only (live envelopes + fresh
			// bodies); never mutates — agents claim for themselves.
			// hub#163: single-source briefs — renderBrief/warnPartial are
			// imported from bais/scripts/briefs.mjs (canonical), never
			// mirrored here. Resolution is module-anchored first (works from
			// any cwd in this checkout) with cwd-anchored fallbacks; a miss
			// fails loud, never silent-drifted. Same runtime requirement
			// class as the bais dist delegation (bi#84): no bais checkout,
			// no bais-backed briefs.
			const loadBriefsRenderer = async (): Promise<{ renderBrief: (o: any) => string; warnPartial: (b: number, p: number) => string | null }> => {
				const { dirname } = await import("node:path");
				const { fileURLToPath, pathToFileURL } = await import("node:url");
				const here = dirname(fileURLToPath(import.meta.url));
				const { existsSync: exists } = await import("node:fs");
				const { resolve: resolveP, join: joinP } = await import("node:path");
				const candidates = [
					joinP(here, "..", "..", "..", "bais", "scripts", "briefs.mjs"), // bi/dist/src -> repo/bais
					joinP(here, "..", "..", "bais", "scripts", "briefs.mjs"), // bi/src dev -> repo/bais
					joinP(resolveP(process.cwd(), "bais"), "scripts", "briefs.mjs"),
					joinP(resolveP(process.cwd(), "../bais"), "scripts", "briefs.mjs"),
					joinP(resolveP(process.cwd(), "../../bais"), "scripts", "briefs.mjs"),
				];
				const found = candidates.find((c) => exists(c));
				if (!found) {
					console.error(`bi bais dispatch: brief renderer not found (tried ${candidates.join(", ")})`);
					process.exit(1);
				}
				return (await import(pathToFileURL(found).href)) as any;
			};
			const { renderBrief: renderSlotBrief, warnPartial: warnPartialSlots } = await loadBriefsRenderer();
			// hub#163: local renderBrief/warnPartial mirrors deleted —
			// renderSlotBrief/warnPartialSlots ARE bais/scripts/briefs.mjs.
			// No `style` passed (same parser gap as bais/src/cli.ts: ns_toml
			// rejects top-level `style`, so no loadable issue carries one).
			const rawAgents = getFlag(args, "--agents");
			const budget = rawAgents === undefined ? NaN : Number(rawAgents);
			if (!Number.isInteger(budget) || budget <= 0) {
				console.error("bi bais dispatch needs --agents <positive integer>");
				process.exit(1);
			}
			const { issues, failures } = await loadBaisIssues();
			const now = Date.now();
			const leased = issues
				.filter((f) => f.holder != null && f.lease != null && Number.isFinite(Date.parse(f.lease)) && Date.parse(f.lease) > now)
				.map((f) => f.issue.id);
			const footprints = new Map(issues.map((f) => [f.issue.id, parseFileClaims(f.issue.body)]));
			const declared = new Set(
				issues.filter((f) => (f.issue.body ?? "").split("\n").some((l) => l.trim().startsWith("Files:"))).map((f) => f.issue.id),
			);
			const radii = new Map(blastRadii(issues).map((r) => [r.id, r]));
			const byId = new Map(issues.map((f) => [f.issue.id, f]));
			const slots = dispatchPack(issues, leased, footprints, budget).map((s) => ({
				slot: s.slot,
				issue: { id: s.issue_id, title: byId.get(s.issue_id)?.issue.title ?? "" },
				open_downstream: radii.get(s.issue_id)?.open_downstream ?? 0,
				files: footprints.get(s.issue_id) ?? [],
				files_state: declared.has(s.issue_id) ? "declared" : "unknown",
			}));
			// hub#175 warning path (mirror of bais/src/cli.ts): dispatchPack
			// withholds 2nd+ unknowns — name the cost. withheld = unpacked
			// ready+unleased unknowns capped by unfilled, in greedy order; a
			// kept unknown alongside declared partners warns naming it.
			const unfilled = budget - slots.length;
			const packedIds = new Set(slots.map((s) => s.issue.id));
			const readyIds = new Set(filterReadyIssues(issues).map((f) => f.issue.id));
			const keptUnknown = slots.find((s) => s.files_state !== "declared");
			const unpackedUnknowns = issues
				.filter((f) => !declared.has(f.issue.id) && !packedIds.has(f.issue.id) && !leased.includes(f.issue.id) && readyIds.has(f.issue.id))
				.map((f) => f.issue.id)
				.sort((a, b) => (radii.get(b)?.open_downstream ?? 0) - (radii.get(a)?.open_downstream ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
			const withheld = keptUnknown !== undefined ? unpackedUnknowns.slice(0, Math.max(0, unfilled)) : [];
			const unknownWarnings: string[] = [];
			if (withheld.length) unknownWarnings.push(warnUnknownWithheld(withheld));
			if (keptUnknown !== undefined) {
				const partners = slots.filter((s) => s.files_state === "declared").map((s) => s.issue.id);
				if (partners.length) unknownWarnings.push(warnUnknownShared(keptUnknown.issue.id, partners));
			}
			// bi#125/bi#126: --briefs renders spawn briefs instead of slot
			// rows; every mode carries unfilled + the loud partial-pack line.
			const wantBriefs = hasFlag(args, "--briefs");
			const partial = warnPartialSlots(budget, slots.length);
			const briefFor = (s: (typeof slots)[number]): string => {
				const f = byId.get(s.issue.id);
				return renderSlotBrief({ slot: s.slot, id: s.issue.id, title: s.issue.title, status: f?.issue.status, body: f?.issue.body, files: s.files, files_state: s.files_state, open_downstream: s.open_downstream, dir: process.cwd() });
			};
			// --json stays stderr-quiet (the machine field is unfilled);
			// briefs.mjs shells here inheriting stderr and warns itself, so
			// a loud line here would double §8's pinned single line.
			if (asJson) printJson({ slots: wantBriefs ? slots.map((s) => ({ ...s, brief: briefFor(s) })) : slots, leased, budget, unfilled, warnings: unknownWarnings, withheld, unparseable: failures });
			else if (wantBriefs) {
				if (partial) console.error(partial);
				for (const w of unknownWarnings) console.error(w);
				if (slots.length === 0) console.log("(no packable issues for this budget)");
				slots.forEach((s, i) => console.log((i === 0 ? "" : "\n") + briefFor(s)));
			} else {
				if (partial) console.error(partial);
				for (const w of unknownWarnings) console.error(w);
				for (const s of slots) {
					const files = s.files_state === "declared" ? s.files.join(",") : "unknown";
					console.log(`slot${s.slot}\t${s.issue.id}\tbr=${s.open_downstream}\tfiles: ${files}\t${s.issue.title}`);
				}
				if (slots.length === 0) console.log("(no packable issues for this budget)");
				if (leased.length) console.error(`[bais] skipped live-claimed: ${leased.join(", ")}`);
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
			// bi#111: edges at birth (repeatable). Ends must exist;
			// Missing/self-link/dup refuse loudly, never half-written.
			const edges = [
				...getAllFlags(args, "--blocks").map((to) => ({ kind: "Blocks", to })),
				...getAllFlags(args, "--depends-on").map((to) => ({ kind: "DependsOn", to })),
			];
			try {
				const file = await createBaisIssue({ title, kind, area, body, status, edges });
				console.log(`${file.issue.id}\t${file.issue.title}`);
			} catch (e) {
				console.error(`bais new: ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			return;
		}
		if (sub === "link") {
			const from = args[2];
			const kind = args[3];
			const to = args[4];
			if (!from || !kind || !to) { console.error("bais link requires <from> <Kind> <to>"); process.exit(1); }
			try {
				const file = await linkBaisIssues(from, kind, to);
				console.log(`linked\t${file.issue.id}\t${kind}\t${to}`);
			} catch (e) {
				console.error(`bais link: ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			return;
		}
		if (sub === "move") {
			const id = args[2];
			const status = args[3];
			if (!id || !status) { console.error("bais move requires <id> <Status>"); process.exit(1); }
			const as = getFlag(args, "--as");
			const forRaw = getFlag(args, "--for");
			let forMs: number | undefined;
			if (forRaw != null) {
				const p = parseClaimDuration(forRaw);
				if (p == null) { console.error(`bais move: --for ${JSON.stringify(forRaw)} needs <n>s|m|h|d`); process.exit(1); }
				forMs = p;
			}
			try {
				const file = await moveBaisIssue(id, status, undefined, as != null ? { as, forMs } : undefined);
				console.log(`${file.issue.id}\t${file.issue.status}`);
			} catch (e) {
				console.error(`bais move: ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			return;
		}
		if (sub === "renew") {
			const id = args[2];
			const as = getFlag(args, "--as");
			if (!id || !as) { console.error("bais renew requires <id> --as <owner> [--for <n>s|m|h|d]"); process.exit(1); }
			const forRaw = getFlag(args, "--for");
			let forMs = 4 * 3600000;
			if (forRaw != null) {
				const p = parseClaimDuration(forRaw);
				if (p == null) { console.error(`bais renew: --for ${JSON.stringify(forRaw)} needs <n>s|m|h|d`); process.exit(1); }
				forMs = p;
			}
			try {
				const file = await renewBaisClaim(id, as, forMs);
				console.log(`renewed\t${file.issue.id}\t${file.holder}\t${file.lease}`);
			} catch (e) {
				console.error(`bais renew: ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			return;
		}
		if (sub === "reap") {
			const nowRaw = getFlag(args, "--now");
			let nowMs = Date.now();
			if (nowRaw != null) {
				const t = Date.parse(nowRaw);
				if (Number.isNaN(t)) { console.error(`bais reap: --now ${JSON.stringify(nowRaw)} does not parse as an instant`); process.exit(1); }
				nowMs = t;
			}
			const reaped = await reapBaisClaims(nowMs);
			if (asJson) console.log(JSON.stringify({ reaped }, null, 2));
			else {
				if (!reaped.length) console.log("reaped\t0");
				for (const r of reaped) console.log(`reaped\t${r.id}\t${r.holder ?? "unknown"}\t${r.lease ?? "no-lease"}`);
			}
			return;
		}
		if (sub === "check") {
			const { ok, bad, dangling, cycles, evidence } = await checkBaisIssues();
			const missing = dangling.filter((d) => d.status === "Missing");
			const external = dangling.filter((d) => d.status === "External");
			const fatalEvidence = evidence.filter((p) => p.status === "Missing");
			if (asJson) console.log(JSON.stringify({ ok: ok.length, bad, dangling, cycles, evidence }, null, 2));
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
				// Close-evidence (bi#83, delegated to bais's gate): Done with
				// no (or unresolvable) Evidence: refs refuses loudly here too,
				// so `bi bais check` and `bais check` cannot disagree.
				for (const p of evidence) {
					if (p.reason === "missing-close-evidence") console.log(`evidence\t${p.id}\tmissing-close-evidence\tDone with no Evidence: refs`);
					else console.log(`evidence\t${p.id}\t${p.reason}\t${p.ref} does not resolve`);
				}
			}
			// Applies to both output modes — --json previously always exited 0,
			// which made it useless as a CI gate. External alone never fails
			// (dangling or verdict).
			if (bad.length || missing.length || cycles.length || fatalEvidence.length) process.exit(1);
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
		if (sub === "goal") {
			// bi#132: /goal interview/sketch/commit/status/switch (src lane).
			// Same single-source rule as dispatch --briefs (hub#163): goal
			// logic lives ONLY in bais/scripts/goal.mjs; this branch routes
			// args, resolves the per-directory .bais/goal.toml (root .bais/
			// is the ecosystem hub — goal.toml lives there), and renders.
			const loadGoalModule = async (): Promise<any> => {
				const { pathToFileURL } = await import("node:url");
				const here = dirname(fileURLToPath(import.meta.url));
				const candidates = [
					join(here, "..", "..", "..", "bais", "scripts", "goal.mjs"), // bi/dist/src -> repo/bais
					join(here, "..", "..", "bais", "scripts", "goal.mjs"), // bi/src dev -> repo/bais
					join(resolve(process.cwd(), "bais"), "scripts", "goal.mjs"),
					join(resolve(process.cwd(), "../bais"), "scripts", "goal.mjs"),
					join(resolve(process.cwd(), "../../bais"), "scripts", "goal.mjs"),
				];
				const found = candidates.find((c) => existsSync(c));
				if (!found) {
					console.error(`bi bais goal: goal.mjs not found (tried ${candidates.join(", ")})`);
					process.exit(1);
				}
				return (await import(pathToFileURL(found).href)) as any;
			};
			const gm = await loadGoalModule();
			// Nearest hub wins (mirrors resolveIssuesDir in ./bais.js: the
			// root .bais/ is the ecosystem hub). Read verbs use the first
			// goal.toml on disk; start-fresh writes into the nearest hub.
			const goalTomlCandidates = [
				join(process.cwd(), ".bais", "goal.toml"),
				join(process.cwd(), "bi", ".bais", "goal.toml"),
				join(resolve(process.cwd(), ".."), ".bais", "goal.toml"),
				join(process.cwd(), "bais", ".bais", "goal.toml"),
			];
			const hubCandidates = [
				join(process.cwd(), ".bais"),
				join(process.cwd(), "bi", ".bais"),
				join(resolve(process.cwd(), ".."), ".bais"),
				join(process.cwd(), "bais", ".bais"),
			];
			const verb = args[2];
			const usage = `bi bais goal <start|sketch|commit|status|switch> — per-directory campaign interview (bi#132)`;
			const loadGoal = (): { file: string; goal: any } => {
				const file = goalTomlCandidates.find((c) => existsSync(c));
				if (!file) {
					console.error(`bi bais goal: no campaign found (tried ${goalTomlCandidates.join(", ")}) — run \`bi bais goal start "<statement>"\` first`);
					process.exit(1);
				}
				return { file, goal: gm.parseGoalToml(readFileSync(file, "utf8")) };
			};
			const runInterview = async (g: any, goalFile: string): Promise<void> => {
				const rl = createInterface({ input: process.stdin });
				const it = rl[Symbol.asyncIterator]();
				for (;;) {
					if (gm.checklistComplete(g)) break;
					const q = gm.nextQuestion(g);
					if (gm.checklistComplete(g)) {
						console.log(q);
						break; // rounds-cap notice: the rest auto-defaulted above
					}
					console.log(q);
					const box = gm.openBoxes(g)[0];
					const nxt = await it.next();
					if (nxt.done) {
						console.error(`bi bais goal: input closed — interview saved at ${goalFile}, rerun \`bi bais goal start\` to resume`);
						break;
					}
					const line = String(nxt.value ?? "");
					const t = line.trim().toLowerCase();
					try {
						if (t === "defaults") gm.useDefaults(g);
						else if (t === "waive") gm.waive(g, box);
						else gm.answer(g, box, line);
					} catch (e: any) {
						console.error(`bi bais goal: ${e?.message ?? e} (box still open)`);
						continue;
					}
					writeFileSync(goalFile, gm.renderGoalToml(g));
				}
				rl.close();
				writeFileSync(goalFile, gm.renderGoalToml(g));
				if (gm.checklistComplete(g)) console.log(`bi bais goal: checklist complete — \`bi bais goal sketch\` to dry-run the proposal`);
				if (asJson) printJson({ statement: g.statement, complete: gm.checklistComplete(g), open: gm.openBoxes(g) });
			};
			if (verb === "start") {
				const force = hasFlag(args, "--force");
				const existing = goalTomlCandidates.find((c) => existsSync(c));
				if (existing && !force) {
					const { goal: cur } = loadGoal();
					if (!gm.checklistComplete(cur)) {
						await runInterview(cur, existing); // open interview: start resumes it
						return;
					}
					console.error(`bi bais goal: campaign already complete at ${existing} — \`bi bais goal switch "<new statement>"\` to restructure, or \`bi bais goal start --force "<statement>"\` to restart`);
					process.exit(1);
				}
				const statement = args[3];
				if (!statement || statement.startsWith("--")) {
					console.error(`bi bais goal start needs "<statement>"`);
					process.exit(1);
				}
				const hub = existing ?? hubCandidates.find((h) => existsSync(h));
				if (!hub) {
					console.error(`bi bais goal: no .bais hub found — run bais init first`);
					process.exit(1);
				}
				const file = existing ?? join(hub, "goal.toml");
				const g = gm.newGoal(statement);
				writeFileSync(file, gm.renderGoalToml(g));
				await runInterview(g, file);
				return;
			}
			if (verb === "sketch") {
				const { goal: g } = loadGoal();
				const res = gm.sketch(g);
				if (!res.ok) {
					console.error(`bi bais goal: ${res.error}`);
					process.exit(1);
				}
				if (asJson) printJson({ ok: true, proposal: res.proposal });
				else {
					console.log(`proposal (dry run — nothing written; edit, then \`bi bais goal commit --approve\`):`);
					console.log(JSON.stringify(res.proposal, null, 2));
				}
				return;
			}
			if (verb === "commit") {
				// Load-bearing hunk (bi#132/bi#57 red-check target): approval
				// is an explicit human yes — the --approve flag and nothing
				// else. Defaulting this to true must trip the dogfood check
				// "commit refuses without approval".
				const approved = hasFlag(args, "--approve");
				const { file, goal: g } = loadGoal();
				// The sketch verb is the dry run; commit re-derives the
				// proposal fresh (sketch() side-effects goal.sketch, which
				// commit() requires — renderGoalToml persists no sketch).
				// Refusal texts stay scripts-verbatim (see bais/src/cli.ts
				// for the precedence note).
				const sk = gm.sketch(g);
				if (!sk.ok) {
					console.error(`bi bais goal: ${sk.error}`);
					process.exit(1);
				}
				const res = gm.commit(g, { approved, write: (toml: string) => writeFileSync(file, toml) });
				if (!res.ok) {
					console.error(`bi bais goal: ${res.error}`);
					process.exit(1);
				}
				if (asJson) printJson({ ok: true, wrote: res.wrote });
				else for (const f of res.wrote) console.log(`committed\t${f}`);
				return;
			}
			if (verb === "status") {
				const { file, goal: g } = loadGoal();
				const st = gm.status(g);
				const gate = gm.validateGoal(readFileSync(file, "utf8"));
				if (asJson) printJson({ file, ...st, errors: gate.errors, warns: gate.warns });
				else {
					console.log(`statement\t${st.statement}`);
					for (const b of Object.keys(st.checklist)) console.log(`box\t${b}\t${st.checklist[b]}`);
					console.log(`acceptance\t${st.done}/${st.total}`);
					for (const o of st.open) console.log(`open\t${o}`);
					console.log(`sketched\t${st.sketched}`);
					for (const w of gate.warns) console.error(`warn\t${w}`);
					if (gate.errors.length) {
						for (const e of gate.errors) console.error(`error\t${e}`);
						process.exit(1);
					}
				}
				return;
			}
			if (verb === "switch") {
				const newStatement = args[3];
				if (!newStatement || newStatement.startsWith("--")) {
					console.error(`bi bais goal switch needs "<new statement>"`);
					process.exit(1);
				}
				const { file, goal: g } = loadGoal();
				const res = gm.switchGoal(g, newStatement);
				writeFileSync(file, gm.renderGoalToml(res.fresh));
				if (asJson) printJson({ archived: res.archived, retire: res.retire, statement: res.fresh.statement });
				else {
					console.log(`archived\t${res.archived.statement}`);
					for (const id of res.retire) console.log(`retire\t${id}`);
				}
				await runInterview(res.fresh, file); // restructure flow ends in a fresh interview
				return;
			}
			console.error(usage);
			process.exit(1);
		}
		console.error(`Unknown bais subcommand: ${sub ?? ""} (try: bais list | ready | new | move | renew | reap | check | graph | goal)`);
		printHelp();
		process.exit(1);
	}

	// hub#203: post-turn review staging — the consent surface for the
	// ReviewTurn fork (baml_src/review.baml). Proposals arrive via
	// stageProposal (the fork's host path, or `review stage` for
	// dogfooding) and sit in .bi/review/pending/. ONLY `review approve`
	// reaches a store (memory → ~/.bi/memory.jsonl, skill → .bi/skills/,
	// issue → .bais/issues/ via createBaisIssue), and only through
	// approveProposal's pending gate (src/review-turn.ts). `review reject`
	// drops a staged proposal without touching any store.
	if (cmd === "review") {
		const sub = args[1];
		const asJson = hasFlag(args, "--json");
		const io = makeReviewTurnIO();
		if (sub === "pending") {
			const { proposals, corrupt } = await listPending(io);
			if (asJson) printJson({ pending: proposals, corrupt });
			else {
				for (const p of proposals) console.log(`${p.id}\t${p.type}\t${reviewProposalSummary(p)}`);
				for (const c of corrupt) console.error(`corrupt\t${c.id}\t${c.reason}`);
				if (proposals.length === 0 && corrupt.length === 0) console.log("(no staged review proposals)");
			}
			return;
		}
		if (sub === "stage") {
			// Dogfood/admin path INTO pending/ — same validation as the
			// fork's (actionType + envelope via stageProposal). Staging is
			// not the protected side; applying is.
			const jsonArg = args[2];
			if (!jsonArg) {
				console.error(`bi review stage needs a JSON fields object (e.g. '{"op":"add","content":"…","old_text":null,"rationale":"…"}')`);
				process.exit(1);
			}
			let fields: unknown;
			try {
				fields = JSON.parse(jsonArg);
			} catch (e) {
				console.error(`bi review stage: fields are not JSON: ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			try {
				const r = await stageProposal(fields, {}, io);
				if (asJson) printJson(r);
				else if (r.staged) console.log(`staged\t${r.id}`);
				else console.log(`not staged (NothingToSave): ${r.reason}`);
			} catch (e) {
				if (e instanceof ReviewStagingError) {
					console.error(`bi review stage: ${e.message}`);
					process.exit(1);
				}
				throw e;
			}
			return;
		}
		if (sub === "approve" || sub === "reject") {
			const id = args[2];
			if (!id || id.startsWith("--")) {
				console.error(`bi review ${sub} needs a proposal id (see \`bi review pending\`)`);
				process.exit(1);
			}
			try {
				const p = sub === "approve" ? await approveProposal(id, io) : await rejectProposal(id, io);
				if (asJson) printJson({ ok: true, verb: sub, proposal: p });
				else console.log(`${sub === "approve" ? "approved" : "rejected"}\t${p.id}\t${p.type}`);
			} catch (e) {
				if (e instanceof ReviewStagingError) {
					console.error(`bi review ${sub}: ${e.message}`);
					process.exit(1);
				}
				throw e;
			}
			return;
		}
		console.error(`Unknown review subcommand: ${sub ?? ""} (try: review pending | stage | approve <id> | reject <id>)`);
		process.exit(1);
	}

	// bi#91: keybindings manager — user-editable ~/.bi/keybindings.json
	// (`{ "<tui.* id>": "<key>" | [...] }`, BAML-validated). View/remap
	// here; every prompt modal and /reload consume the same file.
	if (cmd === "keybindings") {
		const sub = args[1];
		const asJson = hasFlag(args, "--json");
		const kb = await reloadKeybindings();
		if (sub === "list" || (!sub && !promptAvailable())) {
			if (asJson) printJson(await renderKeybindingJson());
			else {
				const { text, errors } = await renderKeybindingList();
				console.log(text);
				for (const e of errors) console.error(`[keybindings] ${e}`);
				if (kb.errors.length === 0) console.error(`(* = overridden — \`bi keybindings set <id> <keys...>\` to remap, \`bi keybindings\` for the picker)`);
			}
			return;
		}
		if (sub === "set" || sub === "unset") {
			const id = args[2];
			if (!id) { console.error(`usage: bi keybindings set <id> <key...> | bi keybindings unset <id>`); process.exit(1); }
			// `set <id>` with no keys unbinds (empty list); `unset` removes
			// the override entirely (back to the library default).
			const keys = sub === "set" ? args.slice(3) : null;
			const { entries } = loadKeybindingsFile();
			const next: KeybindingFileEntry[] = entries.filter((e) => e.id !== id);
			if (keys !== null) next.push({ id, keys });
			try {
				await saveKeybindings(next);
			} catch (e) {
				console.error(`[keybindings] ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			await reloadKeybindings();
			const curRaw = getUserKeybindings()[id];
			const cur = Array.isArray(curRaw) ? curRaw.join(" ") || "(unbound)" : (curRaw ?? "(default)");
			const label = keys === null ? cur : keys.length ? keys.join(" ") : "(unbound)";
			console.error(`[keybindings] ${id} → ${label} (saved — /reload picks it up live)`);
			return;
		}
		if (sub === "reset") {
			if (resetKeybindings()) console.error(`[keybindings] removed ${getKeybindingsPath()} — library defaults restored`);
			else console.error(`[keybindings] no file at ${getKeybindingsPath()} — already defaults`);
			return;
		}
		if (!sub && promptAvailable()) {
			// Interactive manager: pick a binding, then type its keys.
			const { rows } = await listKeybindingRows();
			const at = await pickList(
				"keybindings (esc cancels)",
				rows.map((r) => ({
					label: `${r.overridden ? "*" : " "} ${r.id}  ${(r.current_keys.join(" ") || "(unbound)")}`,
					description: r.description,
				})),
			);
			if (at === null) return;
			const row = rows[at];
			const answer = await askText(`keys for ${row.id} (space-separated, empty unbinds, default: ${row.default_keys.join(" ") || "(none)"})`, row.current_keys.join(" "));
			if (answer === null) return;
			const keys = answer.trim() === "" ? [] : answer.trim().split(/\s+/);
			const { entries } = loadKeybindingsFile();
			const next: KeybindingFileEntry[] = entries.filter((e) => e.id !== row.id);
			next.push({ id: row.id, keys });
			try {
				await saveKeybindings(next);
			} catch (e) {
				console.error(`[keybindings] ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			await reloadKeybindings();
			console.error(`[keybindings] ${row.id} → ${keys.join(" ") || "(unbound)"} (saved — /reload picks it up live)`);
			return;
		}
		console.error(`Unknown keybindings subcommand: ${sub ?? ""} (try: keybindings [list [--json] | set <id> <keys...> | unset <id> | reset])`);
		printHelp();
		process.exit(1);
	}

	// bi#138 hunk-by-hunk review. READ-ONLY by default like dispatch
	// dry-runs: without --apply nothing is created, moved, or linked —
	// flags only print what would be filed. Rendering reuses the diff
	// pipeline (colorizeDiffLines); provenance reuses Files: footprints.
	if (cmd === "review") {
		const asJson = hasFlag(args, "--json");
		const loud = (msg: string): void => { console.error(msg); };
		try {
			assertSkepticReady(hasFlag(args, "--skeptic"));
		} catch (e) {
			console.error(`bi review: ${e instanceof Error ? e.message : e}`);
			process.exit(1);
		}
		const refArg = args[1] !== undefined && !args[1].startsWith("--") ? args[1] : null;
		const refLabel = refArg ?? "worktree";
		let diffText: string;
		try {
			diffText = execFileSync("git", gitDiffArgs(refArg), { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
		} catch (e) {
			console.error(`bi review: git diff failed (${e instanceof Error ? e.message : e})`);
			process.exit(1);
		}
		// Provenance: Doing-claimed footprints first (live work owns the
		// worktree diff), then every other claimed file; --provenance JSON
		// ({ "<path>": { issue, agent, handoff } }) overrides per file.
		const { issues } = await loadBaisIssues();
		const ranked = [...issues.filter((f) => f.issue.status === "Doing"), ...issues.filter((f) => f.issue.status !== "Doing")];
		const footprints = ranked.map((f) => ({ id: f.issue.id, holder: f.holder, files: parseFileClaims(f.issue.body) }));
		let overrides: Record<string, Partial<ReviewProvenance>> | undefined;
		const provPath = getFlag(args, "--provenance");
		if (provPath !== undefined) {
			try {
				overrides = JSON.parse(readFileSync(provPath, "utf8"));
			} catch (e) {
				console.error(`bi review: cannot read --provenance ${provPath} (${e instanceof Error ? e.message : e})`);
				process.exit(1);
			}
		}
		// Untracked files are invisible to `git diff HEAD` — name them loudly
		// so the queue never implies full coverage. Best-effort: a status
		// failure degrades to an empty note, never a refused review.
		let untracked: string[] = [];
		try {
			untracked = parseUntrackedFiles(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15000 }));
		} catch {}
		const parsed = parseUnifiedDiff(diffText);
		const queue = buildHunkQueue(parsed, (file) => provenanceForFile(file, footprints, overrides));
		try {
			assertQueueCoversDiffOnce(queue, parsed);
		} catch (e) {
			console.error(`bi review: internal queue error (${e instanceof Error ? e.message : e})`);
			process.exit(1);
		}
		if (queue.length === 0) {
			if (asJson) printJson(reviewToJson(refLabel, queue, [], untracked));
			else {
				console.log(`(no changes vs ${refLabel} — nothing to review)`);
				if (untracked.length) console.error(`untracked (not in queue — \`git add -N <file>\` to include): ${untracked.join(", ")}`);
			}
			return;
		}
		const theme = await activeTheme();
		const printHunk = async (h: (typeof queue)[number]): Promise<void> => {
			const p = h.provenance;
			console.log(`${hunkLabel(h, queue.length)}  [issue ${p.issue ?? "?"}${p.agent ? ` · agent ${p.agent}` : ""}${p.handoff ? ` · handoff ${p.handoff}` : ""}]`);
			for (const l of await colorizeDiffLines(h.lines, theme)) console.log(l);
		};
		let decisions: ReviewDecision[] = [];
		const decidePath = getFlag(args, "--decide");
		if (decidePath !== undefined) {
			let inputs: ReviewDecisionInput[];
			try {
				const raw: unknown = JSON.parse(readFileSync(decidePath, "utf8"));
				if (!Array.isArray(raw)) throw new Error("want a JSON array of { hunk, action, ... }");
				inputs = raw as ReviewDecisionInput[];
			} catch (e) {
				console.error(`bi review: cannot read --decide ${decidePath} (${e instanceof Error ? e.message : e})`);
				process.exit(1);
			}
			try {
				decisions = applyDecisionInputs(queue, inputs);
			} catch (e) {
				console.error(`bi review: ${(e as { reason?: string })?.reason ?? "bad-decision"} — ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
			if (!asJson) for (const h of queue) await printHunk(h);
		} else if (!asJson && promptAvailable() && process.stdin.isTTY && process.stdout.isTTY) {
			// Navigable queue: per-hunk verdict with back-step; Esc ends.
			const chosen = new Map<number, ReviewDecisionInput>();
			let idx = 0;
			while (idx < queue.length) {
				const h = queue[idx]!;
				await printHunk(h);
				const ans = await askText(`hunk ${h.id}/${queue.length} — [a]pprove [q]uestion [c]hallenge [f]lag [s]kip [b]ack [done]`, chosen.get(h.id)?.action?.[0] ?? "a");
				if (ans === null || ans.trim().toLowerCase() === "done") break;
				const verb = ans.trim().toLowerCase();
				if (verb === "b" || verb === "back") {
					idx = Math.max(0, idx - 1);
					chosen.delete(queue[idx]!.id);
					continue;
				}
				if (verb === "a" || verb === "approve" || verb === "") {
					chosen.set(h.id, { hunk: h.id, action: "approve" });
					idx++;
					continue;
				}
				if (verb === "s" || verb === "skip") {
					chosen.set(h.id, { hunk: h.id, action: "skip" });
					idx++;
					continue;
				}
				if (verb === "q" || verb === "question" || verb === "c" || verb === "challenge" || verb === "f" || verb === "flag") {
					const action = verb === "q" || verb === "question" ? "question" : verb === "c" || verb === "challenge" ? "challenge" : "flag";
					const need = action === "question" ? "question" : action === "challenge" ? "proof ref (test or red-check)" : "follow-up title";
					const got = await askText(`${action} on hunk ${h.id} — ${need} (Esc re-asks)`, "");
					if (got === null || got.trim() === "") {
						loud(`${action} needs ${need} — re-asking hunk ${h.id}`);
						continue;
					}
					chosen.set(h.id, action === "question" ? { hunk: h.id, action, text: got } : action === "challenge" ? { hunk: h.id, action, proof: got } : { hunk: h.id, action, title: got });
					idx++;
					continue;
				}
				loud(`unknown review verb ${JSON.stringify(ans)} — a/q/c/f/s/b/done`);
			}
			try {
				decisions = applyDecisionInputs(queue, [...chosen.values()]);
			} catch (e) {
				console.error(`bi review: ${(e as { reason?: string })?.reason ?? "bad-decision"} — ${e instanceof Error ? e.message : e}`);
				process.exit(1);
			}
		} else if (!asJson) {
			for (const h of queue) await printHunk(h);
		}
		const payload = reviewToJson(refLabel, queue, decisions, untracked);
		if (asJson) {
			printJson(payload);
			return;
		}
		const count = (a: string): number => decisions.filter((d) => d.action === a).length;
		console.log(`review ${refLabel}: ${queue.length} hunks — ${count("approve")} approved, ${count("question")} questioned, ${count("challenge")} challenged, ${count("flag")} flagged, ${queue.length - decisions.length} pending`);
		if (untracked.length) console.error(`untracked (not in queue — \`git add -N <file>\` to include): ${untracked.join(", ")}`);
		for (const v of payload.verdicts) console.log(`verdict\t${v}`);
		if (hasFlag(args, "--apply")) {
			for (const s of payload.flags) {
				try {
					const created = await createBaisIssue({ title: s.title, body: s.body, edges: s.linkTo ? [{ kind: "Related", to: s.linkTo }] : [] });
					console.log(`filed\t${created.issue.id}\t${s.title}`);
				} catch (e) {
					console.error(`bi review: cannot file flag for hunk #${s.hunk} (${e instanceof Error ? e.message : e})`);
					process.exit(1);
				}
			}
		} else {
			for (const s of payload.flags) console.error(`would-file\t${s.linkTo ? `Related ${s.linkTo}` : "unlinked"}\t${s.title}`);
		}
		return;
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
