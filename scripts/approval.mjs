// bi/scripts/approval.mjs — per-call approval conformance (bi#170).
// Pins the session-latch state machine (pure transition, no TTY) and
// its contract with the BAML choice order: index 1 latches, unknown
// indices fail closed. The modal itself (digits/↑↓/Enter/Esc) lives
// behind promptAvailable and is exercised in pty, not here;
// non-interactive refuse/proceed paths are unchanged by construction
// (approvalInteractive defaults false, promptAvailable gates).
//
// Red-checks (bi#57) 2026-09-08: latch.set neutered → FAIL session
// latches the tool (1 FAIL, 7 pass); digit range neutered → FAIL
// digit resolves positionally (1 FAIL, 14 pass); both restored
// cmp-identical → green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { applyApprovalPick } = await import(join(ROOT, "..", "dist", "src", "tools.js"));
const { ApprovalList } = await import(join(ROOT, "..", "dist", "src", "prompt.js"));
const { approval_choices_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`ok: ${name}`); }
	else { fail++; console.log(`FAIL: ${name} ${extra}`); }
};

// Host mapping rests on the BAML order — pin it once here.
{
	const choices = await approval_choices_async();
	check("choice order is once/session/reject/feedback", JSON.stringify(choices) === JSON.stringify(["Approve once", "Approve for this session", "Reject", "Reject with feedback"]), JSON.stringify(choices));
}

// Latch transitions: session latches, once leaves no trace, rejects
// never latch, unknowns fail closed.
{
	const latch = new Map();
	check("once proceeds unlatched", applyApprovalPick(latch, "write", 0) === "once" && !latch.has("write"));
	check("session latches the tool", applyApprovalPick(latch, "write", 1) === "session" && latch.get("write") === true);
	const latch2 = new Map();
	check("reject latches nothing", applyApprovalPick(latch2, "bash", 2) === "reject" && latch2.size === 0);
	check("feedback latches nothing", applyApprovalPick(latch2, "edit", 3) === "feedback" && latch2.size === 0);
	check("unknown index fails closed", applyApprovalPick(latch2, "bash", 9) === "reject" && latch2.size === 0);
	check("negative index fails closed", applyApprovalPick(latch2, "bash", -1) === "reject" && latch2.size === 0);
	check("latch is per tool", applyApprovalPick(latch2, "bash", 1) === "session" && !latch2.has("edit"));
}

// Modal keys, headless (no TTY): digits resolve positionally, arrows +
// Enter confirm, Esc/Ctrl-C/Ctrl-D reject. Mirrors the prompt.mjs
// FilterList key-feed precedent.
{
	const feed = (keys) => {
		const resolved = [];
		const list = new ApprovalList(["a", "b", "c", "d"], (o) => resolved.push(o));
		for (const k of keys) list.handleInput(k);
		return resolved;
	};
	check("digit resolves positionally", JSON.stringify(feed(["2"])) === "[1]");
	check("out-of-range digit resolves nothing", feed(["9"]).length === 0);
	check("down then enter confirms second", JSON.stringify(feed(["\x1b[B", "\r"])) === "[1]");
	check("up wraps to last", JSON.stringify(feed(["\x1b[A", "\r"])) === "[3]");
	check("raw Esc rejects", JSON.stringify(feed(["\x1b"])) === "[null]");
	check("raw Ctrl-C rejects", JSON.stringify(feed(["\x03"])) === "[null]");
	check("raw Ctrl-D rejects", JSON.stringify(feed(["\x04"])) === "[null]");
}

if (fail) { console.log(`approval: ${fail} FAIL, ${pass} pass`); process.exit(1); }
console.log("approval: all green");
