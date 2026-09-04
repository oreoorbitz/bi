// Offline stub hub for the bi#43 probe — implements the lease.baml
// admit/deny rules that matter here (lc clock, holder-only renew,
// fencing = winning claim's lc, exact-echo gate). Test-only /__
// endpoints drive revocation and clock ticks. Plain node, no deps.
import { createServer } from "node:http";

let lc = 100;
const leases = new Map(); // lease_id -> {entity, holder, fencing, ttl, expires_lc, status}

function currentLease(entity) {
	let out = null;
	for (const l of leases.values()) {
		if (l.entity === entity && l.status === "active" && l.expires_lc > lc) out = l;
	}
	return out;
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

function send(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	try {
		if (req.method === "POST" && url.pathname === "/claim") {
			const b = await readJson(req);
			lc += 1;
			const cur = currentLease(b.task);
			if (cur && cur.holder !== b.holder) {
				send(res, 409, { reason: `lease-held: ${cur.holder}` });
				return;
			}
			const id = `stub:claim:${lc}`;
			leases.set(id, { entity: b.task, holder: b.holder, fencing: lc, ttl: b.ttl, expires_lc: lc + b.ttl, status: "active" });
			send(res, 200, { lease_id: id, task: b.task, holder: b.holder, fencing: lc, expires_lc: lc + b.ttl });
			return;
		}
		if (req.method === "POST" && url.pathname === "/renew") {
			const b = await readJson(req);
			lc += 1;
			const l = leases.get(b.lease_ref);
			if (!l) {
				send(res, 404, { reason: "unknown-lease" });
				return;
			}
			if (l.holder !== b.holder) {
				send(res, 409, { reason: "not-holder" });
				return;
			}
			if (l.status !== "active" || l.expires_lc <= lc) {
				send(res, 409, { reason: "not-current" });
				return;
			}
			l.expires_lc = lc + l.ttl;
			send(res, 200, { lease_id: b.lease_ref, expires_lc: l.expires_lc });
			return;
		}
		if (req.method === "POST" && url.pathname === "/release") {
			const b = await readJson(req);
			lc += 1;
			const l = leases.get(b.lease_ref);
			if (!l) {
				send(res, 404, { reason: "unknown-lease" });
				return;
			}
			if (l.holder !== b.holder) {
				send(res, 409, { reason: "not-holder" });
				return;
			}
			l.status = "released";
			send(res, 200, { lease_id: b.lease_ref, status: "released" });
			return;
		}
		if (req.method === "POST" && url.pathname === "/submit") {
			// TaskTransition/WorkSubmit fencing gate (lease_fence_ok).
			const b = await readJson(req);
			lc += 1;
			const cur = currentLease(b.task);
			if (!cur) {
				send(res, 200, { ok: true, note: "no active lease — open" });
				return;
			}
			if (b.fencing !== cur.fencing) {
				send(res, 409, { reason: "stale-fence" });
				return;
			}
			send(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/__revoke") {
			// Test-only: peer-side revoke — mark released out from under us.
			const b = await readJson(req);
			const l = leases.get(b.lease_ref);
			if (!l) {
				send(res, 404, { reason: "unknown-lease" });
				return;
			}
			l.status = "released";
			send(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/__tick") {
			const b = await readJson(req);
			lc += Number(b.n ?? 1);
			send(res, 200, { lc });
			return;
		}
		if (req.method === "GET" && url.pathname === "/__state") {
			send(res, 200, { lc, leases: [...leases.values()] });
			return;
		}
		send(res, 404, { reason: "no-route" });
	} catch (e) {
		send(res, 500, { reason: "stub-crash", detail: String(e?.message ?? e) });
	}
});

const port = Number(process.argv[2] ?? 0);
server.listen(port, "127.0.0.1", () => {
	const addr = server.address();
	console.log(`stub-hub listening ${typeof addr === "object" && addr ? addr.port : port}`);
});
