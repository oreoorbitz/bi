// bi/scripts/prompt-label.mjs — footer prompt label drill (bi#201).
//
// format_prompt_label returns plain `bi>` at every turn count (the
// `[N]` odometer is gone; turns already read in the status line).
// BI_SCREEN=0 keeps the run modal-free (line reader, no pickers) so
// beats stay absolute: the label SHAPING is what's pinned here — the
// modal transport is covered by paint-chain pc-dock + modal-chain.
//
//   pl-turn0      header-only session: `bi> ` paints, no `bi[N]>`
//   pl-turn1      after `/resume 1` (turn=1 proven by the resumed line):
//                still `bi> `, no `bi[1]>`
//   pl-nocolor    turn-1 run under NO_COLOR: label identical, no counter
//
// Red-check record (bi#57), executed <date>:
//   hunk: tui.baml format_prompt_label — back to `bi[${turn}]>`.
//   expected: baml test label pins FAIL + pl-turn0/pl-turn1 FAIL
//     (counter pattern in the stream).
//   observed: <observed>
//   restore: hunk restored → green.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

function seedHome(withTurn) {
	const home = mkdtempSync(join(tmpdir(), "bi-pl-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Pre-trust the drill cwd so no trust question consumes a beat.
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [process.cwd()]: "allow" }) + "\n");
	const header = JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null });
	const userTurn = JSON.stringify({ type: "history", role: "user", text: "hello", provider: "anthropic", model: "claude-haiku-4-5", thinking: null });
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		header + "\n" + (withTurn ? userTurn + "\n" : ""),
	);
	return home;
}

const COUNTER = /bi\[\d+\]>/;

function runBoot(home, beats, extraEnv = {}) {
	const rawPath = join(tmpdir(), `bi-pl-raw-${process.pid}-${Math.floor(Math.random() * 1e6)}.log`);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), "40", "160", home, CLI], {
		env: {
			...process.env,
			HOME: home,
			TERM: "xterm-kitty",
			PC_TIMEOUT: "45",
			BI_SCREEN: "0",
			PC_BEATS: beats,
			PROBE_RAW: rawPath,
			...extraEnv,
		},
		encoding: "utf8",
		timeout: 120000,
	});
	let raw = "";
	try {
		raw = readFileSync(rawPath, "utf8");
	} catch {}
	return { run, raw };
}

if (hasPty) {
	// Turn 0: header-only session, straight to /quit.
	{
		const { run, raw } = runBoot(seedHome(false), "6:/quit\\r,16:/quit\\r");
		check("pl-turn0 clean exit", (run.stdout ?? "").includes("code=0"), `status=${run.status}`);
		check("pl-turn0 footer label reads bi>", raw.includes("bi> "), "no `bi> ` in stream");
		check("pl-turn0 no turn counter", !COUNTER.test(raw), "counter pattern in stream");
	}
	// Turn 1: /resume adopts the seeded user turn by id (numbers would
	// hit the fresh-minted boot session), label stays bare.
	{
		const { run, raw } = runBoot(seedHome(true), "6:/resume a1b2c3d4\\r,16:/quit\\r,26:/quit\\r");
		check("pl-turn1 turn advanced", raw.includes("resumed a1b2c3d4"), "no resumed line — turn never reached 1");
		check("pl-turn1 footer label still bi>", raw.includes("bi> "), "no `bi> ` in stream");
		check("pl-turn1 no bi[1]>", !COUNTER.test(raw), "counter pattern in stream");
		check("pl-turn1 clean exit", (run.stdout ?? "").includes("code=0"), `status=${run.status}`);
	}
	// NO_COLOR: same turn-1 run, label byte-identical in shape.
	{
		const { raw } = runBoot(seedHome(true), "6:/resume a1b2c3d4\\r,16:/quit\\r,26:/quit\\r", { NO_COLOR: "1" });
		check("pl-nocolor footer label still bi>", raw.includes("bi> "), "no `bi> ` under NO_COLOR");
		check("pl-nocolor no counter", !COUNTER.test(raw), "counter pattern under NO_COLOR");
	}
} else {
	console.log("SKIP  pty half (no python3+pty on this host)");
}

if (failures > 0) {
	console.error(`prompt-label drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("prompt-label drill: green");
