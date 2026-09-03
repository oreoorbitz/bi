#!/usr/bin/env node
// bi CLI — minimal pi fork entry point (Orion's first name is Orion, CLI is `bi`).
// Commands mirror pi's provider/model surface that bi actually ports:
//   bi list-providers | list-models [--provider id] | get-model <id> | run <prompt>
// No external deps — uses bi's own provider/models/agent BAML port.

import { getModel, listAllModels, listModels } from "./models.js";
import { getProvider, listProviders } from "./provider.js";
import { runAgent } from "./agent.js";
import { loadBaisIssues, readyBaisIssues, filterReadyIssues, createBaisIssue, moveBaisIssue, checkBaisIssues, graphBaisIssues } from "./bais.js";
import { listTools, handleTool } from "./tools.js";
import { parse_args, format_help, is_valid_thinking_level, builtin_slash_commands_async } from "../baml_sdk/index.js";
import { loadSkills, formatSkills, skillBody, resolveSlash, type Skill } from "./skills.js";
import { runResultToJsonLines, finalText } from "./events.js";
import { getBiSessionsDir, createSessionFile, listSessions, findMostRecentSession, validateSessionIdOrThrow } from "./session.js";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { HostTui, HostStatus, renderReadyScreen } from "./tui.js";
import { format_status, format_turn_summary } from "../baml_sdk/index.js";
import { runBiLoop } from "./agent_loop.js";

function printHelp(): void {
	// BAML is spec: format_help() is bi-renamed pi help (APP_NAME bi, .bi)
	// Keep TS help in sync — if it diverges, BAML is truth.
	console.log(format_help());
	console.log(`\nBi extensions (BAML-owns-LLM, .bais is first-class):
  bi list-providers
  bi list-models [--provider <id>]
  bi get-model <id>
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

// Slash dispatch (bi#12): /builtin + /skill-name in the interactive prompt.
// Skill slashes expand the SKILL.md body into the prompt (pi runs skill
// content as the prompt); builtins execute directly. Returns the (possibly
// advanced) history, "quit" to end the REPL, "none" for ordinary prompts.
// History threads through so skill turns join the transcript like any turn.
async function handleSlash(line: string, skills: Skill[], history: any[], signal?: TurnSignal): Promise<any[] | "quit" | "none"> {
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
		return history;
	}
	return runOnePrompt(`${skillBody(t.skill)}\n\n${t.args}`.trim(), skills, history, signal ? { signal } : undefined);
}

// One prompt through the loop. Returns the full message history (prior +
// this turn) so the REPL threads conversation across turns, or "quit".
// opts.aborted resolves when the user hits Ctrl-C mid-turn: the turn is
// abandoned (flagged via opts.signal), the spinner stops now, and the late
// VM result is discarded on arrival — transcript and prompt survive.
async function runOnePrompt(q: string, skills: Skill[] = [], history: any[] = [], opts: { signal?: TurnSignal; aborted?: Promise<void> } = {}): Promise<any[] | "quit"> {
	const slash = await handleSlash(q, skills, history, opts.signal);
	if (slash === "quit") return "quit";
	if (slash !== "none") return slash;
	const skillsSection = skills.length ? `\n\n${await formatSkills(skills)}` : "";
	const fullPrompt = q + skillsSection + `\n\n[BAIS ready]\n${(await readyBaisIssues()).map((f) => `- ${f.issue.id} ${f.issue.title}`).join("\n")}`;
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
	const turnP = runBiLoop(fullPrompt, { provider: "anthropic", model: "claude-haiku-4-5", maxTurns: 5, baseUrl: process.env.BI_BASE_URL ?? null, onEvent: (e) => status.onEvent(e), tools: loopTools, toolHandler: async (name, args) => handleTool(name, args), history });
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
		return withUser;
	}
	status.stop({ failed: false, detail: "", turns: Math.max(assistantCount, 1), messages: result.messages.length });
	for (const m of result.messages) if ((m as any).role === "assistant") console.log((m as any).text ?? JSON.stringify((m as any).content));
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
	let turn = 0;
	try {
		for (;;) {
			let line: string;
			try {
				line = await reader.askMultiline(`bi[${turn}]> `);
			} catch {
				console.error("\n[bi] EOF — session kept at " + sessFile);
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
			const out = await runOnePrompt(line.trim(), skills, history, { signal, aborted });
			reader.onMidTurnInterrupt = null;
			if (out === "quit") {
				console.error(`[bi] session kept at ${sessFile} (${history.length} messages)`);
				return;
			}
			// Slash/empty lines return the same history — only real turns advance.
			if (out !== history) {
				history = out;
				turn += 1;
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
		const provider = getFlag(args, "--provider") ?? "anthropic";
		const model = getFlag(args, "--model") ?? "claude-haiku-4-5";
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
		const result = await runAgent(fullPrompt + skillsSection, {
			provider,
			model,
			apiKey,
			baseUrl,
			temperature,
			maxTurns,
			azureResource,
			azureDeployment,
			azureApiVersion,
			tools: runTools,
			toolHandler: async (name, args) => handleTool(name, args),
		});

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
			process.exit(1);
		}
		if (hasFlag(args, "--print") || hasFlag(args, "-p")) {
			const t = finalText(result);
			if (t) console.log(t);
			return;
		}
		for (const msg of result.messages) {
			if (msg.role === "assistant" && "text" in msg) {
				console.log(msg.text);
			} else if (msg.role === "assistant" && "content" in msg) {
				for (const b of (msg as any).content) {
					if (b.type === "text") console.log(b.text);
					else if (b.type === "toolUse") console.log(`[toolUse ${b.name} ${JSON.stringify(b.args)}]`);
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
