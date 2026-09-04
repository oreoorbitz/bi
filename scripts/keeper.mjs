// Offline bi#43 probe — plain node against the stub hub + compiled
// bi/dist/src/keeper.js. No LLM anywhere in phases 1-3 (keeper-only);
// phase 2b runs runAgent with a canned llmFn to prove the named error
// reaches the turn loop before any LLM call.
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(fileURLToPath(import.meta.url));
const BI = join(ROOT, "..", "dist", "src");
const { LeaseKeeper, HttpKeeperHub, LeaseLostError } = await import(`${BI}/keeper.js`);
const { runAgent, createTextTurn } = await import(`${BI}/agent.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}
async function post(base, path, body) {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let parsed = null;
	try {
		parsed = await res.json();
	} catch {}
	return { status: res.status, body: parsed };
}

// --- stub hub on a random port ---
const child = spawn("node", [join(ROOT, "stub-hub.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("stub never listened")), 5000);
	child.stdout.on("data", (d) => {
		const m = String(d).match(/listening (\d+)/);
		if (m) {
			clearTimeout(timer);
			resolve(Number(m[1]));
		}
	});
	child.on("error", reject);
});
const base = `http://127.0.0.1:${port}`;
console.log(`stub hub: ${base}`);

try {
	// Phase 1: held task stays held across multiple ttls, zero LLM.
	const hub = new HttpKeeperHub(base);
	const keeper = new LeaseKeeper({ hub, task: "task:A", holder: "did:key:alice", ttl: 5, renewIntervalMs: 50 });
	const claimed = await keeper.acquire();
	check("1a claim returns fencing token", typeof claimed.fencing === "number", `fencing=${claimed.fencing}`);
	const renewsBefore = keeper.stats().renews;
	await sleep(400); // ~8 renew ticks, ttl=5lc — multiple renew generations
	const stats = keeper.stats();
	check("1b auto-renewed across multiple ttls", stats.renews >= renewsBefore + 3, `renews=${stats.renews}`);
	check("1c still held, no LLM involved", keeper.held() && keeper.leaseError() === null);
	check("1d fencing token stable", keeper.fencing() === claimed.fencing);
	check("1e stamp echoes token", keeper.stamp({ to: "Doing" }).fencing === claimed.fencing);
	// A fenced submit while held admits.
	const okSubmit = await post(base, "/submit", keeper.stamp({ task: "task:A", to: "Doing" }));
	check("1f fenced submit admitted while held", okSubmit.status === 200, `status=${okSubmit.status}`);
	await keeper.release();

	// Phase 2: revoked lease stops keeper with named error.
	const k2 = new LeaseKeeper({ hub, task: "task:B", holder: "did:key:alice", ttl: 100, renewIntervalMs: 50 });
	await k2.acquire();
	await post(base, "/__revoke", { lease_ref: k2.leaseRef() }); // peer-side revoke
	await sleep(200); // let the renew timer hit the deny
	const err = k2.leaseError();
	check("2a keeper stopped after revoke", k2.held() === false && err !== null);
	check("2b named LeaseLostError", err instanceof LeaseLostError && err.name === "LeaseLostError", `name=${err?.name} reason=${err?.reason}`);
	check("2c timer halted (no further renews)", await (async () => {
		const n = k2.stats().renews;
		await sleep(150);
		return k2.stats().renews === n;
	})());

	// Phase 2b: named error surfaces to the turn loop before any LLM call.
	let llmCalls = 0;
	const result = await runAgent("do work", {
		model: "claude-haiku-4-5",
		provider: "anthropic",
		maxTurns: 3,
		keeper: k2,
		llmFn: async () => {
			llmCalls += 1;
			return createTextTurn("done");
		},
	});
	check("2d turn loop fails lease_lost", result.failure?.kind === "lease_lost", `kind=${result.failure?.kind}`);
	check("2e zero LLM calls after loss", llmCalls === 0, `llmCalls=${llmCalls}`);

	// Phase 2c: healthy keeper does not disturb the loop.
	const k3 = new LeaseKeeper({ hub, task: "task:C", holder: "did:key:alice", ttl: 100, renewIntervalMs: 50 });
	await k3.acquire();
	let okCalls = 0;
	const ok = await runAgent("do work", {
		model: "claude-haiku-4-5",
		provider: "anthropic",
		maxTurns: 2,
		keeper: k3,
		llmFn: async () => {
			okCalls += 1;
			return createTextTurn("done");
		},
	});
	check("2f healthy keeper: loop completes", ok.failure === undefined && okCalls === 1);
	await k3.release();

	// Phase 3: zombie writes after expiry rejected on fencing.
	const k4 = new LeaseKeeper({ hub, task: "task:D", holder: "did:key:alice", ttl: 3, renewIntervalMs: 60000 });
	const old = await k4.acquire();
	const oldFence = old.fencing;
	k4.stop(); // holder goes quiet — no renews
	const bobBlocked = await post(base, "/claim", { task: "task:D", holder: "did:key:bob", ttl: 50, epoch: 0, idem: "bob1" });
	check("3a competing claim blocked while held", bobBlocked.status === 409, `status=${bobBlocked.status}`);
	await post(base, "/__tick", { n: 5 }); // quiet log advances past expires_lc
	const renewed = await k4.renewNow(); // holder's late renew
	check("3b late renew denied (not-current)", renewed === false && k4.leaseError()?.reason === "not-current", `reason=${k4.leaseError()?.reason}`);
	const bob = await post(base, "/claim", { task: "task:D", holder: "did:key:bob", ttl: 50, epoch: 0, idem: "bob1" });
	check("3c task claimable after expiry", bob.status === 200, `status=${bob.status}`);
	const zombie = await post(base, "/submit", { task: "task:D", to: "Doing", fencing: oldFence });
	check("3d zombie write with stale fencing rejected", zombie.status === 409 && zombie.body?.reason === "stale-fence", `status=${zombie.status} reason=${zombie.body?.reason}`);
	const fresh = await post(base, "/submit", { task: "task:D", to: "Doing", fencing: bob.body?.fencing });
	check("3e current fencing still admitted", fresh.status === 200, `status=${fresh.status}`);
	let threw = false;
	try {
		k4.stamp({ to: "Doing" });
	} catch (e) {
		threw = e instanceof LeaseLostError && e.name === "LeaseLostError";
	}
	check("3f host refuses to stamp after loss", threw);
} finally {
	child.kill();
}

console.log(failures === 0 ? "\nALL PROBE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
