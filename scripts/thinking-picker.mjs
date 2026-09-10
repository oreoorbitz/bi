// bi/scripts/thinking-picker.mjs — bi#204 drill: bare /thinking is a
// picker like /model (screen tier first, host tier over the BAML rows,
// static list on pipes/Esc), plus reasoning:false awareness.
//
//   tp-pick            pty: arrows+Enter applies through the set path
//                      (`[bi] thinking now minimal (saved)` + persisted
//                      default_thinking), cursor starts on the live level.
//   tp-pick-noreason   pty: default backend (claude-haiku-4-5,
//                      reasoning:false) names the inert state up front.
//   tp-esc             pty: Esc keeps the static list; `/thinking low`
//                      still applies by name afterwards.
//   tp-reason-true     pty: reasoning:true model setter saves with NO
//                      no-reason note.
//   tp-static-screen0  pty + BI_SCREEN=0 (no modal widgets): static list,
//                      all 7 levels, note still named, no picker title.
//   tp-static-nocolor  pty + BI_SCREEN=0 + NO_COLOR: zero color SGR,
//                      content intact.
//   tp-pipe-boot       pipes: `/thinking` on piped stdin changes nothing
//                      (REPL is TTY-only) — boot stays clean, exit 0,
//                      byte-identical across theme envs.
//
// Driving discipline (learned the hard way): boot time varies widely,
// and input sent before the editor mounts coalesces in the pty buffer
// (two CR-terminated lines can resolve as ONE pasted blob — observed:
// `unknown thinking level "low\n/quit"`). So every send is gated on an
// OBSERVED marker — never a fixed sleep: step 0 waits for the editor
// frame plus a grace, then a `/help` noop PROVES the loop dispatches
// before the scenario starts; later steps wait for the picker title /
// saved line / quiescence. A step that never sees its marker fails
// loudly naming it (not a bare timeout kill). With-args submits send a
// DOUBLE Enter: the editor's arg-completion eats the first Enter
// (accepts the match) and only the second submits — single-Enter
// with-args lines vanish into the dropdown (tap-proven). Bare submits
// (/help, /quit, bare /thinking) take a single Enter; picker keys are
// unaffected (no completion in the modal).
//
// Red-check records (bi#57), executed 2026-09-10 on a pty host:
//   hunk A: screen-tier Enter resolves to `return history` (drop the
//     applyThinkingLevel call).
//     expected: tp-pick FAIL (no `thinking now minimal` line, nothing
//       persisted); tp-esc/tp-reason-true stay green.
//     observed: tp-pick stuck at applied, no saved line,
//       settings=undefined; tp-esc + tp-reason-true green — as expected.
//   hunk B: drop the `thinkingNoReasonNote` calls (picker + setter).
//     expected: tp-pick-noreason FAIL (no `does not reason` line);
//       tp-pick saved-line stays green.
//     observed: tp-pick saved line green, `does not reason` gone —
//       as expected.
//   restore: both hunks restored → drill green.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");
const SPAWN = join(HERE, "e2e-pty-spawn.py");

const K_DOWN = "\x1b[B";
const K_ESC = "\x1b[27u";
// bi#154 paste-burst guard: 8+ rapid plain chars + Enter submits
// as a newline, so modal-editor text sends ride bracketed paste
// (markers bypass the guard) with the submit CR(s) after.
// Line-mode scenarios (BI_SCREEN=0) stay raw — readline would
// take the markers literally. Pure-key sends stay raw everywhere.
const paste = (text) => "\x1b[200~" + text + "\x1b[201~";

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// Probe opens a device, not just the module: pty-less sandboxes have
// python3+pty but no /dev/pts, and must SKIP (not run-and-fail).
const hasPty = spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore" }).status === 0;

// Fresh sandbox HOME: nothing real touched (sessions/settings/trust all
// land here). setup_done skips first-run; trust.json pre-trusts the cwd
// so no trust modal eats scripted keys; no seeded sessions so no
// startup picker steals the first step.
function makeSandbox(seedSettings = {}) {
	const home = mkdtempSync(join(tmpdir(), "bi-tp-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [process.cwd()]: "allow" }) + "\n");
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true, ...seedSettings }) + "\n");
	return home;
}

function readSettings(home) {
	try {
		return JSON.parse(readFileSync(join(home, ".bi", "settings.json"), "utf8"));
	} catch {
		return {};
	}
}

// Marker-gated session driver. steps: [{ wait, send, graceMs, timeoutMs,
// name }] — each send fires graceMs after its wait marker is first seen
// in the pty stream; a step whose marker never appears resolves the run
// with stuckAt naming it. Resolves on child close.
function driveSession({ steps, timeoutMs = 120000, extraEnv = {}, home = null }) {
	return new Promise((resolve) => {
		home = home ?? makeSandbox();
		const env = { ...process.env, HOME: home, TERM: "xterm-kitty", ...extraEnv };
		delete env.BI_TUI_DEBUG;
		const child = spawn("python3", [SPAWN, "0", String(Math.ceil(timeoutMs / 1000)), "node", CLI], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let stepIdx = 0;
		let waitStart = Date.now();
		let graceAt = 0;
		let waitingFor = steps[0];
		let stuckAt = null;
		const pump = setInterval(() => {
			if (!waitingFor) return;
			const t = waitingFor.timeoutMs ?? 45000;
			if (waitingFor.wait.test(out)) {
				if (!graceAt) graceAt = Date.now() + (waitingFor.graceMs ?? 0);
				if (Date.now() >= graceAt) {
					try {
						child.stdin.write(waitingFor.send);
					} catch {}
					stepIdx += 1;
					waitingFor = steps[stepIdx] ?? null;
					waitStart = Date.now();
					graceAt = 0;
				}
				return;
			}
			if (Date.now() - waitStart > t) {
				stuckAt = waitingFor.name ?? `step${stepIdx}`;
				try {
					child.kill();
				} catch {}
			}
		}, 200);
		child.stdout.on("data", (d) => {
			out += d.toString("utf8");
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (code) => {
			clearInterval(pump);
			// Drain: the child can print its last marker and exit inside
			// one pump interval — advance send-free steps whose wait
			// already matches so a seen-but-unpolled terminal marker
			// doesn't read as an early close.
			while (waitingFor && waitingFor.wait.test(out) && (waitingFor.send ?? "") === "") {
				stepIdx += 1;
				waitingFor = steps[stepIdx] ?? null;
			}
			if (stuckAt === null && waitingFor) stuckAt = (waitingFor.name ?? "step" + stepIdx) + " (child closed early)";
			resolve({ out, code, timedOut: code === 3, stderr, home, stuckAt });
		});
		child.on("error", (e) => {
			clearInterval(pump);
			resolve({ out, code: null, timedOut: true, stderr: String(e), home, stuckAt: waitingFor?.name ?? "spawn" });
		});
	});
}

// Every scenario starts proved-ready: the editor frame plus a grace
// (mount storm settles), then a /help noop whose output proves the loop
// dispatches before scenario keys move.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-2]/g, "");

if (hasPty) {
	// tp-pick: default backend (haiku, reasoning:false), cursor on
	// "off" (index 0); ↓ + Enter applies "minimal" via the set path.
	{
		const { out, stuckAt, home } = await driveSession({
			steps: [
				{ name: "prompt-ready", wait: /╭ bi>/, send: paste("/help") + "\r", graceMs: 2000, timeoutMs: 60000 },
				{ name: "loop-live", wait: /slash commands:/, send: paste("/thinking") + "\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "picker-open", wait: /Select thinking level/, send: `${K_DOWN}\r`, graceMs: 500, timeoutMs: 45000 },
				{ name: "applied", wait: /\[bi\] thinking now minimal \(saved\)/, send: paste("/quit") + "\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "quit", wait: /session kept/, send: "", graceMs: 500, timeoutMs: 45000 },
			],
		});
		check("tp-pick all steps fired", stuckAt === null, stuckAt ? `stuck at ${stuckAt}` : "");
		check("tp-pick arrows+Enter applies (saved line)", out.includes("[bi] thinking now minimal (saved)"), "no minimal saved line");
		check("tp-pick persists default_thinking", readSettings(home).default_thinking === "minimal", `settings=${JSON.stringify(readSettings(home).default_thinking)}`);
		check(
			"tp-pick-noreason names the inert state",
			out.includes("claude-haiku-4-5 does not reason — levels apply when you switch to a reasoning model"),
			"no no-reason note",
		);
		check("tp-pick clean quit", out.includes("session kept"));
	}

	// tp-esc: Esc keeps the static list; names still work after.
	{
		const { out, stuckAt, home } = await driveSession({
			steps: [
				{ name: "prompt-ready", wait: /╭ bi>/, send: paste("/help") + "\r", graceMs: 2000, timeoutMs: 60000 },
				{ name: "loop-live", wait: /slash commands:/, send: paste("/thinking") + "\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "picker-open", wait: /Select thinking level/, send: K_ESC, graceMs: 500, timeoutMs: 45000 },
				{ name: "esc-grace", wait: /Select thinking level/, send: paste("/thinking low") + "\r\r", graceMs: 2500, timeoutMs: 45000 },
				{ name: "applied", wait: /\[bi\] thinking now low \(saved\)/, send: paste("/quit") + "\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "quit", wait: /session kept/, send: "", graceMs: 500, timeoutMs: 45000 },
			],
		});
		const plain = stripAnsi(out);
		check("tp-esc all steps fired", stuckAt === null, stuckAt ? `stuck at ${stuckAt}` : "");
		check("tp-esc Esc keeps the static list", LEVELS.every((l) => plain.includes(l)), "level rows lost after Esc");
		check("tp-esc names still apply after Esc", out.includes("[bi] thinking now low (saved)"), "no low saved line");
		check("tp-esc persists default_thinking", readSettings(home).default_thinking === "low", `settings=${JSON.stringify(readSettings(home).default_thinking)}`);
		check("tp-esc clean quit", out.includes("session kept"));
	}

	// tp-reason-true: reasoning:true model setter saves with no note.
	{
		const home = makeSandbox({ default_provider: "anthropic", default_model: "claude-sonnet-4-5" });
		const { out, stuckAt } = await driveSession({
			home,
			steps: [
				{ name: "prompt-ready", wait: /╭ bi>/, send: paste("/help") + "\r", graceMs: 2000, timeoutMs: 60000 },
				{ name: "loop-live", wait: /slash commands:/, send: paste("/thinking high") + "\r\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "applied", wait: /\[bi\] thinking now high \(saved\)/, send: paste("/quit") + "\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "quit", wait: /session kept/, send: "", graceMs: 500, timeoutMs: 45000 },
			],
		});
		check("tp-reason-true all steps fired", stuckAt === null, stuckAt ? `stuck at ${stuckAt}` : "");
		check("tp-reason-true setter saves", out.includes("[bi] thinking now high (saved)"), "no high saved line");
		check("tp-reason-true no inert-state note on a reasoning model", !out.includes("does not reason"), "note leaked on reasoning:true");
		check("tp-reason-true persists default_thinking", readSettings(home).default_thinking === "high", `settings=${JSON.stringify(readSettings(home).default_thinking)}`);
		check("tp-reason-true clean quit", out.includes("session kept"));
	}

	// tp-static-screen0: no modal widgets — static list, note named, no
	// picker title. The longest row only prints on the static path, so
	// it gates the static print (not just modal residue). BI_SCREEN=0
	// runs readline line-mode (`bi> `, no editor box), so readiness
	// gates on the line prompt instead.
	{
		const { out, stuckAt } = await driveSession({
			extraEnv: { BI_SCREEN: "0" },
			steps: [
				{ name: "prompt-ready", wait: /bi> /, send: "/help\r", graceMs: 2000, timeoutMs: 60000 },
				{ name: "loop-live", wait: /slash commands:/, send: "/thinking\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "static-list", wait: /Maximum reasoning/, send: "/quit\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "quit", wait: /session kept/, send: "", graceMs: 500, timeoutMs: 45000 },
			],
		});
		const plain = stripAnsi(out);
		check("tp-static-screen0 all steps fired", stuckAt === null, stuckAt ? `stuck at ${stuckAt}` : "");
		check("tp-static-screen0 all 7 levels listed", LEVELS.every((l) => plain.includes(l)), "static list incomplete, missing=" + LEVELS.filter((l) => !plain.includes(l)).join(",") + " outlen=" + out.length);
		writeFileSync("/tmp/tp-screen0-" + process.pid + ".log", out);
		check("tp-static-screen0 no picker opened", !out.includes("Select thinking level") && !out.includes("Pick thinking level"), "picker title leaked");
		check(
			"tp-static-screen0 note still named",
			out.includes("claude-haiku-4-5 does not reason — levels apply when you switch to a reasoning model"),
			"no no-reason note",
		);
		check("tp-static-screen0 clean quit", out.includes("session kept"));
	}

	// tp-static-nocolor: escape-free posture holds by construction.
	{
		const { out, stuckAt } = await driveSession({
			extraEnv: { BI_SCREEN: "0", NO_COLOR: "1" },
			steps: [
				{ name: "prompt-ready", wait: /bi> /, send: "/help\r", graceMs: 2000, timeoutMs: 60000 },
				{ name: "loop-live", wait: /slash commands:/, send: "/thinking\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "static-list", wait: /Maximum reasoning/, send: "/quit\r", graceMs: 500, timeoutMs: 45000 },
				{ name: "quit", wait: /session kept/, send: "", graceMs: 500, timeoutMs: 45000 },
			],
		});
		const plain = stripAnsi(out);
		check("tp-static-nocolor all steps fired", stuckAt === null, stuckAt ? `stuck at ${stuckAt}` : "");
		check("tp-static-nocolor zero color SGR in the stream", !out.includes("\x1b[38;2;") && !out.includes("\x1b[39m"), "color SGR leaked under NO_COLOR");
		check("tp-static-nocolor content intact", LEVELS.every((l) => plain.includes(l)), "levels lost under NO_COLOR, missing=" + LEVELS.filter((l) => !plain.includes(l)).join(",") + " outlen=" + out.length);
		writeFileSync("/tmp/tp-nocolor-" + process.pid + ".log", out);
		check("tp-static-nocolor clean quit", out.includes("session kept"));
	}
} else {
	console.log("SKIP  pty half (no python3+pty on this host)");
}

// tp-pipe-boot: piped stdin never reaches slash dispatch (REPL is
// TTY-only) — boot stays clean, exit 0, byte-identical across theme
// envs. One shared HOME: the session hint embeds the path, so per-env
// homes would differ by construction.
{
	const pipeHome = makeSandbox();
	const outs = [];
	for (const [tag, mod] of [["def", {}], ["nocolor", { NO_COLOR: "1" }], ["none", { BI_THEME: "none" }]]) {
		const env = { ...process.env, HOME: pipeHome, TERM: "dumb", ...mod };
		if (tag === "def") {
			delete env.NO_COLOR;
			delete env.BI_THEME;
		}
		const run = spawnSync("node", [CLI], { input: "/thinking\n", env, encoding: "utf8", timeout: 60000 });
		outs.push([tag, run.stdout ?? "", run.status]);
	}
	check("tp-pipe-boot exit 0 everywhere", outs.every(([, , st]) => st === 0), JSON.stringify(outs.map(([, , st]) => st)));
	check("tp-pipe-boot no thinking dispatch on pipes", outs.every(([, o]) => !o.includes("thinking now")), "slash ran on pipes");
	check("tp-pipe-boot byte-identical across theme envs", outs[0][1] === outs[1][1] && outs[0][1] === outs[2][1], "pipe bytes differ by theme env");
}

if (failures > 0) {
	console.error(`thinking-picker drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("thinking-picker drill: green");
