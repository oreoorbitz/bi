// bi/scripts/seam-picker-pty.mjs — bi#188 acceptance drill: a picker
// modal opens MID-STREAM through the real BI_TUI=go path (bi run +
// BI_LLM_FIXTURE), is answered at the pty, and the host is never
// poisoned. The bi#179 collision class is gone by construction: stdin
// belongs to the Go process — node never opens readline in `bi run`, so
// kitty/DA replies and arrow keys typed at the pty have exactly one
// reader.
//
// Transport: e2e-pty-spawn.py answers kitty query bursts itself (the
// bi#179 drill requirement — mute ptys are insufficient). The drill
// polls the Go child's --debug-log for picker_open, then types
// down+enter at the pty while deltas are still streaming.
//
//   sp-picker-open          picker_open debug event (request crossed).
//   sp-picker-midstream     ≥1 delta event AFTER picker_open — the
//                           stream kept flowing under the open modal.
//   sp-picker-answered      picker_choice with itemId=run-drills (2nd
//                           item: one down + enter at the pty).
//   sp-picker-host-continued turn 3 awaited the answer; "SEAM-PICK-RESULT"
//                           + "run-drills" commit to scrollback; exit 0;
//                           "go-tui session closed (exit 0)".
//   sp-no-poison            no kitty DA reply echoed as text ("64;1;2;4"
//                           is the bi#179 poison signature), no DECSTBM,
//                           no alt-screen, no fallback warn.
//
// Red-check record (bi#57, 2026-09-08, observed live):
//   hunk: cli.ts — drop the `seam.assistantDelta(delta)` forwarding in
//     the onAssistantText branch.
//     Observed: FAIL sp-picker-midstream (0 delta events in the debug
//     log, so none after picker_open); sp-picker-host-continued stayed
//     green — the result markdown commits via turn/result regardless of
//     live deltas. Restored → green.
//   hunk: tui_seam.ts openPicker — `return Promise.resolve("error")`
//     unconditionally (host never sends picker/open).
//     Observed: 4 FAILs — sp-picker-open (no picker_open debug event
//     within 30s), sp-picker-midstream, sp-picker-answered
//     (choice=null), sp-picker-host-continued. Restored → green.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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

const build = spawnSync("go", ["build", "-o", join(TUI_GO_DIR, "bin", "tui"), "."], { cwd: TUI_GO_DIR, encoding: "utf8" });
if (build.status !== 0) {
	console.error(`seam-picker-pty: go build failed:\n${build.stderr}`);
	process.exit(1);
}
const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  seam-picker-pty (no python3+pty on this host)");
	process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-2]/g, "");

const STREAM_B = "# SEAM-PICK-RESULT\n\nThe picker is open RIGHT NOW and these deltas keep flowing underneath the modal layer. ".repeat(14) + "\n";
const fixture = {
	turns: [
		{ toolUse: { name: "bash", args: { command: "echo seam-picker-tool-ok" } } },
		{
			picker: {
				title: "Pick a follow-up",
				items: [
					{ id: "fix-181", label: "Fix bi#181 prompt glyph", description: "restore the `>` at col 2" },
					{ id: "run-drills", label: "Run the pty drill family", description: "split-CSI, paste, SIGWINCH" },
					{ id: "write-docs", label: "Document the seam", description: "protocol draft" },
				],
			},
			// Fired non-blocking, then this text streams — the picker
			// sits open over the live delta stream (a text turn ends the
			// loop; the choice is appended to the committed markdown).
			text: STREAM_B,
		},
	],
};

const home = mkdtempSync(join(tmpdir(), "bi-sp-"));
mkdirSync(join(home, ".bi"), { recursive: true });
writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
writeFileSync(join(home, "fixture.json"), JSON.stringify(fixture));
const dbgPath = join(home, "dbg.ndjson");

const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "0", "90", "node", CLI, "run", "seam picker probe"], {
	env: {
		...process.env, HOME: home, TERM: "xterm-kitty",
		BI_TUI: "go", BI_LLM_FIXTURE: join(home, "fixture.json"), BI_TUI_GO_DEBUG_LOG: dbgPath,
	},
	stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d.toString("utf8"); });
const closed = new Promise((resolve) => child.on("close", resolve));

const readDbg = () => {
	try {
		return readFileSync(dbgPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

// Event-anchored, not wall-clock: wait for the picker to actually open,
// then type down+enter while STREAM_B deltas are still arriving.
let opened = false;
const openDeadline = Date.now() + 30000;
while (Date.now() < openDeadline && !opened) {
	opened = readDbg().some((e) => e.type === "picker_open");
	if (!opened) await sleep(100);
}
if (opened) {
	child.stdin.write("\x1b[B"); // down → 2nd item
	await sleep(300);
	child.stdin.write("\r"); // enter
}

const code = await closed;
child.stdin.end();
const dbg = readDbg();
const plain = stripAnsi(out);

const openIdx = dbg.findIndex((e) => e.type === "picker_open");
check("sp-picker-open picker request crossed the seam", openIdx >= 0);
check("sp-picker-midstream deltas kept flowing under the modal",
	openIdx >= 0 && dbg.slice(openIdx + 1).some((e) => e.type === "delta"));
const choice = dbg.find((e) => e.type === "picker_choice");
check("sp-picker-answered down+enter chose run-drills", choice?.itemId === "run-drills",
	`choice=${JSON.stringify(choice ?? null)}`);
check("sp-picker-host-continued answer reached the host, run completed",
	code === 0
	&& plain.includes("SEAM-PICK-RESULT")
	&& plain.includes("follow-up chosen: run-drills")
	&& plain.includes("go-tui session closed (exit 0)"),
	`code=${code}`);
check("sp-no-poison no kitty-reply echo, no DECSTBM/alt-screen, no fallback warn",
	!plain.includes("64;1;2;4")
	&& !/\x1b\[[0-9]*;[0-9]*r/.test(out)
	&& !out.includes("\x1b[?1049h")
	&& !plain.includes("falling back to pi-tui"));

if (failures > 0) {
	console.error(`seam-picker-pty drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("seam-picker-pty drill: green");
