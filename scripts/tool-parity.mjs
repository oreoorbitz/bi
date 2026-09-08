// bi/scripts/tool-parity.mjs — bi#152 advertise/execute parity gate.
//
// A user hit 'unknown tool bash' because ListTools advertised tools with no
// host executor — a runtime lie the model cannot detect. BAML side pins the
// delisting (tools_test: delisted stay delisted); this script mirrors it
// host-side: every name in BAML ListTools() must have a handleTool branch in
// bi/src/tools.ts (switch `case "x"` or `if (name === "x")` guard), and every
// handleTool branch must name a listed tool — in either direction the gate
// fails loud naming the drifted tool.
//
// Sources (ground-first: both observed, not assumed):
//   advertised = ListTools_async() from bi/dist/baml_sdk (compiled BAML, not
//     the .baml source — a stale dist fails the same way CI would, loudly).
//   executors  = case/name=== labels parsed from bi/src/tools.ts.
// Test-only flags (red-check + fixtures, never used by the committed hook):
//   --tools-ts PATH   parse a scratch tools.ts copy instead of the real one.
//   --inject-spec NAME  pretend ListTools also advertises NAME.
//
// Red-check record (bi#57, 2026-09-06, all observed live; scratch copies
// in /tmp only, never committed):
//   $ node bi/scripts/tool-parity.mjs
//     => tool-parity: all green (10 advertised == 10 executed), exit 0
//   $ node bi/scripts/tool-parity.mjs --inject-spec phantom_tool
//     => FAIL advertised-without-executor: phantom_tool — ListTools
//        advertises it but handleTool has no branch (...), exit 1
//     (Also caught a real script bug first try: space-separated flag value
//     was ignored and the gate stayed green — fixed flag() to consume the
//     next argv element; re-ran red to confirm.)
//   $ python3 -c "<insert phantom case into /tmp/tools-phantom.ts copy>"
//     $ node bi/scripts/tool-parity.mjs --tools-ts /tmp/tools-phantom.ts
//     => FAIL executed-without-spec: phantom_case — handleTool executes it
//        but ListTools does not advertise it (...), exit 1
//   $ printf 'if (name === "phantom_guard")...' >> /tmp/tools-phantom.ts
//     => FAIL executed-without-spec: phantom_case + phantom_guard, exit 1
//     (proves the name=== guard shape is parsed, not just switch cases)
// A passing gate that cannot go red is camouflage, not coverage — the two
// FAIL lines above are the proof this one can.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url)); // bi/scripts
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
	if (i < 0) return undefined;
	if (args[i].includes("=")) return args[i].slice(name.length + 1);
	return args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : "";
};
const toolsTsPath = flag("--tools-ts") || join(ROOT, "..", "src", "tools.ts");
const injectedSpec = flag("--inject-spec"); // undefined = no injection

// (1) Advertised: the compiled BAML registry, the exact set the LLM sees.
const { ListTools_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const advertised = new Set((await ListTools_async()).map((t) => t.name));
if (injectedSpec) advertised.add(injectedSpec);

// (2) Executors: every handleTool branch — switch cases plus the
// report_* early-return `if (name === "...")` guards above the switch.
// (Both patterns verified unique to handleTool in tools.ts: 8 cases + 2
// guards. A new dispatch shape must extend these regexes, not silently
// pass — an unparsed branch shows up as executed-without-spec... no:
// worse, it shows up as nothing. Keep the patterns in sync with tools.ts.)
const src = readFileSync(resolve(toolsTsPath), "utf8");
const executors = new Set();
for (const m of src.matchAll(/case\s+"([^"]+)"\s*:/g)) executors.add(m[1]);
for (const m of src.matchAll(/name\s*===\s*"([^"]+)"/g)) executors.add(m[1]);

// (3) Bidirectional diff — either side landing without the other is the bug.
let failures = 0;
for (const name of [...advertised].sort()) {
	if (!executors.has(name)) {
		failures++;
		console.error(`FAIL advertised-without-executor: ${name} — ListTools advertises it but handleTool has no branch (model would hit 'unknown tool ${name}')`);
	}
}
for (const name of [...executors].sort()) {
	if (!advertised.has(name)) {
		failures++;
		console.error(`FAIL executed-without-spec: ${name} — handleTool executes it but ListTools does not advertise it (dead or hidden executor)`);
	}
}

if (failures) {
	console.error(`tool-parity: ${failures} drifted tool(s) — land both sides together (bi/baml_src/tools.baml ListTools + bi/src/tools.ts handleTool)`);
	process.exit(1);
}
console.log(`tool-parity: all green (${advertised.size} advertised == ${executors.size} executed)`);
