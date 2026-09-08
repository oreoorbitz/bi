// bi/scripts/seam-run-pty.mjs — bi#188 acceptance drill: BI_TUI=go bi run
// renders a scripted turn end-to-end through the Go shell, and every
// failure mode falls back to pi-tui with a NAMED warn (bi#55), never a
// silent swap.
//
// No API key on this host, so the turn is scripted through BI_LLM_FIXTURE
// (the issue's "scripted prompt fixtures" allowance): one real tool call
// (bash echo) + one long streamed text turn. The Go child runs on a
// kitty-replying pty (e2e-pty-spawn.py, the modal-chain.mjs transport) —
// mute ptys never exercised the bi#179 collision class.
//
//   sr-fallback-notty     BI_TUI=go with piped stdout → named "ignored"
//                         warn + host output unchanged.
//   sr-fallback-nobin     bad BI_TUI_GO_BIN on a pty → named "did not
//                         start" warn + pi-tui renders the result.
//   sr-fallback-crash     wrapper dies mid-turn → named onDead warn +
//                         the host dump completes the run.
//   sr-seam-e2e           debug log: spinner_start/stop, ≥5 deltas with
//                         strictly increasing totals, tool_line start +
//                         done(ok), footer with turn/messages/branch,
//                         commit, seam_eof, clean exit 0.
//   sr-seam-scrollback    committed turn heading + tool output text in
//                         the pty stream; no DECSTBM, no alt-screen.
//   sr-seam-cleanexit     exit 0, "go-tui session closed (exit 0)" on the
//                         host, NO fallback warn anywhere.
//
// Red-check record (bi#57, 2026-09-08, observed live):
//   hunk: cli.ts — remove the `console.error("[bi] BI_TUI=go requested
//     but the Go shell did not start ...")` warn line.
//     Observed: FAIL sr-fallback-nobin (named warn missing; exit still 0,
//     the silent-swap signature), sr-fallback-* others green. Restored →
//     green.
//   hunk: tui_seam.ts start() — drop the onDead option pass-through so a
//     mid-turn crash never warns.
//     Observed: FAIL sr-fallback-crash (no "falling back to pi-tui
//     output" warn; run completes silently on the host path). Restored →
//     green.
//   hunk: cli.ts — drop the `seam.assistantDelta(delta)` forwarding.
//     Observed: FAIL sr-seam-e2e (deltas=0 in the debug log);
//     sr-seam-scrollback stayed green — the full markdown commits via
//     turn/result regardless of live deltas (the commit path is not the
//     streaming path). Restored → green.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const TUI_GO_DIR = join(HERE, "..", "tui-go");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// Pre-build the Go binary (resolveTuiGoBinary would auto-build, but a
// named build failure here is clearer than a fallback cascade below).
const build = spawnSync("go", ["build", "-o", join(TUI_GO_DIR, "bin", "tui"), "."], { cwd: TUI_GO_DIR, encoding: "utf8" });
if (build.status !== 0) {
	console.error(`seam-run-pty: go build failed:\n${build.stderr}`);
	process.exit(1);
}

const LONG_TEXT = "Streaming deltas across the seam while the Go shell owns every terminal byte. ".repeat(12);
const fixture = (turns, path) => writeFileSync(path, JSON.stringify({ turns }));

const makeSandbox = () => {
	const home = mkdtempSync(join(tmpdir(), "bi-sr-"));
	mkdirSync(join(home, ".bi"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	return home;
};

const FX_TURNS = [
	{ toolUse: { name: "bash", args: { command: "echo seam-fixture-tool-ok" } } },
	{ text: `# SEAM-E2E-HEADING\n\n${LONG_TEXT}\n\n- tool line crossed\n- footer framed\n` },
];

function runPlain(env, timeoutMs = 60000) {
	return new Promise((resolve) => {
		const home = makeSandbox();
		const fxPath = join(home, "fixture.json");
		fixture(FX_TURNS, fxPath);
		const child = spawn("node", [CLI, "run", "seam fallback probe"], {
			env: { ...process.env, HOME: home, BI_LLM_FIXTURE: fxPath, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d.toString("utf8"); });
		child.stderr.on("data", (d) => { err += d.toString("utf8"); });
		const t = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
		child.on("close", (code) => { clearTimeout(t); resolve({ out, err, code }); });
	});
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
function runPty(env, { timeoutS = 80, dbgName = "dbg.ndjson" } = {}) {
	return new Promise((resolve) => {
		const home = makeSandbox();
		const fxPath = join(home, "fixture.json");
		fixture(FX_TURNS, fxPath);
		const dbgPath = join(home, dbgName);
		const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "0", String(timeoutS), "node", CLI, "run", "seam pty probe"], {
			env: {
				...process.env, HOME: home, TERM: "xterm-kitty",
				BI_LLM_FIXTURE: fxPath, BI_TUI_GO_DEBUG_LOG: dbgPath,
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.end(); // host input is never needed; close it named
		let out = "";
		child.stdout.on("data", (d) => { out += d.toString("utf8"); });
		child.on("close", (code) => {
			let dbg = [];
			try {
				dbg = readFileSync(dbgPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
			} catch {}
			resolve({ out, code, dbg });
		});
	});
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-2]/g, "");

// --- sr-fallback-notty (no pty needed) ---
{
	const { out, err, code } = await runPlain({ BI_TUI: "go" });
	check("sr-fallback-notty named warn + host output", code === 0
		&& err.includes("BI_TUI=go ignored — stdout is not a TTY")
		&& out.includes("SEAM-E2E-HEADING"), `code=${code}`);
}

if (!hasPty) {
	console.log("SKIP  pty halves (no python3+pty on this host)");
} else {
	// --- sr-fallback-nobin ---
	{
		const { out, code } = await runPty({ BI_TUI: "go", BI_TUI_GO_BIN: "/nonexistent/bi188-no-such-bin" });
		const plain = stripAnsi(out);
		check("sr-fallback-nobin named warn + pi-tui renders", code === 0
			&& plain.includes("did not start")
			&& plain.includes("falling back to pi-tui")
			&& plain.includes("SEAM-E2E-HEADING"), `code=${code}`);
	}

	// --- sr-fallback-crash (wrapper dies on the FIRST seam byte: a
	// deterministic mid-session crash — the turn's tool lines and deltas
	// then hit a dead child) ---
	{
		const home = makeSandbox();
		const wrapper = join(home, "crash-wrapper.sh");
		writeFileSync(wrapper, "#!/bin/sh\nread line <&3\nexit 1\n");
		chmodSync(wrapper, 0o755);
		const { out, code } = await runPty({ BI_TUI: "go", BI_TUI_GO_BIN: wrapper });
		const plain = stripAnsi(out);
		check("sr-fallback-crash named onDead warn + host dump completes", code === 0
			&& plain.includes("falling back to pi-tui output")
			&& plain.includes("SEAM-E2E-HEADING"), `code=${code}`);
	}

	// --- sr-seam-e2e + scrollback + clean exit ---
	{
		const { out, code, dbg } = await runPty({ BI_TUI: "go" });
		const plain = stripAnsi(out);
		const kinds = (t) => dbg.filter((e) => e.type === t);
		const deltas = kinds("delta");
		const totals = deltas.map((d) => d.total);
		const increasing = totals.length >= 5 && totals.every((t, i) => i === 0 || t > totals[i - 1]);
		const footerFinal = kinds("footer").find((e) => e.turn >= 1 && e.messages >= 1 && typeof e.branch === "string");
		check("sr-seam-e2e six channels on the debug log",
			kinds("agent_event").some((e) => e.kind === "spinner_start")
			&& kinds("agent_event").some((e) => e.kind === "spinner_stop")
			&& increasing
			&& kinds("tool_line").some((e) => e.kind === "start" && e.name === "bash")
			&& kinds("tool_line").some((e) => e.kind === "done" && e.ok === true)
			&& footerFinal !== undefined
			&& kinds("commit").length >= 1
			&& kinds("seam_eof").length === 1,
			`deltas=${totals.length} footerFinal=${JSON.stringify(footerFinal ?? null)}`);
		check("sr-seam-scrollback committed result + tool line, no DECSTBM/alt-screen",
			plain.includes("SEAM-E2E-HEADING")
			&& plain.includes("seam-fixture-tool-ok")
			&& !/\x1b\[[0-9]*;[0-9]*r/.test(out)
			&& !out.includes("\x1b[?1049h"));
		check("sr-seam-cleanexit exit 0, closed named, no fallback warn",
			code === 0
			&& plain.includes("go-tui session closed (exit 0)")
			&& !plain.includes("falling back to pi-tui"),
			`code=${code}`);
	}
}

if (failures > 0) {
	console.error(`seam-run-pty drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("seam-run-pty drill: green");
