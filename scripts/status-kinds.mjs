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

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PROBE ALL PASS" : `PROBE ${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
