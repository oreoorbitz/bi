// bi/scripts/meta-tools.mjs — hub#207 meta-tools conformance drill.
// Drives the REAL tools module (mineMetaTools / materializeMetaTool) over
// literal session traces and asserts the acceptance clauses: (1) a
// recurring tool-call sequence is mined ONCE, not per occurrence, (2) a
// proposal carries no flip_gate evidence out of the miner, (3) THE GATE:
// materialization refuses without hub#200 flip-gate evidence — named
// reason, no spec, (4) Reject/NoOp evidence refuses too, (5) a real
// flip-gate Accept materializes a MetaToolSpec that is plain data (JSON
// round-trip identical — no handles, no class behavior, FFI-safe).
//
// Module resolution: dist by convention (like every suite here); set
// BI_META_TOOLS_UNDER_TEST to drive a scratch source path instead.
//
// bi#57 red-check record (materialization gate):
//   hunk: gate_meta_tool_materialization's `null => MaterializeRefuse { … }`
//         arm in baml_src/meta_tools.baml — neutered to materialize a spec
//         with no evidence present
//         (baml generate --project bi && npm run build --prefix bi after
//         each edit)
//   expected reason: a proposal that never ran the hub#200 flip-gate on
//     its claimed drill arms must never become a tool — evidence presence
//     is ground truth, not the proposal's self-description
//   observed: with the arm reverted, this drill FAILs as
//     "FAIL: materialization gate holds: proposal without flip_gate
//     evidence refuses (gate bypassed — no-evidence proposal
//     materialized)"; restored, `node bi/scripts/meta-tools.mjs` prints
//     all ok, 0 failures.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MOD = process.env.BI_META_TOOLS_UNDER_TEST ?? join(ROOT, "..", "dist", "src", "tools.js");
const T = await import(MOD);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const trace = (session_id, parent_session, tool_calls) => ({ session_id, parent_session, tool_calls });

// (1)+(2) mining: [read, grep, edit] recurs in two sessions — twice in
// the first — and is detected exactly once, with null evidence.
let proposal;
{
	const sessions = [
		trace("s1", null, ["read", "grep", "edit", "bash", "read", "grep", "edit"]),
		trace("s2", "s1", ["ls", "read", "grep", "edit", "write"]),
		trace("s3", null, ["ls", "bash"]), // non-recurring tail — no proposal
	];
	const proposals = await T.mineMetaTools(sessions);
	check(proposals.length === 1, `recurring sequence mined once, not per occurrence (got ${proposals.length})`);
	proposal = proposals[0];
	check(proposal.name === "meta_read_grep_edit", `derived name (got ${proposal.name})`);
	check(proposal.sequence.join(",") === "read,grep,edit", "sequence is the maximal recurring pattern");
	check(proposal.support === 2 && proposal.session_ids.join(",") === "s1,s2", "support counts distinct sessions");
	check(proposal.evidence === null, "mined proposals carry no flip_gate evidence");
}

// (3) THE GATE: no evidence → refusal naming the reason, no spec. This is
// the bi#57 red-check case named in the header — with the null arm
// reverted, the spec MATERIALIZES here and the check fails as "gate
// bypassed".
{
	let spec = null;
	let reason = null;
	try {
		spec = await T.materializeMetaTool(proposal);
	} catch (e) {
		reason = e?.message ?? "";
	}
	check(
		spec === null && /no_flip_gate_evidence/.test(reason),
		"materialization gate holds: proposal without flip_gate evidence refuses (gate bypassed — no-evidence proposal materialized)",
	);
}

// (4) Reject and NoOp evidence refuse, named.
{
	for (const verdict of ["Reject", "NoOp"]) {
		let spec = null;
		let reason = null;
		try {
			spec = await T.materializeMetaTool({
				...proposal,
				evidence: { verdict, drill_arm_ids: ["arm-1"], flipped_green: [], gate_run_id: "drill 2026-09-08" },
			});
		} catch (e) {
			reason = e?.message ?? "";
		}
		check(spec === null && /flip_gate_not_accept/.test(reason), `${verdict} evidence refuses, named`);
	}
}

// (5) a real flip-gate Accept materializes a plain-data spec.
{
	const gated = { ...proposal, evidence: {
		verdict: "Accept",
		drill_arm_ids: ["arm-1", "arm-2"],
		flipped_green: ["arm-1"],
		gate_run_id: "node bits/scripts/flip-gate.mjs prop#02 2026-09-08",
	} };
	const spec = await T.materializeMetaTool(gated);
	check(spec.name === "meta_read_grep_edit", "Accept materializes the spec");
	check(spec.sequence.join(",") === "read,grep,edit", "spec carries the sequence");
	check(/flip-gate/.test(spec.description), "spec description cites the gate run");
	const roundTrip = JSON.parse(JSON.stringify(spec));
	check(
		roundTrip.name === spec.name
			&& roundTrip.description === spec.description
			&& roundTrip.sequence.join(",") === "read,grep,edit"
			&& Object.keys(roundTrip).sort().join(",") === "description,name,sequence",
		"MetaToolSpec is plain data across the FFI boundary (JSON round-trip identical, no extra keys)",
	);
}

console.log(failures ? `\n${failures} FAILURES` : "\nall meta-tools checks passed");
process.exit(failures ? 1 : 0);
