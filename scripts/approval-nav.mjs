// bi/scripts/approval-nav.mjs — approval list repaint drill (bi#217).
//
// bi#217: ApprovalList.paint() mutated its Text without ui.invalidate().
// The TUI input path schedules an immediate render after every key, and
// Text.setText clears its own cache, so arrow navigation repainted
// anyway — but the explicit invalidate (pickListWithPreview.show()
// precedent) is the contract: content mutations must never rely on the
// input path's side effect. This drill pins both halves:
//
//   Headless (no TTY): every highlight change invalidates through the
//   injected handle; resolve paths (digit/Enter/Esc) repaint nothing.
//   Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   an-nav1..9  askApproval with N choices, arrow down across every
//               row then up once — all N labels visible on every
//               highlight, exactly one `>` marker, marker tracks the
//               highlight; Enter resolves the highlighted index.
//   an-digit    `3` resolves index 2 positionally.
//   an-esc      Esc resolves null (rejected).
//   an-ctrlc    Ctrl-C resolves null (rejected).
//   an-pipe     piped stdio refuses without touching the terminal
//               (`prompt modal: no TTY`, exit 2).
//   an-noscreen BI_SCREEN=0 on a pty refuses the same way.
//
// Red-check record (bi#57), 2026-09-09 (lane-n) — neutered the
// paint() hunk (`this.ui?.invalidate()` removed from dist; src
// stashed): `FAIL an-invalidate nav invalidates per highlight
// change — invalidations=0 ctor=0` (right reason: no invalidate
// call flows), while an-nav1..9 pty rows stayed green — the
// input-path immediate render repaints regardless, so the
// invalidate is the contract pin, not the visible-row mechanism.
// Restored (stash pop + rebuild) → all green.
// Diagnosis note: the lead suspect does not reproduce in isolation
// (no-tick nav keeps every row visible pre- and post-fix). The live
// vanishing's remaining candidate is the ticking KindStatus racing
// the modal (out-of-band stderr writes the differential renderer
// never repaints) — owned by bi#218's freeze, which this drill's
// row-visible pins will also guard once frozen.
//

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// Headless invalidate contract: nav invalidates, resolve paths don't.
{
	const { ApprovalList } = await import(join(DIST, "src", "prompt.js"));
	let invalidations = 0;
	const resolved = [];
	const list = new ApprovalList(["a", "b", "c", "d"], (o) => resolved.push(o), { invalidate: () => { invalidations += 1; } });
	const ctorInvalidations = invalidations;
	list.handleInput("\x1b[B");
	list.handleInput("\x1b[B");
	list.handleInput("\x1b[A");
	check("an-invalidate nav invalidates per highlight change", invalidations === ctorInvalidations + 3, `invalidations=${invalidations} ctor=${ctorInvalidations}`);
	list.handleInput("2");
	list.handleInput("\r");
	list.handleInput("\x1b");
	check("an-invalidate resolve paths repaint nothing", invalidations === ctorInvalidations + 3, `invalidations=${invalidations}`);
	check("an-invalidate resolution order unchanged", JSON.stringify(resolved) === "[1,1,null]", JSON.stringify(resolved));
}

const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const home = mkdtempSync(join(tmpdir(), "bi-an-"));
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	const probe = join(home, "probe.mjs");
	writeFileSync(probe, `import { askApproval } from ${JSON.stringify(join(DIST, "src", "prompt.js"))};\nconst choices = JSON.parse(process.env.PROBE_CHOICES);\ntry {\n\tconst r = await askApproval("Approve tool?", "detail line", choices);\n\tconsole.log("RESULT:" + r);\n} catch (e) {\n\tconsole.log("THREW:" + e.message);\n\tprocess.exit(2);\n}\n`);

	const runPty = (n, beats, extraEnv = {}) => {
		const choices = JSON.stringify(Array.from({ length: n }, (_, i) => `choice-${i + 1}`));
		const run = spawnSync("python3", [join(HERE, "approval-nav-pty.py"), String(n), beats.join(",")], {
			env: { ...process.env, HOME: home, TERM: "xterm-kitty", PROBE_JS: probe, PROBE_CHOICES: choices, DIAG_HOME: home, ...extraEnv },
			encoding: "utf8",
			timeout: 90000,
		});
		return (run.stdout ?? "").split("\n");
	};

	// All choice counts 1..9 (single-row degenerate included): every
	// row visible on every highlight, marker tracks, Enter resolves.
	for (let n = 1; n <= 9; n++) {
		const beats = [...Array(Math.max(0, n - 1)).fill("down"), ...(n > 1 ? ["up"] : []), "enter"];
		const lines = runPty(n, beats);
		// The enter STEP snapshots post-resolve teardown (empty grid) —
		// rows/markers assert on nav STEPs only; enter asserts via RESULT.
		const steps = lines.filter((l) => l.startsWith("STEP ") && !l.includes(" enter:"));
		let at = 0;
		let navOk = true;
		let firstBad = "";
		for (const s of steps) {
			const m = s.match(/^STEP \d+ (\S+): rows=(\d+)\/(\d+) markers=(\d+) marked=(.*)$/);
			if (!m) { navOk = false; firstBad = s.slice(0, 90); break; }
			const [, beat, rows, total, markers, marked] = m;
			if (beat === "down") at = (at + 1) % n;
			else if (beat === "up") at = (at + n - 1) % n;
			else { navOk = false; firstBad = s.slice(0, 90); break; }
			if (Number(rows) !== n || Number(total) !== n || Number(markers) !== 1 || (marked ?? "").trim() !== `> ${at + 1}. choice-${at + 1}`) {
				navOk = false;
				firstBad = s.slice(0, 90);
				break;
			}
		}
		const result = (lines.find((l) => l.startsWith("RESULT:")) ?? "").slice("RESULT:".length).trim();
		const expect = n === 1 ? "0" : String(n - 2);
		check(`an-nav${n} rows visible on every highlight, enter resolves ${expect}`, navOk && steps.length === beats.length - 1 && result === expect, `steps=${steps.length} result=${result} ${firstBad}`);
	}

	// Digits / Esc / Ctrl-C paths unchanged.
	{
		const lines = runPty(4, ["digit:3"]);
		const result = (lines.find((l) => l.startsWith("RESULT:")) ?? "").slice("RESULT:".length).trim();
		check("an-digit `3` resolves index 2", result === "2", `result=${result}`);
	}
	for (const [name, beat] of [["an-esc", "esc"], ["an-ctrlc", "ctrlc"]]) {
		const lines = runPty(4, [beat]);
		const result = (lines.find((l) => l.startsWith("RESULT:")) ?? "").slice("RESULT:".length).trim();
		check(`${name} ${beat} resolves null`, result === "null", `result=${result}`);
	}

	// Pipes never reach the modal (pin: refused, exit 2, no escape bytes).
	{
		const run = spawnSync("node", [probe], {
			env: { ...process.env, PROBE_CHOICES: JSON.stringify(["a", "b"]) },
			encoding: "utf8",
			timeout: 30000,
		});
		const out = (run.stdout ?? "") + (run.stderr ?? "");
		check("an-pipe piped stdio refuses without TTY", run.status === 2 && out.includes("THREW:prompt modal: no TTY"), `status=${run.status} out=${out.slice(0, 80)}`);
		check("an-pipe refusal writes no escape bytes", !out.includes("\x1b"), `out=${JSON.stringify(out.slice(0, 80))}`);
	}

	// BI_SCREEN=0 refuses on a pty the same way.
	{
		const lines = runPty(4, [], { BI_SCREEN: "0" });
		const result = (lines.find((l) => l.startsWith("RESULT:")) ?? "").slice("RESULT:".length).trim();
		check("an-noscreen BI_SCREEN=0 refuses the modal", result.startsWith("THREW:prompt modal: no TTY"), `result=${result}`);
	}
}

if (failures) { console.log(`approval-nav: ${failures} FAIL`); process.exit(1); }
console.log("approval-nav: all green");
