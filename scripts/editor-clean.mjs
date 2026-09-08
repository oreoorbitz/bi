// bi/scripts/editor-clean.mjs — editor-buffer-empty drill (bi#183)
//
// The trust→picker→editor mount sequence runs kitty negotiation across
// three modal mounts; a negotiation straggler (split reply tail, cooked
// echo) landing in the newly focused Editor would poison the first
// prompt. The in-tree machinery (per-modal settleNegotiation focus
// gating, StdinBuffer reassembly, unfocused-input drop, raw-mode
// re-assert) must keep the buffer empty. This drill asserts exactly
// that under the harshest reply timing (bytewise-chunked replies,
// tmux-style) — not the benign whole-reply case.
//
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   ec-empty       editor input line is empty at first prompt under
//                  bytewise-chunked kitty replies, clean exit 0.
// Driver: paint-chain-pty.py (kitty-speaking transport + grid
// emulation + editor-interior reporting).
import { spawnSync } from "node:child_process";
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

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const home = mkdtempSync(join(tmpdir(), "bi-ec-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	// Header-only session: zero turns, so the prompt reads bi[0]>.
	writeFileSync(
		join(home, ".bi", "sessions", "a1b2c3d4.jsonl"),
		JSON.stringify({ id: "a1b2c3d4", timestamp: "2026-09-07T00:00:00.000Z", cwd: home, parent_session: null, label: null }) + "\n",
	);
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"),
        process.env.PC_ROWS ?? "40", process.env.PC_COLS ?? "160", home, CLI], {
		env: { ...process.env, HOME: home, TERM: "xterm-kitty", PC_TIMEOUT: "45", PC_BYTEWISE: "1" },
		encoding: "utf8",
		timeout: 120000,
	});
	const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("GEOM ")) ?? "";
	const m = line.match(/prompt=\[[^\]]*\] boxtop=(\d+|None).*code=(-?\d+) input='([^']*)'/);
	const input = m ? m[3] : null;
	const code = m ? Number(m[2]) : NaN;
	check("ec-empty editor buffer empty at first prompt", m !== null && input === "", `input=${JSON.stringify(input)}`);
	check("ec-exit clean", code === 0, `code=${Number.isNaN(code) ? `driver-status=${run.status}` : code}`);
}

if (failures > 0) {
	console.error(`editor-clean drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("editor-clean drill: green");
