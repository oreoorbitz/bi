#!/usr/bin/env node
// bi CLI — minimal pi fork entry point (Orion's first name is Orion, CLI is `bi`).
// Commands mirror pi's provider/model surface that bi actually ports:
//   bi list-providers | list-models [--provider id] | get-model <id> | run <prompt>
// No external deps — uses bi's own provider/models/agent BAML port.

import { getModel, listAllModels, listModels } from "./models.js";
import { getProvider, listProviders } from "./provider.js";
import { runAgent } from "./agent.js";

function printHelp(): void {
	console.log(`bi — BAML port of pi (Orion's fork)

Usage:
  bi list-providers
  bi list-models [--provider <id>]
  bi get-model <id>
  bi run <prompt> [--provider <id>] [--model <id>] [--api-key <key>] [--base-url <url>] [--temperature <n>] [--max-turns <n>]

Options:
  --provider <id>     Provider id (anthropic, openai, google) [default: anthropic]
  --model <id>        Model id (e.g. claude-haiku-4-5) [default: claude-haiku-4-5]
  --api-key <key>     API key (or set ANTHROPIC_API_KEY etc. — not yet wired)
  --base-url <url>    Override base URL (useful for closed-port tests)
  --temperature <n>   Sampling temperature
  --max-turns <n>     Agent loop cap [default: 5]
  --help, -h          Show this help
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const cmd = args[0];

	if (!cmd || hasFlag(args, "--help") || hasFlag(args, "-h")) {
		printHelp();
		process.exit(cmd ? 0 : 1);
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

		console.error(`bi run — provider=${provider} model=${model} prompt="${prompt}"`);
		const result = await runAgent(prompt, {
			provider,
			model,
			apiKey,
			baseUrl,
			temperature,
			maxTurns,
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

	console.error(`Unknown command: ${cmd}`);
	printHelp();
	process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
