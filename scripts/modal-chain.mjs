// bi/scripts/modal-chain.mjs — trust → picker → REPL modal-chain drill (bi#179)
//
// The shared modal host (bi#162) was poisoned across modals: the trust
// prompt rendered, the session picker resolved, then bi died before the
// REPL prompt. The durable fix is two host-side steps in runModal
// (bi/src/prompt.ts), not per-modal dispose:
//   1. dirty the overlay span before the pending render (a remounted
//      overlay at the same geometry diffs equal on rows the previous
//      modal already painted, so the prompt mounts invisibly);
//   2. re-assert raw mode + resume stdin after settle (readline's
//      suspendLineInput closes the interface, which pauses stdin and
//      restores cooked mode — the next modal would idle on dead stdin
//      and the loop drains as a silent exit 0).
//
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   mc-chain       trust modal accepted, first session picked, the REPL
//                  prompt draws afterwards, /help runs, /quit leaves
//                  cleanly — exit code 0, no post-picker vanish.
//   mc-help        /help output survived the chain (proves the loop is
//                  alive past the second modal, not just the prompt row).
//   mc-kept        session kept message on quit (clean teardown).
//
// The transport (e2e-pty-spawn.py, same helper the e2e harness uses)
// answers kitty query bursts itself — mute ptys never reproduced this
// bug, so the drill must speak kitty replies (acceptance requirement).
//
// bi#194 audit (bi#57 red-checks), 2026-09-08 (kimi-tui194) — both
// runModal steps re-verified STILL LOAD-BEARING before the bi#194
// transport work; neither is a dead band-aid:
//   step 1 (dirty-span) removed → first run green by race luck, then 2/2
//     repeats FAIL: `FAIL  mc-chain trust→picker→prompt survives, exit 0
//     — code=0 prompts=1` (the remounted bi[0]> never paints — the
//     exact invisible-remount mechanism; mc-help/mc-kept still green).
//     Restored → green. (bi#201 note: these records predate the label
//     change — `bi[0]>` below reads `bi>` on current builds.)
//   step 2 (raw/resume reset) removed → all three checks FAIL
//     (mc-chain prompts=1, mc-help, mc-kept; exit 0) — the bi#179
//     post-picker vanish signature, reproducing the salvage red-check.
//     Restored → green.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

// --- pty half (SKIP without python3+pty) ---
const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const makeSandbox = () => {
		const home = mkdtempSync(join(tmpdir(), "bi-mc-"));
		mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
		// setup_done skips first-run setup; NO trust.json so the cwd
		// is untrusted and the trust modal fires (modal one of two).
		writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
		// One seeded session so the resume picker fires (modal two of
		// two). Header-only: zero turns, so the post-chain prompt reads
		// bi> at every turn (bi#201 dropped the counter; a seeded
		// user turn used to read bi[1]>).
		writeFileSync(
			join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
			JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
		);
		return home;
	};
	const runPty = ({ stdinBeats = [], timeoutS = 35 }) =>
		new Promise((resolve) => {
			const home = makeSandbox();
			const env = { ...process.env, HOME: home, TERM: "xterm-kitty" };
			delete env.BI_TUI_DEBUG;
			const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "0", String(timeoutS), "node", CLI], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (d) => { out += d.toString("utf8"); });
			for (const [atMs, bytes] of stdinBeats) {
				setTimeout(() => {
					try { child.stdin.write(bytes); } catch {}
				}, atMs);
			}
			child.on("close", (code) => resolve({ out, code }));
		});

	// Trust accept, pick first session, run /help, quit. Beats are
	// generous: two modals each settle the kitty negotiation first.
	const { out, code } = await runPty({
		stdinBeats: [[4000, "\r"], [10000, "1\r"], [16000, "/help\r"], [23000, "/quit\r"], [29000, "/quit\r"]],
		timeoutS: 40,
	});
	// Live prompt rows carry SGR styling between the label chars —
	// strip ANSI before counting (the replay path is plain text).
	// bi#201: the footer label is plain `bi>` (was `bi[0]>`).
	const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][AB0]|\x1b[=>]|\x1b\][^\x07]*\x07/g, "");
	const prompts = clean.split("bi>").length - 1;
	check("mc-chain trust→picker→prompt survives, exit 0", code === 0 && prompts >= 2, `code=${code} prompts=${prompts}`);
	check("mc-help /help runs past the chain", out.includes("slash commands:"), `code=${code}`);
	check("mc-kept session kept on quit", out.includes("session kept"), `code=${code}`);
}

if (failures > 0) {
	console.error(`modal-chain drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("modal-chain drill: green");
