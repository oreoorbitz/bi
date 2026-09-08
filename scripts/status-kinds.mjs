// bi/scripts/status-kinds.mjs — offline conformance for bi#96 (plain node).
// Proves the working-state indicator kinds end to end:
//   state -> label (BAML format_status_label, read-only) -> HostStatus display.
//
// BAML owns the text (asserted straight from baml_sdk); the host owns the
// tick (per-kind spinner frames + KindStatus repaint state in dist/src).
// No network, no keys: retry uses a stubbed LlmFn-style call, compaction
// uses a stubbed summarizer.
//
// Red-check (bi#57): the no-leak net is load-bearing. Verified by breaking
// KindStatus.stop() to skip its reset (reverse hunk: delete the two reset
// lines), observing `FAIL stop resets to working` + `FAIL stop releases the
// sink`, then restoring and re-running green. A passing suite that cannot go
// red on a removed reset would be camouflage, not coverage.
//
// Red-check (bi#57, bi#191 arm): revert statusEventTailUpdater to write raw
// deltas (`process.stderr.write(delta)` instead of the setEvent tail) and
// the arm fails `draft head never written raw` + `every event segment
// within tail window`; restored, green. Observed 2026-09-08:
//   FAIL draft head never written raw — head leaked
//   FAIL every event segment within tail window — [132,2,2,6]
//   FAIL a paint carries the word-boundary tail — …is the most
//   PROBE 3 FAILURES
//
// Env discipline (bi#193): the shaping sections pin the ESCAPE-FREE
// contract, so NO_COLOR=1 is forced for them and cleared only inside the
// color arm at the bottom — the ambient env must never leak either way.
// Red-check (bi#57, bi#193 arm), executed 2026-09-08: reverted
// paintStatusLine's spinner wrap to pass the raw spinner →
//   FAIL paint spinner pops primary — …
// restored → green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(fileURLToPath(import.meta.url));
const {
	KindStatus,
	STATUS_KINDS,
	STATUS_SPINNERS,
	spinnerFor,
	resolveStatusLabel,
	setActiveStatus,
	activeStatus,
	STATUS_CANCEL_HINT,
} = await import(join(ROOT, "..", "dist", "src", "status.js"));
const { callWithRetry } = await import(join(ROOT, "..", "dist", "src", "retry.js"));
const { compactHistory } = await import(join(ROOT, "..", "dist", "src", "compaction.js"));
const { format_status_label, format_status, format_turn_summary, TurnFailure } = await import(
	join(ROOT, "..", "dist", "baml_sdk", "index.js")
);
const tf = await import(join(ROOT, "..", "dist", "src", "theme-files.js"));

// bi#193: shaping sections pin the escape-free contract (the chrome wrap
// is a byte-identical passthrough when suppressed) — force suppression
// here; the color arm at the bottom clears it for exactly its section.
process.env.NO_COLOR = "1";
delete process.env.BI_THEME;

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- BAML owns the text: attempt counts, reasons, cancel hint ---
check(
	"retry label carries attempt count",
	format_status_label("retry", "", 2, 5, 9, "", { cancel_hint: "ctrl-c" }) === "Retrying (2/5) in 9s... (ctrl-c to cancel)",
);
check(
	"host resolves retry label via baml (no re-shaping)",
	resolveStatusLabel({ kind: "retry", label: "", attempt: 2, maxAttempts: 5, delaySecs: 9, reason: "" }) ===
		"Retrying (2/5) in 9s... (ctrl-c to cancel)",
);
check(
	"compaction threshold label",
	format_status_label("compaction", "", 0, 0, 0, "threshold", { cancel_hint: "ctrl-c" }) === "Auto-compacting... (ctrl-c to cancel)",
);
check(
	"compaction overflow label",
	format_status_label("compaction", "", 0, 0, 0, "overflow", { cancel_hint: null }) ===
		"Context overflow detected, auto-compacting...",
);
check("branchSummary label", format_status_label("branchSummary", "", 0, 0, 0, "", { cancel_hint: null }) === "Summarizing branch...");
check("working passes the caller label through", format_status_label("working", "thinking", 0, 0, 0, "", { cancel_hint: null }) === "thinking");
check("cancel hint constant matches pi wording", STATUS_CANCEL_HINT === "ctrl-c");

// --- Host owns the tick: distinct spinner frames per kind ---
check("four kinds wired", JSON.stringify(STATUS_KINDS) === JSON.stringify(["working", "retry", "compaction", "branchSummary"]));
{
	const sets = STATUS_KINDS.map((k) => (STATUS_SPINNERS[k] ?? []).join(""));
	const nonEmpty = sets.every((s) => s.length > 0);
	const distinct = new Set(sets).size === sets.length;
	check("spinner sets non-empty and pairwise distinct", nonEmpty && distinct, JSON.stringify(sets.map((s) => s.length)));
	check("spinner cycles with tick", spinnerFor("retry", 0) === STATUS_SPINNERS.retry[0] && spinnerFor("retry", 4) === STATUS_SPINNERS.retry[0]);
}

// --- KindStatus: state -> label -> display line ---
const fns = { formatStatus: format_status, formatSummary: format_turn_summary };
{
	const s = new KindStatus("thinking", fns);
	check("starts working with caller label", s.kind === "working" && s.statusLabel === "thinking", s.statusLabel);

	s.showRetry(2, 5, 9);
	check("retry state shows attempt count", s.kind === "retry" && s.statusLabel === "Retrying (2/5) in 9s... (ctrl-c to cancel)", s.statusLabel);

	s.showCompaction("threshold");
	check("compaction state", s.kind === "compaction" && s.statusLabel === "Auto-compacting... (ctrl-c to cancel)", s.statusLabel);

	s.showBranchSummary();
	check("branchSummary state", s.kind === "branchSummary" && s.statusLabel === "Summarizing branch... (ctrl-c to cancel)", s.statusLabel);

	s.showWorking();
	check("back to working restores label", s.kind === "working" && s.statusLabel === "thinking", s.statusLabel);

	// Display line: kind spinner + kind label shaped by the shared BAML line fn.
	const line = format_status(spinnerFor("retry", 0), "Retrying (2/5) in 9s...", 4200, "");
	check("display line carries spinner and label", line.includes("◐") && line.includes("Retrying (2/5)"), line);
}

// --- No leak across turns: start registers, stop resets + releases ---
{
	const s = new KindStatus("thinking", fns);
	s.start();
	check("start claims the sink", activeStatus() === s);
	s.showRetry(1, 3, 1);
	s.stop({ failed: false, detail: "", turns: 1, messages: 2 });
	check("stop resets to working", s.kind === "working" && s.statusLabel === "thinking", `${s.kind} ${s.statusLabel}`);
	check("stop releases the sink", activeStatus() === null);

	// A fresh turn never inherits the previous kind even without an
	// intervening showWorking: start() itself resets.
	s.showCompaction("overflow");
	s.start();
	check("restart resets a stale kind", s.kind === "compaction" ? false : s.statusLabel === "thinking", s.statusLabel);
	s.stop({ failed: false, detail: "", turns: 0, messages: 0 });
}

// --- Retry wait reports through the sink, then restores working ---
{
	const seen = [];
	const sink = {
		showWorking: () => seen.push("working"),
		showRetry: (a, m, d) => seen.push(`retry ${a}/${m} ${d}s`),
		showCompaction: (r) => seen.push(`compaction ${r}`),
		showBranchSummary: () => seen.push("branchSummary"),
	};
	setActiveStatus(sink);
	let calls = 0;
	const out = await callWithRetry("probe", async () => {
		calls += 1;
		if (calls === 1) return new TurnFailure({ kind: "rate_limited", message: "slow down", retry_safe: true });
		return {};
	});
	setActiveStatus(null);
	check("retry succeeds after one wait", !(out instanceof TurnFailure) && calls === 2, `calls=${calls}`);
	check(
		"retry wait showed retry state with attempt count",
		seen.length === 2 && seen[0].startsWith("retry 1/3") && seen[1] === "working",
		JSON.stringify(seen),
	);
}

// --- Compaction wait reports through the sink, then restores working ---
{
	const s = new KindStatus("thinking", fns);
	setActiveStatus(s);
	let kindDuringSummarize = "";
	const messages = Array.from({ length: 6 }, (_, i) => ({ role: "user", text: `m${i} ` + "x".repeat(200) }));
	const out = await compactHistory(messages, async () => {
		kindDuringSummarize = s.kind;
		return "summary";
	}, { keepRecentTokens: 50 });
	setActiveStatus(null);
	check("compaction spliced history", out !== null && out.messages.length === 2 && out.cut === 5, JSON.stringify(out && { cut: out.cut, n: out.messages.length }));
	check("compaction wait showed compaction state", kindDuringSummarize === "compaction", kindDuringSummarize);
	check("compaction restored working", s.kind === "working", s.kind);
}

// --- bi#191: stream draft rides the status event, never raw stderr ---
// Replays the cli turn wiring (statusEventTailUpdater per chunk) against a
// fake 40-col TTY and asserts the settled byte stream carries no raw draft:
// the draft head falls out of the tail window, every paint's event segment
// stays within tail+ellipsis, and the row left behind is the BAML summary.
{
	const { status_event_tail } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
	const { statusEventTailUpdater } = await import(join(ROOT, "..", "dist", "src", "status.js"));
	const cols = 40;
	let buf = "";
	const realWrite = process.stderr.write.bind(process.stderr);
	const realIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
	const realCols = Object.getOwnPropertyDescriptor(process.stderr, "columns");
	process.stderr.write = (s) => {
		buf += s;
		return true;
	};
	Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stderr, "columns", { value: cols, configurable: true });
	try {
		const s = new KindStatus("thinking", fns);
		s.start();
		const draft = "If you're not sure where to start, my honest read: **bi#190** is trivial, **bi#172** is the most embarrassing self-dogfooding bug.";
		const onDelta = statusEventTailUpdater(s, 50);
		for (let i = 0; i < draft.length; i += 30) onDelta(draft.slice(i, i + 30));
		await new Promise((r) => setTimeout(r, 250)); // a few paints
		s.stop({ failed: false, detail: "", turns: 1, messages: 2 });
	} finally {
		process.stderr.write = realWrite;
		if (realIsTTY) Object.defineProperty(process.stderr, "isTTY", realIsTTY);
		if (realCols) Object.defineProperty(process.stderr, "columns", realCols);
	}
	const draftHead = "If you're not sure where to start";
	check("draft head never written raw", !buf.includes(draftHead), buf.includes(draftHead) ? "head leaked" : "");
	const paintRows = buf.split("\r").map((r) => r.replace("\x1b[2K", "")).filter((r) => r.includes("·"));
	const segments = paintRows.map((r) => r.slice(r.lastIndexOf("·") + 1).replace(/\n.*$/s, ""));
	check(
		"every event segment within tail window",
		segments.every((seg) => [...seg].length <= 51),
		JSON.stringify(segments.map((s) => [...s].length)),
	);
	check("settled line is the BAML summary", buf.trimEnd().endsWith("✓ done · 1 turn · 2 messages · 250ms") || /✓ done · 1 turn · 2 messages · \d+(\.\d+)?(ms|s)/.test(buf), "");
	const expectedTail = status_event_tail(
		"If you're not sure where to start, my honest read: **bi#190** is trivial, **bi#172** is the most embarrassing self-dogfooding bug.",
		50,
	);
	// The 40-col clamp cuts the painted row (`…is the most emb...`), so pin a
	// short head of the tail that survives truncation, not the whole tail.
	const tailHead = [...expectedTail].slice(0, 12).join("");
	check("a paint carries the word-boundary tail", buf.includes(tailHead), tailHead);
}

// --- bi#193 color arm: spinner primary, status line text_dim ---
// Drives the REAL KindStatus paint loop against a captured fake TTY with
// suppression lifted for exactly this section. Byte-pins: the paint opens
// text_dim, re-opens primary for the spinner glyph, closes fg-default;
// the settled summary stays off the chrome path (BAML good/bad owns it).
{
	delete process.env.NO_COLOR;
	delete process.env.BI_THEME;
	const PRIMARY = tf.chromeAnsi("primary", {});
	const DIM = tf.chromeAnsi("text_dim", {});
	const RESET = tf.CHROME_RESET;
	check("primary byte-pin #4FA8FF", PRIMARY === "\x1b[38;2;79;168;255m");
	check("text_dim byte-pin #888888", DIM === "\x1b[38;2;136;136;136m");

	const { paintStatusLine } = await import(join(ROOT, "..", "dist", "src", "status.js"));
	const painted = paintStatusLine("⠋", "thinking", 4200, "", format_status);
	check(
		"paint line composition byte-pinned",
		painted === `${DIM}${PRIMARY}⠋${DIM} thinking · 4.2s · …${RESET}`,
		JSON.stringify(painted),
	);
	process.env.NO_COLOR = "1";
	check(
		"suppressed paint line is the BAML line verbatim",
		paintStatusLine("⠋", "thinking", 4200, "", format_status) === format_status("⠋", "thinking", 4200, ""),
		"suppression not byte-identical",
	);
	delete process.env.NO_COLOR;

	let buf = "";
	const realWrite = process.stderr.write.bind(process.stderr);
	const realIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
	process.stderr.write = (s) => {
		buf += s;
		return true;
	};
	Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	try {
		const s = new KindStatus("thinking", fns);
		s.start();
		await new Promise((r) => setTimeout(r, 250)); // a few paints
		s.stop({ failed: false, detail: "", turns: 1, messages: 2, theme: null });
	} finally {
		process.stderr.write = realWrite;
		if (realIsTTY) Object.defineProperty(process.stderr, "isTTY", realIsTTY);
	}
	check("paint spinner pops primary", buf.includes(`${PRIMARY}⠋${DIM}`) || buf.includes(`${PRIMARY}⠙${DIM}`), "no primary spinner in stream");
	check("paint label recedes text_dim", buf.includes(`${DIM} thinking ·`), "no dim thinking label in stream");
	check("paint line closes fg-default", buf.includes(`${RESET}`), "no reset in stream");
	// Paints rewrite in place with \r, so the settled row is the last
	// \r-segment of the last \n-line — the BAML summary, off the chrome path.
	const summaryRow = (buf.trimEnd().split("\n").pop() ?? "").split("\r").pop() ?? "";
	check("settled summary stays off chrome (no 38;2)", !summaryRow.includes("\x1b[38;2;") && summaryRow.includes("✓ done"), JSON.stringify(summaryRow.slice(0, 60)));

	// Escape-free arms: both gates leave zero color SGR in the stream.
	for (const [name, set] of [["NO_COLOR", () => (process.env.NO_COLOR = "1")], ["BI_THEME=none", () => (process.env.BI_THEME = "none")]]) {
		delete process.env.NO_COLOR;
		delete process.env.BI_THEME;
		set();
		let b2 = "";
		process.stderr.write = (s) => {
			b2 += s;
			return true;
		};
		Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
		try {
			const s = new KindStatus("thinking", fns);
			s.start();
			await new Promise((r) => setTimeout(r, 220));
			s.stop({ failed: false, detail: "", turns: 1, messages: 2, theme: null });
		} finally {
			process.stderr.write = realWrite;
			if (realIsTTY) Object.defineProperty(process.stderr, "isTTY", realIsTTY);
		}
		check(`${name} status stream is color-escape-free`, !b2.includes("\x1b[38;2;") && !b2.includes("\x1b[39m"), "color SGR leaked");
	}
	delete process.env.BI_THEME;
	process.env.NO_COLOR = "1";
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PROBE ALL PASS" : `PROBE ${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
