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
import { getBiSessionsDir, createSessionFile, listSessions, findMostRecentSession, validateSessionIdOrThrow } from "./session.js";
import { HostTui, renderReadyScreen } from "./tui.js";
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

// Slash dispatch (bi#12): /builtin + /skill-name in the interactive prompt.
// Skill slashes expand the SKILL.md body into the prompt (pi runs skill
// content as the prompt); builtins execute directly. Returns true when the
// line was a slash command (handled), false for ordinary prompts.
async function handleSlash(line: string, skills: Skill[]): Promise<boolean> {
	// Decision (BAML-backed) lives in skills.ts; this keeps only effects.
	const t = await resolveSlash(line, skills);
	if (t.kind === "none") return false;
	if (t.kind === "unknown") {
		console.error(`unknown slash /${t.word} — /help lists commands`);
		return true;
	}
	if (t.kind === "builtin") {
		if (t.name === "quit") process.exit(0);
		if (t.name === "help") {
			const builtins = await builtin_slash_commands_async();
			console.log("slash commands:");
			for (const b of builtins) console.log(`  /${b.name} — ${b.description}`);
			for (const s of skills) console.log(`  /${s.name} — ${s.description} (skill)`);
			return true;
		}
		if (t.name === "reload") {
			const fresh = await loadSkills();
			console.error(`[bi] reloaded ${fresh.skills.length} skill(s)`);
			return true;
		}
		if (t.name === "compact") {
			console.error("[bi] nothing to compact — the interactive prompt is single-shot (history lives inside one runBiLoop call)");
			return true;
		}
		return true;
	}
	await runOnePrompt(`${skillBody(t.skill)}\n\n${t.args}`.trim());
	return true;
}

async function runOnePrompt(q: string, skills: Skill[] = []): Promise<void> {
	if (await handleSlash(q, skills)) return;
	const sessFile = createSessionFile({ cwd: process.cwd() });
	console.error(`[bi] new session ${sessFile}`);
	const skillsSection = skills.length ? `\n\n${await formatSkills(skills)}` : "";
	const fullPrompt = q + skillsSection + `\n\n[BAIS ready]\n${(await readyBaisIssues()).map((f) => `- ${f.issue.id} ${f.issue.title}`).join("\n")}`;
	// BAML loop validation — runBiLoop wraps runAgent with LoopContext (agent_loop.baml).
	// Same first-class tools as `bi run` so the interactive agent manages .bais too.
	let loopTools: any[] = [];
	try {
		loopTools = await listTools();
	} catch {}
	const result = await runBiLoop(fullPrompt, { provider: "anthropic", model: "claude-haiku-4-5", maxTurns: 5, onEvent: (e) => console.error(`[loop] ${e}`), tools: loopTools, toolHandler: async (name, args) => handleTool(name, args) });
	if (result.failure) console.error(`TurnFailure ${result.failure.message}`);
	else for (const m of result.messages) if ((m as any).role === "assistant") console.log((m as any).text ?? JSON.stringify((m as any).content));
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
		// interactive skeleton: if tty, prompt once via BAML LoopState (full TUI lands next)
		if (process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, "--print") && !hasFlag(args, "-p")) {
			const rl = await import("node:readline");
			const r = rl.createInterface({ input: process.stdin, output: process.stdout });
			const q = await new Promise<string>((res) => r.question("bi> ", res));
			r.close();
			if (q.trim()) {
				const { skills, diagnostics } = await loadSkills().catch(() => ({ skills: [], diagnostics: [] }));
				for (const d of diagnostics) console.error(`[skills] ${d.file}: ${d.message}`);
				await runOnePrompt(q.trim(), skills);
			}
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
			tools: runTools,
			toolHandler: async (name, args) => handleTool(name, args),
		});

		if (result.failure) {
			console.error(`TurnFailure: kind=${result.failure.kind} retry_safe=${result.failure.retry_safe} message=${result.failure.message}`);
			process.exit(1);
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
