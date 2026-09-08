// bi/src/notify.ts — host-owned hub SSE subscriber (bi#44).
//
// Standing split: the host owns sockets/threads/timers; BAML owns
// notification *policy* (baml_src/notify.baml shapes the prompt-facing
// one-liners). The host only marshals validated events into plain
// string fields for the SDK shaper — no template literal here carries
// policy meaning.
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
import { shape_notification, format_terminal_notification } from "../baml_sdk/index.js";

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

// Non-empty string field of a JSON body, else null. Policy-adjacent but
// purely structural: the decision table (which keys, which templates)
// lives in notify.baml.
function strField(body: unknown, key: string): string | null {
	const v = bodyField(body, key);
	return typeof v === "string" && v !== "" ? v : null;
}

// Shape a validated hub event into one prompt-context line, or null when
// the event is never prompt-worthy (Heartbeat liveness). bi#63: the host
// only marshals — extracts plain string fields from the JSON body and
// calls the BAML decision table. No template literal here may carry
// policy meaning; byte-identity with the old TS templates is pinned by
// scripts/notify.mjs and baml test.
export function shapeNotificationText(ev: HubEvent): string | null {
	const hasExpiry =
		bodyField(ev.body, "expires_in") !== undefined ||
		bodyField(ev.body, "expires_lc") !== undefined ||
		bodyField(ev.body, "expires_in_lc") !== undefined;
	const rawExpiry = bodyField(ev.body, "expires_in") ?? bodyField(ev.body, "expires_in_lc") ?? bodyField(ev.body, "expires_lc");
	// Mirrors the old `String(n)`: strings pass through, numbers render
	// plainly, anything else JSON-shapes (nullish reads as "undefined"
	// because ?? already skipped it, exactly as before).
	const expiresText =
		rawExpiry === undefined || rawExpiry === null
			? "undefined"
			: typeof rawExpiry === "string"
				? rawExpiry
				: typeof rawExpiry === "number" || typeof rawExpiry === "boolean"
					? String(rawExpiry)
					: (JSON.stringify(rawExpiry) ?? "undefined");
	// "" reads as absent everywhere (first_present already skipped it;
	// the hub-fallback arm must too, or "" gains a trailing " on ").
	const entity = ev.entity !== "" ? ev.entity : null;
	return shape_notification(
		ev.type,
		entity,
		strField(ev.body, "lease_ref"),
		strField(ev.body, "task"),
		strField(ev.body, "flag"),
		strField(ev.body, "subject"),
		hasExpiry,
		expiresText,
		strField(ev.body, "reason"),
	);
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

// ── bi#171: user-facing terminal notifications ──────────────────────
// Split mirrors the hub half above: BAML shapes the *text* (notify.baml
// `format_terminal_notification` — sanitize + join + 240-char bound),
// the host owns the *bytes* (OSC 9 / BEL / tmux DCS) and the gates
// (enabled / unfocused / TTY). Nothing above this line changes: the
// agent-facing prompt-context lines keep their exact shape.
// Grounded in kimi-code terminal-notification.ts (read-only): OSC 9 on
// the allow-list, bare BEL elsewhere, tmux DCS wrap with ESC doubling,
// control-char sanitize, per-key dedupe with an enabled/unfocused gate.
// Two deliberate divergences: the `notifications` settings key defaults
// to unset = disabled (zero bytes, byte-identical to today), and focus
// is unknown (bi has no ?1004h tracking) so `unfocused` emits —
// page rather than stay silent when we cannot prove focus.

export const TERMINAL_ESC = "\u001B";
export const TERMINAL_BEL = "\u0007";
export const TERMINAL_ST = "\\";
export const MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH = 240;

export interface TerminalNotification {
	readonly title: string;
	readonly body?: string | undefined;
}

export interface TerminalNotifyBuildOptions {
	readonly supportsOsc9: boolean;
	readonly insideTmux: boolean;
}

export interface TerminalNotifyGate {
	readonly enabled: boolean;
	readonly condition: "unfocused" | "always";
	readonly focused?: boolean;
}

export interface TerminalNotifySink {
	readonly isTTY?: boolean;
	write(s: string): void;
}

// Allow-list mirrored from kimi: BEL is safe everywhere, OSC 9 only
// where a desktop notification is known to render (else escape garbage
// prints on screen). Kitty/Ghostty report via TERM, the rest via
// TERM_PROGRAM.
export function supportsOsc9Notification(env: NodeJS.ProcessEnv = process.env): boolean {
	const termProgram = env["TERM_PROGRAM"] ?? "";
	if (
		termProgram === "iTerm.app" ||
		termProgram === "WezTerm" ||
		termProgram === "ghostty" ||
		termProgram === "WarpTerminal"
	) {
		return true;
	}
	const term = env["TERM"] ?? "";
	if (term === "xterm-kitty" || term === "xterm-ghostty") return true;
	return false;
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	const tmux = env["TMUX"] ?? "";
	return tmux.length > 0;
}

// BAML-shaped text: sanitize + "title: body" + 240-char bound. All user
// text (model output, session paths) crosses this before bytes exist.
export function formatTerminalNotification(title: string, body?: string): string {
	return format_terminal_notification(title, body ?? null);
}

// Pure sequence builder (kimi's buildTerminalNotificationSequences).
// Takes BAML-shaped text, never raw user input: BEL/ESC were stripped
// at shaping time so the payload cannot forge or escape the OSC.
// - supportsOsc9: single OSC 9 desktop-notification sequence.
// - else: bare BEL (single byte, passes through tmux unchanged).
// - insideTmux + OSC 9: tmux DCS passthrough with ESC doubling, else
//   tmux swallows the OSC.
export function buildTerminalNotificationSequences(
	message: string,
	options: TerminalNotifyBuildOptions,
): string[] {
	if (message.length === 0) return [];
	if (!options.supportsOsc9) {
		return [TERMINAL_BEL];
	}
	const osc9 = `${TERMINAL_ESC}]9;${message}${TERMINAL_BEL}`;
	if (options.insideTmux) {
		const escaped = osc9.split(TERMINAL_ESC).join(TERMINAL_ESC + TERMINAL_ESC);
		return [`${TERMINAL_ESC}Ptmux;${escaped}${TERMINAL_ESC}${TERMINAL_ST}`];
	}
	return [osc9];
}

// `notifications` settings key → gate. Unset, "off", or anything the
// validator would reject resolves disabled: a typo'd value fails
// silent (zero bytes), never blasts escapes at the terminal.
export function terminalNotifyGate(setting: string | null | undefined): TerminalNotifyGate {
	if (setting === "always") return { enabled: true, condition: "always" };
	if (setting === "unfocused") return { enabled: true, condition: "unfocused" };
	return { enabled: false, condition: "unfocused" };
}

// Per-key dedupe + gate + TTY sink. Returns true only when bytes were
// written. Pipes and non-TTY sessions emit nothing (the sink's isTTY
// is the check — default stream is stderr, where bi writes turns).
export class TerminalNotifier {
	private seen = new Set<string>();

	notifyOnce(
		key: string,
		notification: TerminalNotification,
		gate: TerminalNotifyGate,
		opts: {
			supportsOsc9?: boolean;
			insideTmux?: boolean;
			focused?: boolean;
			stream?: TerminalNotifySink;
		} = {},
	): boolean {
		if (!gate.enabled) return false;
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		if (gate.condition === "unfocused" && (opts.focused ?? gate.focused ?? false)) return false;
		const stream = opts.stream ?? process.stderr;
		if (!stream.isTTY) return false;
		const message = formatTerminalNotification(notification.title, notification.body);
		const sequences = buildTerminalNotificationSequences(message, {
			supportsOsc9: opts.supportsOsc9 ?? supportsOsc9Notification(),
			insideTmux: opts.insideTmux ?? isInsideTmux(),
		});
		for (const seq of sequences) stream.write(seq);
		return sequences.length > 0;
	}
}

// Exactly-once turn-complete page ("bi turn complete"). Keyed per
// session + turn: /new and /resume reset the counter, so a bare turn
// number would dedupe a fresh session's early turns into silence.
export function notifyTurnComplete(
	notifier: TerminalNotifier,
	turn: number,
	opts: {
		session?: string;
		setting?: string | null;
		focused?: boolean;
		supportsOsc9?: boolean;
		insideTmux?: boolean;
		stream?: TerminalNotifySink;
	} = {},
): boolean {
	return notifier.notifyOnce(
		`turn:${opts.session ?? "-"}:${turn}`,
		{ title: "bi turn complete" },
		terminalNotifyGate(opts.setting ?? null),
		opts,
	);
}

// Approval-reuse helper (per-tool approval issue): same OSC/tmux logic
// under an `approval:<id>` key. Not wired to any prompt yet — exported
// so the approval surface reuses it without duplicating bytes.
export function notifyApprovalRequired(
	notifier: TerminalNotifier,
	id: string,
	toolName: string,
	opts: {
		setting?: string | null;
		focused?: boolean;
		supportsOsc9?: boolean;
		insideTmux?: boolean;
		stream?: TerminalNotifySink;
	} = {},
): boolean {
	return notifier.notifyOnce(
		`approval:${id}`,
		{ title: "bi approval required", body: toolName },
		terminalNotifyGate(opts.setting ?? null),
		opts,
	);
}
