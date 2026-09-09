// bi/scripts/picker-restore.mjs — post-picker footer restore drill (bi#202).
//
// After EVERY picker resolves (pick, Esc, or fallthrough) the footer
// editor must be restored + repainted, and selections implying a next
// action print a one-line hint. Probed mechanism: every suspend site
// resumes in `finally` and the REPL loop-head repaints the editor, so
// tree/model/session restore uniformly — this drill pins that per
// picker (byte-order: the last `bi> ` border paint follows the
// resolution marker), plus the bi#202 dir-browse hint. The session
// path is pinned shape-stable (already correct — must stay identical).
//
// Controlled cwds keep rows deterministic (single file / single dir).
// ARM=<name> runs one arm (iteration); default runs all.
//
//   pr-tree-file    file pick => `/attach <n>` hint + editor repaint
//   pr-tree-dir     dir pick => `browsed <dir>` hint + new listing,
//                   Esc => static list + editor repaint
//   pr-tree-esc     Esc from the first picker => list + editor repaint
//   pr-model-pick   screen pick => `backend now` + editor repaint
//   pr-model-esc    Esc => static list, no switch, + editor repaint
//   pr-session-pick resume pick => `resumed …` shape + editor repaint
//   pr-nocolor      tree-file under NO_COLOR: same order, escape-free
//
// Red-check record (bi#57), executed <date>:
//   hunk: cli.ts tree pick branch — drop the `browsed …` hint line.
//   expected: pr-tree-dir FAIL (no browsed hint); restore arms stay
//     green (the hint is additive, the editor path untouched).
//   observed: <observed>
//   restore: hunk restored → green.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const ONLY = process.env.ARM ?? "all";

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

function seedHome({ sessions = [] } = {}) {
	const home = mkdtempSync(join(tmpdir(), "bi-pr-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	const work = realpathSync(mkdtempSync(join(tmpdir(), "bi-prw-")));
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [work]: "allow" }) + "\n");
	for (const s of sessions) {
		const header = JSON.stringify({ id: s.id, timestamp: "2026-09-07T00:00:00.000Z", cwd: work, parent_session: null, label: null });
		const tail = s.turns > 0 ? "\n" + JSON.stringify({ type: "history", role: "user", text: "hi", provider: "anthropic", model: "claude-haiku-4-5", thinking: null }) : "";
		writeFileSync(join(home, ".bi", "sessions", `${s.id}.jsonl`), header + tail + "\n");
	}
	return { home, work };
}

function runBoot(home, work, beats, extraEnv = {}) {
	const rawPath = join(tmpdir(), `bi-pr-raw-${process.pid}-${Math.floor(Math.random() * 1e6)}.log`);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), "40", "160", home, CLI], {
		env: {
			...process.env, HOME: home, TERM: "xterm-kitty",
			PC_TIMEOUT: "100", PC_BEATS: beats, PROBE_RAW: rawPath, ...extraEnv,
		},
		cwd: work,
		encoding: "utf8",
		timeout: 170000,
	});
	let raw = "";
	try {
		raw = readFileSync(rawPath, "utf8");
	} catch {}
	return { run, raw };
}

const lastIdx = (raw, m) => raw.lastIndexOf(m);
const exited = (run) => (run.stdout ?? "").includes("code=0");
// The editor repaint proof: a `bi> ` border paint AFTER the marker.
const repaintedAfter = (raw, marker) => raw.includes("bi> ") && lastIdx(raw, "bi> ") > lastIdx(raw, marker);

function arm(name, fn) {
	if (ONLY !== "all" && ONLY !== name) {
		console.log(`skip ${name} (ARM=${ONLY})`);
		return;
	}
	fn();
}

if (hasPty) {
	arm("pr-tree-file", () => {
		const { home, work } = seedHome();
		writeFileSync(join(work, "note.txt"), "hello\n");
		const { run, raw } = runBoot(home, work, "@bi>+3:/tree\\r,@Enter opens+5:\\r,@stages it+5:/quit\\r,@session kept+5:/quit\\r");
		check("pr-tree-file /attach hint", raw.includes("stages it"), "no file hint");
		check("pr-tree-file editor repainted after", repaintedAfter(raw, "stages it"), "no post-pick editor paint");
		check("pr-tree-file clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-tree-dir", () => {
		const { home, work } = seedHome();
		mkdirSync(join(work, "sub"));
		writeFileSync(join(work, "sub", "deep.txt"), "deep\n");
		const { run, raw } = runBoot(
			home, work,
			"@bi>+3:/tree\\r,@Enter opens+5:\\r,@deep.txt+5:\\x1b,@deep.txt+20:/quit\\r,@deep.txt+35:/quit\\r",
		);
		check("pr-tree-dir browsed hint", raw.includes(`browsed ${join(work, "sub")} — pick a file number or /attach <n>`), "no browsed hint");
		check("pr-tree-dir new listing opened", (raw.match(/Browse \(Enter opens/g) ?? []).length >= 2, "no second picker");
		check("pr-tree-dir editor repainted after Esc", repaintedAfter(raw, "deep.txt"), "no post-Esc editor paint");
		check("pr-tree-dir clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-tree-esc", () => {
		const { home, work } = seedHome();
		writeFileSync(join(work, "note.txt"), "hello\n");
		const { run, raw } = runBoot(home, work, "@bi>+3:/tree\\r,@Enter opens+5:\\x1b,@Enter opens+20:/quit\\r,@Enter opens+35:/quit\\r");
		check("pr-tree-esc no pick taken", !raw.includes("stages it") && !raw.includes("browsed "), "unexpected pick");
		check("pr-tree-esc editor repainted after", (raw.match(/bi> /g) ?? []).length >= 2, "editor never repainted");
		check("pr-tree-esc clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-model-pick", () => {
		const { home, work } = seedHome();
		writeFileSync(join(work, "note.txt"), "hello\n");
		const { run, raw } = runBoot(home, work, "@bi>+3:/model\\r,@Select model+8:\\r,@backend now+5:/quit\\r,@session kept+5:/quit\\r");
		check("pr-model-pick switch lands", raw.includes("backend now"), "no backend-now line");
		check("pr-model-pick editor repainted after", repaintedAfter(raw, "backend now"), "no post-pick editor paint");
		check("pr-model-pick clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-model-esc", () => {
		const { home, work } = seedHome();
		writeFileSync(join(work, "note.txt"), "hello\n");
		const { run, raw } = runBoot(home, work, "@bi>+3:/model\\r,@Select model+8:\\x1b,@Select model+25:/quit\\r,@Select model+40:/quit\\r");
		check("pr-model-esc no switch on Esc", !raw.includes("backend now"), "unexpected switch");
		check("pr-model-esc editor repainted after", (raw.match(/bi> /g) ?? []).length >= 2, "editor never repainted");
		check("pr-model-esc clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-session-pick", () => {
		const { home, work } = seedHome({ sessions: [{ id: "a1b2c3d4", turns: 0 }, { id: "e5f6a7b8", turns: 1 }] });
		const { run, raw } = runBoot(
			home, work,
			"@Start (Enter+3:\\r,@bi>+3:/resume\\r,@Resume session+5:\\r,@resumed+5:/quit\\r,@session kept+5:/quit\\r",
		);
		check("pr-session-pick resumed shape", /resumed [0-9a-f]+ \([0-9]+ messages\)/.test(raw), "no resumed line");
		check("pr-session-pick editor repainted after", repaintedAfter(raw, "resumed "), "no post-pick editor paint");
		check("pr-session-pick clean exit", exited(run), `status=${run.status}`);
	});

	arm("pr-nocolor", () => {
		const { home, work } = seedHome();
		writeFileSync(join(work, "note.txt"), "hello\n");
		const { run, raw } = runBoot(
			home, work,
			"@bi>+3:/tree\\r,@Enter opens+5:\\r,@stages it+5:/quit\\r,@session kept+5:/quit\\r",
			{ NO_COLOR: "1" },
		);
		check("pr-nocolor hint present", raw.includes("stages it"), "no file hint under NO_COLOR");
		check("pr-nocolor editor repainted after", repaintedAfter(raw, "stages it"), "no post-pick editor paint");
		check("pr-nocolor escape-free restore", !raw.includes("\x1b[38;2;") && !raw.includes("\x1b[39m"), "color SGR leaked");
		check("pr-nocolor clean exit", exited(run), `status=${run.status}`);
	});
} else {
	console.log("SKIP  pty half (no python3+pty on this host)");
}

if (failures > 0) {
	console.error(`picker-restore drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("picker-restore drill: green");
