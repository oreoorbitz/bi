// bi/src/notify.ts — host-owned hub SSE subscriber (bi#44).
//
// Standing split: the host owns sockets/threads/timers; BAML owns
// notification *policy*. There is no BAML spec shaping notification text
// today, so the host also shapes the prompt-facing one-liners here
// ("peer released X", "lease expires in N", "oversight flagged Y") —
// deliberately plain string templates, no new .baml functions.
//
// Pattern is "push wakes, poll confirms": the background subscriber holds
// GET /pub/stream open and appends shaped lines to a pending-notifications
// queue; the turn loop (agent.ts) drains the queue between turns as prompt
// context. The LLM never polls — all HTTP here is host-issued.
//
// Hub contract (bais/src/hub.ts, read-only from bi/):
// - GET /pub/stream -> text/event-stream, frames `data: <json>\n\n`,
//   live-only (no replay, no `id:` fields).
// - GET /pub?since=<seq> -> {events: [{seq,type,entity,body,author,ts}]}
//   (poll-confirm after a reconnect).
// - POST /pub -> {seq} (ephemeral fan-out; the stub hub in the probe
//   also relays release-style events over the same frames).

import { get as httpGet, type ClientRequest, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";

export interface HubEvent {
	seq: number;
	type: string;
	entity: string | null;
	body: unknown;
	author: string | null;
	ts: string;
}

export interface SubscriberStats {
	received: number;
	queued: number;
	filtered: number;
	malformed: number;
	reconnects: number;
	lastSeq: number;
}

// Parse one SSE block (text between blank lines) into a HubEvent.
// Returns {kind:"event",event} for a well-formed data frame,
// {kind:"ignore"} for comments/heartbeats/empty blocks, and
// {kind:"malformed"} for data frames that are not valid hub events.
// Malformed frames are dropped by the caller and counted — they must
// never reach the prompt.
export function parseSseBlock(block: string): { kind: "ignore" } | { kind: "malformed" } | { kind: "event"; event: HubEvent } {
	const dataLines: string[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "" || line.startsWith(":")) continue; // heartbeat/comment
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
			continue;
		}
		if (/^(event|id|retry):/.test(line)) continue; // hub sends none; tolerate
		return { kind: "malformed" }; // unknown SSE field — not a hub frame
	}
	if (dataLines.length === 0) return { kind: "ignore" };
	let parsed: any;
	try {
		parsed = JSON.parse(dataLines.join("\n"));
	} catch {
		return { kind: "malformed" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
	if (typeof parsed.type !== "string" || parsed.type === "") return { kind: "malformed" };
	if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq)) return { kind: "malformed" };
	return {
		kind: "event",
		event: {
			seq: parsed.seq,
			type: parsed.type,
			entity: typeof parsed.entity === "string" ? parsed.entity : null,
			body: parsed.body ?? {},
			author: typeof parsed.author === "string" ? parsed.author : null,
			ts: typeof parsed.ts === "string" ? parsed.ts : "",
		},
	};
}

function bodyField(body: unknown, key: string): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	return (body as Record<string, unknown>)[key];
}

// Shape a validated hub event into one prompt-context line, or null when
// the event is never prompt-worthy (Heartbeat liveness).
export function shapeNotificationText(ev: HubEvent): string | null {
	if (ev.type === "Heartbeat") return null;
	const entityOf = (fallbackKeys: string[]): string | null => {
		if (ev.entity) return ev.entity;
		for (const k of fallbackKeys) {
			const v = bodyField(ev.body, k);
			if (typeof v === "string" && v !== "") return v;
		}
		return null;
	};
	if (ev.type === "LeaseRelease") {
		const task = entityOf(["lease_ref", "task"]) ?? "?";
		return `peer released ${task}`;
	}
	if (ev.type === "LeaseExpiring" || bodyField(ev.body, "expires_in") !== undefined || bodyField(ev.body, "expires_lc") !== undefined || bodyField(ev.body, "expires_in_lc") !== undefined) {
		const task = entityOf(["lease_ref", "task"]) ?? "?";
		const n = bodyField(ev.body, "expires_in") ?? bodyField(ev.body, "expires_in_lc") ?? bodyField(ev.body, "expires_lc");
		return `lease on ${task} expires in ${String(n)}`;
	}
	if (ev.type === "OversightFlag" || ev.type === "Oversight" || ev.type === "ConflictFlag") {
		const target = entityOf(["flag", "subject", "task"]) ?? "?";
		const reason = bodyField(ev.body, "reason");
		return typeof reason === "string" && reason !== "" ? `oversight flagged ${target} (${reason})` : `oversight flagged ${target}`;
	}
	return `hub ${ev.type}${ev.entity ? ` on ${ev.entity}` : ""}`;
}

// Pending-notifications queue drained by the turn loop between turns.
export class NotificationQueue {
	private lines: string[] = [];
	private stats = { received: 0, queued: 0, filtered: 0, malformed: 0 };
	readonly watch: readonly string[];

	constructor(watch: readonly string[] = []) {
		this.watch = watch;
	}

	// Shape + watch-filter + enqueue. Null-entity (global) events always pass
	// the watch filter; entity-bearing events must name a watched task when
	// a watch list is set. Returns true when a line was queued.
	pushEvent(ev: HubEvent): boolean {
		this.stats.received += 1;
		const line = shapeNotificationText(ev);
		if (line === null) {
			this.stats.filtered += 1;
			return false;
		}
		if (this.watch.length > 0 && ev.entity !== null && !this.watch.includes(ev.entity)) {
			this.stats.filtered += 1;
			return false;
		}
		this.lines.push(line);
		this.stats.queued += 1;
		return true;
	}

	countMalformed(): void {
		this.stats.malformed += 1;
	}

	drain(): string[] {
		const out = this.lines;
		this.lines = [];
		return out;
	}

	// The prompt-context block the turn loop splices in, or null when empty.
	drainContext(): string | null {
		const lines = this.drain();
		if (lines.length === 0) return null;
		return `[hub notifications]\n${lines.map((l) => `- ${l}`).join("\n")}`;
	}

	pending(): number {
		return this.lines.length;
	}

	counters(): { received: number; queued: number; filtered: number; malformed: number } {
		return { ...this.stats };
	}
}

// Structural drain the turn loop depends on — agent.ts programs against
// this interface, not the concrete queue.
export interface NotificationDrain {
	drainContext(): string | null;
}

export interface HubSubscriberOptions {
	baseUrl: string; // e.g. http://127.0.0.1:4311
	queue?: NotificationQueue;
	watch?: readonly string[];
	onStatus?: (msg: string) => void;
	retryBaseMs?: number;
	retryMaxMs?: number;
}

function getterFor(baseUrl: string): typeof httpGet {
	return new URL(baseUrl).protocol === "https:" ? (httpsGet as unknown as typeof httpGet) : httpGet;
}

// Background host SSE subscriber. Owns its socket and reconnect timers;
// surfaces nothing to the LLM — events land in the queue for the turn
// loop to drain. Reconnects resubscribe with poll-confirm
// (GET /pub?since=<lastSeq>) so events published mid-outage are not lost.
export class HubSubscriber {
	readonly queue: NotificationQueue;
	private readonly baseUrl: string;
	private readonly onStatus: ((msg: string) => void) | null;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private req: ClientRequest | null = null;
	private timer: NodeJS.Timeout | null = null;
	private stopped = true;
	private attempts = 0;
	private reconnects = 0;
	private lastSeq = -1;

	constructor(opts: HubSubscriberOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.queue = opts.queue ?? new NotificationQueue(opts.watch ?? []);
		this.onStatus = opts.onStatus ?? null;
		this.retryBaseMs = opts.retryBaseMs ?? 200;
		this.retryMaxMs = opts.retryMaxMs ?? 5000;
	}

	private status(msg: string): void {
		try {
			this.onStatus?.(msg);
		} catch {}
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attempts = 0;
		void this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const req = this.req;
		this.req = null;
		if (req) {
			await new Promise<void>((resolve) => {
				try {
					req.once("close", () => resolve());
					req.destroy();
					setTimeout(resolve, 500).unref?.();
				} catch {
					resolve();
				}
			});
		}
	}

	stats(): SubscriberStats {
		const c = this.queue.counters();
		return { ...c, reconnects: this.reconnects, lastSeq: this.lastSeq };
	}

	// Host-issued poll-confirm: fetch missed events since the cursor.
	// Returns the number of events applied to the queue.
	async confirmNow(): Promise<number> {
		const events = await this.fetchSince(this.lastSeq);
		return this.apply(events);
	}

	private apply(events: unknown): number {
		if (!Array.isArray(events)) return 0;
		let n = 0;
		for (const raw of events) {
			const parsed = parseSseBlock(`data: ${JSON.stringify(raw)}`);
			if (parsed.kind === "event") {
				this.ingest(parsed.event);
				n += 1;
			} else if (parsed.kind === "malformed") {
				this.queue.countMalformed();
			}
		}
		return n;
	}

	private ingest(ev: HubEvent): void {
		if (Number.isInteger(ev.seq) && ev.seq > this.lastSeq) this.lastSeq = ev.seq;
		this.queue.pushEvent(ev);
	}

	private fetchSince(since: number): Promise<unknown> {
		const url = `${this.baseUrl}/pub?since=${since}`;
		return new Promise((resolve, reject) => {
			const req = getterFor(this.baseUrl)(url, (res: IncomingMessage) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					try {
						const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						resolve(body?.events);
					} catch (e) {
						reject(e);
					}
				});
				res.on("error", reject);
			});
			req.on("error", reject);
			req.end();
		});
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		// Resubscribe = poll-confirm first (catch what the stream missed),
		// then hold the live stream open.
		if (this.lastSeq >= 0 || this.reconnects > 0) {
			try {
				const n = await this.confirmNow();
				this.status(`resubscribed since=${this.lastSeq} caught_up=${n}`);
			} catch (e: any) {
				this.status(`confirm failed: ${String(e?.message ?? e)}`);
			}
			if (this.stopped) return;
		}
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			let req: ClientRequest;
			try {
				req = getterFor(this.baseUrl)(`${this.baseUrl}/pub/stream`, { headers: { accept: "text/event-stream" } });
			} catch {
				this.scheduleReconnect();
				done();
				return;
			}
			this.req = req;
			req.on("response", (res: IncomingMessage) => {
				if (res.statusCode !== 200) {
					res.resume();
					this.req = null;
					this.scheduleReconnect();
					done();
					return;
				}
				this.attempts = 0; // connected — reset backoff
				this.status("stream open");
				let buf = "";
				res.on("data", (chunk: Buffer) => {
					buf += chunk.toString("utf8");
					buf = buf.replace(/\r\n/g, "\n");
					for (;;) {
						const idx = buf.indexOf("\n\n");
						if (idx === -1) break;
						const block = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const parsed = parseSseBlock(block);
						if (parsed.kind === "event") this.ingest(parsed.event);
						else if (parsed.kind === "malformed") this.queue.countMalformed();
					}
				});
				res.on("close", () => {
					this.req = null;
					// Server closed the stream (hub restart / disconnect):
					// resubscribe rather than exit.
					this.scheduleReconnect();
					done();
				});
				res.on("error", () => {
					// `close` follows and drives the reconnect.
				});
			});
			req.on("error", () => {
				this.req = null;
				this.scheduleReconnect();
				done();
			});
			req.end();
		});
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.timer) return;
		this.reconnects += 1;
		const delay = Math.min(this.retryBaseMs * 2 ** Math.min(this.attempts, 6), this.retryMaxMs);
		this.attempts += 1;
		this.status(`reconnect #${this.reconnects} in ${delay}ms`);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.connect();
		}, delay);
		if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
	}
}
