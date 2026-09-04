// /tmp/probe-bi44.mjs — offline stub-hub probe for bi#44 (plain node, no network).
// Stub hub mimics the bais hub pub contract: POST /pub, GET /pub?since=,
// GET /pub/stream (SSE `data: <json>\n\n`, live-only). Plus /test/* hooks.
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(fileURLToPath(import.meta.url));
const { HubSubscriber, NotificationQueue, shapeNotificationText } = await import(join(ROOT, "..", "dist", "src", "notify.js"));
const { runAgent } = await import(join(ROOT, "..", "dist", "src", "agent.js"));

let seq = 0;
const ring = [];
const streams = new Set();

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	if (req.method === "POST" && url.pathname === "/pub") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const b = JSON.parse(body);
			const msg = { seq: seq++, type: b.type, entity: b.entity ?? null, body: b.body ?? {}, author: b.author ?? null, ts: new Date().toISOString() };
			ring.push(msg);
			const line = `data: ${JSON.stringify(msg)}\n\n`;
			for (const c of streams) c.write(line);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ seq: msg.seq }));
		});
		return;
	}
	if (req.method === "GET" && url.pathname === "/pub") {
		const since = Number(url.searchParams.get("since") ?? "-1");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ events: ring.filter((m) => m.seq > since) }));
		return;
	}
	if (req.method === "GET" && url.pathname === "/pub/stream") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		streams.add(res);
		res.on("close", () => streams.delete(res));
		return;
	}
	if (req.method === "POST" && url.pathname === "/test/kill-streams") {
		for (const c of streams) c.destroy();
		streams.clear();
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
		return;
	}
	if (req.method === "POST" && url.pathname === "/test/garbage") {
		for (const c of streams) {
			c.write(`data: not-json{{\n\n`);
			c.write(`data: {"nope":true}\n\n`);
			c.write(`bogus-field: x\n\n`);
			c.write(`: ping\n\n`);
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
		return;
	}
	res.writeHead(404);
	res.end("{}");
});

function post(port, path, obj) {
	return new Promise((resolve, reject) => {
		const data = obj === undefined ? "" : JSON.stringify(obj);
		const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks).toString()));
		});
		req.on("error", reject);
		req.end(data);
	});
}

async function waitFor(cond, ms, label) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timeout: ${label}`);
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// --- shaping unit checks (host-side text, no new .baml fns) ---
check("shape release", shapeNotificationText({ seq: 0, type: "LeaseRelease", entity: "bi#44", body: {}, author: "peer", ts: "" }) === "peer released bi#44");
check("shape expiry", shapeNotificationText({ seq: 0, type: "LeaseExpiring", entity: "bi#45", body: { expires_in: 7 }, author: null, ts: "" }) === "lease on bi#45 expires in 7");
check("shape oversight", (shapeNotificationText({ seq: 0, type: "OversightFlag", entity: "bi#46", body: { reason: "conflict" }, author: null, ts: "" }) ?? "").startsWith("oversight flagged bi#46"));
check("heartbeat never queued", shapeNotificationText({ seq: 0, type: "Heartbeat", entity: null, body: {}, author: null, ts: "" }) === null);

// --- live subscription: release appears in next turn, zero LLM polls ---
const queue = new NotificationQueue(["bi#44"]);
const sub = new HubSubscriber({ baseUrl: base, queue, retryBaseMs: 50, retryMaxMs: 500 });
sub.start();

let toolCalls = 0;
const seen = [];
const fakeLlm = async (text) => {
	seen.push(text);
	return { tool_uses: () => [], terminal_text: () => "done" };
};

await runAgent("work on bi#44", { tools: [], toolHandler: async () => { toolCalls++; return "x"; }, llmFn: fakeLlm, notify: queue });
check("turn1 clean (no premature context)", !seen[0].includes("peer released"));

await post(port, "/pub", { type: "LeaseRelease", entity: "bi#44", author: "peer-1", body: { lease_ref: "hub:claim:3" } });
await waitFor(() => queue.pending() > 0, 3000, "release queued via SSE push");
await runAgent("continue", { history: [], tools: [], toolHandler: async () => { toolCalls++; return "x"; }, llmFn: fakeLlm, notify: queue });
check("release visible in next-turn context", seen[seen.length - 1].includes("peer released bi#44"), JSON.stringify(seen[seen.length - 1].slice(-120)));
check("zero LLM-issued polls", toolCalls === 0, `toolCalls=${toolCalls}`);

// --- disconnect + reconnect resubscribes (poll-confirm catches misses) ---
const before = sub.stats().reconnects;
await post(port, "/test/kill-streams");
await post(port, "/pub", { type: "LeaseRelease", entity: "bi#44", author: "peer-2", body: {} });
await post(port, "/pub", { type: "OversightFlag", entity: "bi#44", author: "hub", body: { reason: "lease-conflict" } });
await waitFor(() => queue.pending() >= 2, 5000, "missed events caught up after resubscribe");
check("reconnect happened", sub.stats().reconnects > before, `reconnects=${sub.stats().reconnects}`);
const ctx = queue.drainContext() ?? "";
check("missed release caught via poll-confirm", ctx.includes("peer released bi#44"));
check("missed oversight caught via poll-confirm", ctx.includes("oversight flagged bi#44"));

// --- malformed frames dropped + counted, never in prompt ---
const q0 = queue.counters();
await post(port, "/test/garbage");
await waitFor(() => queue.counters().malformed >= q0.malformed + 3, 3000, "malformed counted");
const c1 = queue.counters();
check("malformed dropped+counted", c1.malformed >= q0.malformed + 3, `malformed=${c1.malformed}`);
check("malformed never queued", c1.queued === q0.queued, `queued ${q0.queued}->${c1.queued}`);
const rest = queue.drainContext();
check("malformed never reach prompt", rest === null || (!rest.includes("not-json") && !rest.includes("nope")), JSON.stringify(rest));

await sub.stop();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PROBE ALL PASS" : `PROBE ${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
