// bi/scripts/tool-refusal.mjs — expected tool errors read as sentences,
// unexpected ones keep their stacks (bi#220).
//
// The turn-failure site (main().catch) printed every throw with its
// stack: a bash-allowlist refusal — user-facing by construction —
// dumped dist internals. Refusals + arg validation now carry the
// ToolRefusalError marker from their construction sites (bi/src/
// tools.ts); the print site classifies by instanceof, never by
// string-matching the message.
//
//   refusal     e2e `bi run` with a canned bash/curl toolUse: exit 1,
//               `refusing to run` present, zero `at ` frames.
//   unexpected  e2e canned unknown-tool use: exit 1, stack present.
//   marked      unmarked Error with refusal-identical text is NOT a
//               refusal (no string matching); the marker preserves
//               the message byte-for-byte.
//
// Red-check (bi#57), 2026-09-09 (muse, bi#220): main().catch branch
// neutered to always print `e` — refusal arm FAILs naming the `at `
// frames; restored → green.
let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const { ToolRefusalError } = await import(join(HERE, "..", "dist", "src", "tools.js"));

const AT = /^\s*at\s/m;

function makeSandbox() {
	const home = mkdtempSync(join(tmpdir(), "bi-ref-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	return home;
}

function runTurn(fixtureTurns) {
	const home = makeSandbox();
	const fx = join(home, "fixture.json");
	writeFileSync(fx, JSON.stringify({ turns: fixtureTurns }) + "\n");
	const env = { ...process.env, HOME: home, TERM: "dumb", BI_LLM_FIXTURE: fx };
	delete env.BI_TUI_DEBUG;
	const run = spawnSync("node", [CLI, "run", "do the thing"], { env, encoding: "utf8", timeout: 90000, cwd: home });
	return (run.stdout ?? "") + (run.stderr ?? "") + `\n[exit ${run.status}]`;
}

// Refused bash command: sentence, no frames, exit 1.
{
	const out = runTurn([{ toolUse: { name: "bash", args: { command: "curl https://evil.example/x" } } }]);
	check("refusal exit 1", out.includes("[exit 1]"), "turn did not fail as before");
	check("refusal names the sentence", out.includes("refusing to run"), "refusal text lost");
	check("refusal zero at-frames", !AT.test(out), "stack leaked");
	check("refusal zero dist frames", !out.includes("dist/"), "internals leaked");
}

// Unknown tool: still a full stack (unexpected path unchanged).
{
	const out = runTurn([{ toolUse: { name: "frobnicate", args: {} } }]);
	check("unexpected exit 1", out.includes("[exit 1]"));
	check("unexpected names the error", out.includes("unknown tool"), "error text lost");
	check("unexpected keeps its stack", AT.test(out), "stack missing on a real bug");
}

// Classification is the marker, not the message.
{
	const twin = new Error('refusing to run "curl x": command not on the bash allowlist (a, b) — run an allowlisted command instead');
	check("marked identical text unmarked", !(twin instanceof ToolRefusalError), "string matching at the print site");
	const marked = new ToolRefusalError("some sentence");
	check("marker preserves message", marked.message === "some sentence");
	check("marker is an Error", marked instanceof Error);
}

if (failures) process.exit(1);
console.log("tool-refusal: all green");
