// bi/scripts/session-groups.mjs — session-picker grouping drill (bi#192).
//
// Fixture HOME holds sessions across two projects; the CLI boots with
// cwd=projA, so the current-project group leads. Scripted beats drive
// the startup picker on the paint-chain pty driver (kitty-replying,
// grid-emulating): snapshots pin (1) group headers with current first
// + recency-desc members, (2) one arrow-key step skipping the header
// live, (3) type-to-filter narrowing across groups, (4) Enter adopting
// the filtered member through the header layout, (5) flat output (no
// headers) for a single-project HOME. Multi-step skip/settle logic is
// pinned headless in prompt.mjs §10 (deterministic); the pty proves
// the painted integration.
//
// NOTE: the run ends by ADOPTING (Enter), not Esc: quitting after an
// Esc-dismissed startup picker prints `session kept` but the node
// process lingers (reproduced on the unmodified baseline —
// pre-existing, not bi#192; adopt-then-quit exits 0).
//
//   sg-headers      ~/projA header above ~/projB; members newest-first
//   sg-arrows       one Down lands on c3 (header skipped, never `→`)
//   sg-filter       typing the projB id keeps its header + row only
//   sg-adopt        Enter resumes b2 through the grouped layout
//   sg-flat         one project → no group chrome, both rows listed
//   sg-exit         clean exit 0
//
// Red-check (bi#57): remove the skipHeaders call after nav delegation
// in FilterList.handleInput and `sg-arrows highlight rests on c3`
// fails with the `→` row on the ~/projA header; make
// group_resume_sessions return input order and `sg-headers current
// group first` fails (projB's newer row leads). Restore for green.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
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

function seedSession(sess, id, timestamp, cwd) {
	writeFileSync(
		join(sess, `${id}.jsonl`),
		JSON.stringify({ type: "session", version: 3, id, timestamp, cwd, parent_session: null, label: null }) + "\n",
	);
}

function snapRows(out, tag) {
	return out
		.split("\n")
		.filter((l) => l.startsWith(`SNAPROW|${tag}|`))
		.map((l) => l.split("|").slice(3).join("|"));
}

// The driver never relays child text to its own stdout (GEOM/SNAP
// lines only) — resume/kept assertions read the pty byte stream the
// driver taps to PROBE_RAW. stdout assertions would always fail.
function runGrouped(home, cwd, beats, snaps) {
	const rawPath = join(home, "pty-raw.bin");
	const run = spawnSync("python3", [join(HERE, "paint-chain-pty.py"), "40", "160", home, CLI], {
		env: {
			...process.env,
			HOME: home,
			TERM: "xterm-kitty",
			PC_TIMEOUT: "70",
			PC_BEATS: beats,
			PC_SNAP_AT: snaps,
			PROBE_RAW: rawPath,
		},
		cwd,
		encoding: "utf8",
		timeout: 120000,
	});
	let raw = "";
	try {
		raw = readFileSync(rawPath, "latin1");
	} catch {}
	return { run, raw };
}

if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	// Multi-project fixture: projA (current) holds the older pair so a
	// naive recency sort would lead projB — the current-first pin.
	// realpath: process.cwd() resolves symlinks (/tmp → /private/tmp
	// on macOS), so trust keys + session cwds must use resolved paths.
	const home = realpathSync(mkdtempSync(join(tmpdir(), "bi-sg-")));
	const projA = join(home, "projA");
	const projB = join(home, "projB");
	mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
	mkdirSync(projA, { recursive: true });
	mkdirSync(projB, { recursive: true });
	writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [projA]: "allow" }) + "\n");
	const sess = join(home, ".bi", "sessions");
	seedSession(sess, "a1a1a1a1", "2026-09-01T00:00:00.000Z", projA);
	seedSession(sess, "c3c3c3c3", "2026-09-03T00:00:00.000Z", projA);
	seedSession(sess, "b2b2b2b2", "2026-09-05T00:00:00.000Z", projB);
	seedSession(sess, "d4d4d4d4", "2026-09-04T00:00:00.000Z", projB);

	// Marker-gated beats (paint-chain-pty.py @marker+N): every keystroke
	// lands relative to observed paint, so boot-delay flakes under load
	// cannot misroute keys into the wrong widget. One Down (New →
	// first member) proves the live skip; the filter + Enter proves
	// adoption through the header layout (settle parks on the member —
	// without it Enter hits the header guard and nothing resumes).
	// The second Enter is a safe backup: pty keystrokes are very rarely
	// swallowed under load, and a spare Enter is a no-op in both states
	// (modal already closed → empty REPL line reprompts, never a turn).
	const OPEN = "@Start (Enter opens";
	const { run, raw } = runGrouped(
		home,
		projA,
		`${OPEN}+1.5:\\x1b[B,${OPEN}+4:b2b2b2b2,${OPEN}+8:\\r,${OPEN}+10:\\r,@[bi] resumed b2b2b2b2+2:/quit\\r`,
		`${OPEN}+1:open,${OPEN}+3:arrows,${OPEN}+6.5:filtered`,
	);
	const out = run.stdout ?? "";
	const code = /code=(-?\d+)/.exec(out)?.[1];
	check("sg-script all beats delivered", !out.includes("UNFIRED"), /UNFIRED.*/.exec(out)?.[0] ?? "");

	const open = snapRows(out, "open");
	const idxA = open.findIndex((r) => r.includes("~/projA"));
	const idxB = open.findIndex((r) => r.includes("~/projB"));
	check("sg-headers both group headers listed", idxA >= 0 && idxB >= 0, `a=${idxA} b=${idxB}`);
	check("sg-headers current group first", idxA >= 0 && idxB >= 0 && idxA < idxB, open.filter((r) => r.includes("proj")).join(" / ").slice(0, 100));
	check("sg-headers header counts", open.some((r) => r.includes("~/projA — 2 sessions")) && open.some((r) => r.includes("~/projB — 2 sessions")));
	const idxC3 = open.findIndex((r) => r.includes("c3c3c3c3"));
	const idxA1 = open.findIndex((r) => r.includes("a1a1a1a1"));
	const idxB2 = open.findIndex((r) => r.includes("b2b2b2b2"));
	const idxD4 = open.findIndex((r) => r.includes("d4d4d4d4"));
	check(
		"sg-headers members newest-first within groups",
		idxA < idxC3 && idxC3 < idxA1 && idxA1 < idxB && idxB < idxB2 && idxB2 < idxD4,
		`a=${idxA} c3=${idxC3} a1=${idxA1} b=${idxB} b2=${idxB2} d4=${idxD4}`,
	);

	const arrows = snapRows(out, "arrows");
	const lit = arrows.filter((r) => r.includes("→"));
	check("sg-arrows highlight rests on c3", lit.length >= 1 && lit.some((r) => r.includes("c3c3c3c3")), lit.join(" / ").slice(0, 80) || "no → row");
	check("sg-arrows no header ever highlighted", !lit.some((r) => r.includes("sessions")), lit.join(" / ").slice(0, 80));

	const filtered = snapRows(out, "filtered");
	check("sg-filter keeps the matching group", filtered.some((r) => r.includes("~/projB")) && filtered.some((r) => r.includes("b2b2b2b2")));
	check("sg-filter drops the empty group", !filtered.some((r) => r.includes("~/projA")) && !filtered.some((r) => r.includes("a1a1a1a1")), filtered.filter((r) => r.includes("proj") || r.includes("a1a1")).join(" / ").slice(0, 80));
	check("sg-adopt resumes b2 through the grouped layout", raw.includes("[bi] resumed b2b2b2b2"), "no b2 resume in pty bytes");
	check("sg-adopt session kept", raw.includes("session kept"), "no kept in pty bytes");
	check("sg-exit clean", code === "0", `code=${code ?? `driver-status=${run.status}`}`);

	// Single-project HOME: the degenerate list stays flat (no headers).
	const home2 = realpathSync(mkdtempSync(join(tmpdir(), "bi-sg-flat-")));
	const only = join(home2, "only");
	mkdirSync(join(home2, ".bi", "sessions"), { recursive: true });
	mkdirSync(only, { recursive: true });
	writeFileSync(join(home2, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
	writeFileSync(join(home2, ".bi", "trust.json"), JSON.stringify({ [only]: "allow" }) + "\n");
	const sess2 = join(home2, ".bi", "sessions");
	seedSession(sess2, "e5e5e5e5", "2026-09-02T00:00:00.000Z", only);
	seedSession(sess2, "f6f6f6f6", "2026-09-06T00:00:00.000Z", only);
	const { run: run2, raw: raw2 } = runGrouped(home2, only, `${OPEN}+1.5:\\x1b[B,${OPEN}+4:\\r,${OPEN}+6:\\r,@[bi] resumed e5e5e5e5+2:/quit\\r`, `${OPEN}+1:flatopen,${OPEN}+3:flatarrows`);
	const out2 = run2.stdout ?? "";
	check("sg-flat-script all beats delivered", !out2.includes("UNFIRED"), /UNFIRED.*/.exec(out2)?.[0] ?? "");
	const flatArrows = snapRows(out2, "flatarrows");
	const flatLit = flatArrows.filter((r) => r.includes("→"));
	check("sg-flat one Down lands on e5", flatLit.length >= 1 && flatLit.some((r) => r.includes("e5e5e5e5")), flatLit.join(" / ").slice(0, 80) || "no → row");
	const flat = snapRows(out2, "flatopen");
	check("sg-flat both rows listed", flat.some((r) => r.includes("e5e5e5e5")) && flat.some((r) => r.includes("f6f6f6f6")));
	check("sg-flat no group chrome", !flat.some((r) => /— \d+ sessions?/.test(r)), flat.filter((r) => r.includes("sessions")).join(" / ").slice(0, 80));
	check("sg-flat-adopt resumes e5", raw2.includes("[bi] resumed e5e5e5e5"), "no e5 resume in pty bytes");
	const code2 = /code=(-?\d+)/.exec(out2)?.[1];
	check("sg-flat-exit clean", code2 === "0", `code=${code2 ?? "none"}`);
}

if (failures > 0) {
	console.error(`session-groups drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("session-groups drill: green");
