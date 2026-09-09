// bi/scripts/ready-chrome.mjs — ready-frame chrome drill (bi#199, extended bi#200).
//
// BAML shapes the ready frame plain (tui.baml render_ready_frame); the
// host wraps named segments in primary at paint time (cli.ts
// colorReadyRow bi#199, colorReadyHeader bi#200) — the bi#193-pinned
// mechanism, no SGR in BAML literals.
//
//   rc-id-primary    pty: first ready row's id rides primary, the
//                    double-space separator + title stay text
//   rc-title-plain   pty: the row's title is not primary-wrapped
//   rc-header-*      (bi#200) header `bi` wordmark arms, see below
//   rc-nocolor-*     pty under NO_COLOR: rows present, zero color SGR
//   rc-pipe-identical piped stdout byte-identical across
//                    default/NO_COLOR/BI_THEME=none (TTY gate proof)
//
// Red-check record (bi#57), executed <date>:
//   hunk: cli.ts colorReadyRow — return the line unwrapped.
//   expected: rc-id-primary FAIL (no primary SGR before the id).
//   observed: <observed>
//   restore: hunk restored → drill green.
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
const stripAnsi = (s) =>
	s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-2]/g, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\x1b/g, "\\x1b");

function freshHome() {
	const home = mkdtempSync(join(tmpdir(), "bi-rc-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	return home;
}

const tf = await import(join(HERE, "..", "dist", "src", "theme-files.js"));
const PRIMARY = tf.chromeAnsi("primary", {});
const RESET = "\x1b[39m";

if (hasPty) {
	const home = freshHome();
	const rawPath = join(tmpdir(), `bi-rc-raw-${process.pid}.log`);
	const colorEnv = { ...process.env, HOME: home, TERM: "xterm-kitty", PC_TIMEOUT: "70", PC_DUMP_GRID: "1", PROBE_RAW: rawPath };
	delete colorEnv.NO_COLOR;
	delete colorEnv.BI_THEME;
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), process.env.PC_ROWS ?? "60", process.env.PC_COLS ?? "160", home, CLI], {
		env: colorEnv,
		encoding: "utf8",
		timeout: 120000,
	});
	const raw = readFileSync(rawPath, "utf8");
	const plain = stripAnsi(raw);
	const rowMatch = plain.match(/^(\S+)  (.+)$/m);
	check("rc-boot ready rows visible", rowMatch !== null, rowMatch?.[0]?.slice(0, 50) ?? "no ready row");
	if (rowMatch) {
		const [, id, title] = rowMatch;
		check(
			"rc-id-primary id column rides primary",
			raw.includes(`${PRIMARY}${id}${RESET}  `),
			`no primary wrap around ${id}`,
		);
		check(
			"rc-title-plain title stays text",
			!new RegExp(`${esc(PRIMARY)}${esc(title.slice(0, 20))}`).test(raw),
			`title wrapped in primary`,
		);
	}
	// bi#200: header wordmark — `bi` pops primary, rest stays text.
	check(
		"rc-header-wordmark bi pops primary",
		raw.includes(`${PRIMARY}bi${RESET} — ready BAIS`),
		"no primary wrap around the header wordmark",
	);
	check(
		"rc-header-rest rest stays text",
		!new RegExp(`${esc(PRIMARY)}[^\\x1b]*ready BAIS`).test(raw),
		"header rest wrapped in primary",
	);

	// Escape-free arm: same boot under NO_COLOR carries no color SGR.
	const home2 = freshHome();
	const rawPath2 = join(tmpdir(), `bi-rcn-raw-${process.pid}.log`);
	spawnSync("python3", [join(HERE, "paint-chain-pty.py"), process.env.PC_ROWS ?? "60", process.env.PC_COLS ?? "160", home2, CLI], {
		env: { ...process.env, HOME: home2, TERM: "xterm-kitty", PC_TIMEOUT: "70", NO_COLOR: "1", PROBE_RAW: rawPath2 },
		encoding: "utf8",
		timeout: 120000,
	});
	const raw2 = readFileSync(rawPath2, "utf8");
	check("rc-nocolor no color SGR in the whole stream", !raw2.includes("\x1b[38;2;") && !raw2.includes("\x1b[39m"), "color SGR leaked under NO_COLOR");
	check("rc-nocolor ready rows still present", /^(\S+)  (.+)$/m.test(stripAnsi(raw2)), "rows lost under NO_COLOR");
} else {
	console.log("SKIP  pty half (no python3+pty on this host)");
}

// Pipes: the no-arg dump never wraps (TTY gate) — default, NO_COLOR,
// and BI_THEME=none outputs are byte-identical and SGR-free.
{
	const outs = [];
	const pipeHome = freshHome();
	for (const [tag, mod] of [["def", {}], ["nocolor", { NO_COLOR: "1" }], ["none", { BI_THEME: "none" }]]) {
		const env = { ...process.env, HOME: pipeHome, TERM: "dumb", ...mod };
		if (tag === "def") {
			delete env.NO_COLOR;
			delete env.BI_THEME;
		}
		const run = spawnSync("node", [CLI], { env, encoding: "utf8", timeout: 60000 });
		outs.push([tag, run.stdout ?? ""]);
	}
	check("rc-pipe-identical default == NO_COLOR == BI_THEME=none", outs[0][1] === outs[1][1] && outs[0][1] === outs[2][1], "pipe bytes differ by theme env");
	check("rc-pipe-identical no SGR on pipes", !outs.some(([, o]) => o.includes("\x1b[38;2;") || o.includes("\x1b[39m")), "SGR leaked on pipes");
	check("rc-pipe-identical ready header present", outs[0][1].includes("bi — ready BAIS"), "header missing on pipes");
}

if (failures > 0) {
	console.error(`ready-chrome drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("ready-chrome drill: green");
