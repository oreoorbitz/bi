// bi/src/keeper.ts — host-owned lease-keeper (bi#43).
//
// Standing split: the host owns timers + renew calls (execution); BAML
// owns admit/deny (ns_event/lease.baml — the hub already reduces every
// claim/renew/release through the reference reducer and answers 409 on
// deny). The LLM never manages renewals — it would forget, and a
// forgotten renew is a lost task. So this module holds no LLM handles:
// the background timer renews the held lease on a wall-clock interval,
// and the turn loop (agent.ts) only observes the keeper's named error.
//
// Fencing (lease.baml): the fencing token is the winning claim's lc,
// echoed exactly on every transition/submit while the lease is active,
// else `stale-fence`. The keeper owns the token after a successful claim
// and stamps it via stamp(); it never invents one.
//
// Expiry (bi#42, lc semantics, read-only from bi/): a lease is active
// while expires_lc > max admitted lc; renew extends expiry by the
// lease's own ttl, holder-only. The keeper cannot see the hub's lc, so
// it renews wall-clock-often and treats a hub deny (404/409) as the
// source of truth that the lease is gone: it stops the timer and
// surfaces a LeaseLostError. Transient hub faults (network, 5xx, 503)
// do NOT kill the keeper — it retries on the next tick.

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

// Named error surfaced to the turn loop when the lease is revoked or
// expired. `name` is fixed so callers can match without instanceof.
export class LeaseLostError extends Error {
	readonly leaseRef: string;
	readonly reason: string;
	constructor(leaseRef: string, reason: string) {
		super(`lease lost (${leaseRef}): ${reason}`);
		this.name = "LeaseLostError";
		this.leaseRef = leaseRef;
		this.reason = reason;
	}
}

// Hub deny / transport fault from a keeper-issued call. Terminal denys
// (unknown-lease, not-current, not-holder, retry-budget-exhausted,
// cap-denied, lease-held ...) stop the keeper; anything else retries.
export class HubLeaseError extends Error {
	readonly status: number;
	readonly reason: string;
	constructor(status: number, reason: string, detail?: string) {
		super(detail ? `hub ${status} ${reason}: ${detail}` : `hub ${status} ${reason}`);
		this.name = "HubLeaseError";
		this.status = status;
		this.reason = reason;
	}
}

// Structural lease state the turn loop depends on — agent.ts programs
// against this interface, not the concrete keeper (mirrors notify.ts
// NotificationDrain).
export interface LeaseDrain {
	leaseError(): LeaseLostError | null;
}

// Minimal hub surface the keeper needs (hub.ts endpoints, read-only).
export interface KeeperHub {
	claim(task: string, holder: string, ttl: number, epoch: number, idem: string): Promise<{ lease_id: string; fencing: number; expires_lc: number }>;
	renew(leaseRef: string, holder: string): Promise<{ expires_lc: number }>;
	release(leaseRef: string, holder: string): Promise<void>;
}

function postJson(baseUrl: string, path: string, body: Record<string, unknown>): Promise<any> {
	const url = new URL(path, baseUrl.replace(/\/$/, "") + "/");
	const payload = JSON.stringify(body);
	const request = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		let req: ClientRequest;
		try {
			req = request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
		} catch (e: any) {
			reject(new HubLeaseError(0, "network", String(e?.message ?? e)));
			return;
		}
		req.on("error", (e) => reject(new HubLeaseError(0, "network", String((e as Error)?.message ?? e))));
		req.on("response", (res: IncomingMessage) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				let parsed: any = null;
				try {
					parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					parsed = null;
				}
				const status = res.statusCode ?? 500;
				if (status >= 400) {
					const reason = typeof parsed?.reason === "string" ? parsed.reason
						: typeof parsed?.error === "string" ? parsed.error
						: "denied";
					reject(new HubLeaseError(status, reason));
					return;
				}
				resolve(parsed);
			});
			res.on("error", (e) => reject(new HubLeaseError(0, "network", String((e as Error)?.message ?? e))));
		});
		req.end(payload);
	});
}

// HTTP KeeperHub over the hub.ts coordinator endpoints:
// POST /claim {task,holder,ttl,epoch,idem}, POST /renew {lease_ref,holder},
// POST /release {lease_ref,holder}.
export class HttpKeeperHub implements KeeperHub {
	readonly baseUrl: string;
	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}
	async claim(task: string, holder: string, ttl: number, epoch: number, idem: string): Promise<{ lease_id: string; fencing: number; expires_lc: number }> {
		const res = await postJson(this.baseUrl, "/claim", { task, holder, ttl, epoch, idem });
		if (typeof res?.lease_id !== "string" || typeof res?.fencing !== "number") {
			throw new HubLeaseError(200, "malformed-claim");
		}
		return { lease_id: res.lease_id, fencing: res.fencing, expires_lc: res.expires_lc ?? -1 };
	}
	async renew(leaseRef: string, holder: string): Promise<{ expires_lc: number }> {
		const res = await postJson(this.baseUrl, "/renew", { lease_ref: leaseRef, holder });
		return { expires_lc: typeof res?.expires_lc === "number" ? res.expires_lc : -1 };
	}
	async release(leaseRef: string, holder: string): Promise<void> {
		await postJson(this.baseUrl, "/release", { lease_ref: leaseRef, holder });
	}
}

export interface LeaseKeeperOptions {
	hub: KeeperHub;
	task: string;
	holder: string;
	ttl: number;
	epoch?: number;
	idem?: string;
	// Wall-clock spacing between renew calls. The hub owns expiry policy;
	// frequent renews are harmless (an active holder renew always admits).
	renewIntervalMs?: number;
	onStatus?: (msg: string) => void;
	onRenew?: (expiresLc: number) => void;
	onLost?: (err: LeaseLostError) => void;
}

// A deny the keeper must not retry: the lease is gone or can never be
// renewed by us. Everything else (network, 5xx, 503 backfill-pending,
// 402/429 budgets) is transient — the next tick retries.
function terminalReason(status: number, reason: string): boolean {
	if (status === 404) return true; // unknown-lease
	if (status === 403) return true; // cap-denied
	if (status === 400) return true; // malformed call — retrying is pointless
	if (status !== 409) return false;
	return reason !== "frozen" && reason !== "backfill-pending";
}

let idemCounter = 0;

export class LeaseKeeper implements LeaseDrain {
	readonly task: string;
	readonly holder: string;
	readonly ttl: number;
	private readonly hub: KeeperHub;
	private readonly epoch: number;
	private readonly idem: string;
	private readonly intervalMs: number;
	private readonly onStatus: ((msg: string) => void) | null;
	private readonly onRenew: ((expiresLc: number) => void) | null;
	private readonly onLost: ((err: LeaseLostError) => void) | null;
	private timer: NodeJS.Timeout | null = null;
	private renewing = false;
	private leaseId: string | null = null;
	private fencingToken: number | null = null;
	private expiresLc = -1;
	private lost: LeaseLostError | null = null;
	private renews = 0;

	constructor(opts: LeaseKeeperOptions) {
		this.hub = opts.hub;
		this.task = opts.task;
		this.holder = opts.holder;
		this.ttl = opts.ttl;
		this.epoch = opts.epoch ?? 0;
		this.idem = opts.idem ?? `bi-keeper-${Date.now().toString(36)}-${(idemCounter += 1)}`;
		this.intervalMs = opts.renewIntervalMs ?? 1000;
		this.onStatus = opts.onStatus ?? null;
		this.onRenew = opts.onRenew ?? null;
		this.onLost = opts.onLost ?? null;
	}

	private status(msg: string): void {
		try {
			this.onStatus?.(msg);
		} catch {}
	}

	// Claim the lease (winning claim's lc becomes the fencing token) and
	// start the background renew timer. Idempotent: a held lease is not
	// re-claimed.
	async acquire(): Promise<{ lease_id: string; fencing: number; expires_lc: number }> {
		if (this.leaseId !== null) {
			return { lease_id: this.leaseId, fencing: this.fencingToken ?? -1, expires_lc: this.expiresLc };
		}
		if (this.lost) throw this.lost;
		const res = await this.hub.claim(this.task, this.holder, this.ttl, this.epoch, this.idem);
		this.leaseId = res.lease_id;
		this.fencingToken = res.fencing;
		this.expiresLc = res.expires_lc;
		this.status(`lease held: ${res.lease_id} fencing=${res.fencing}`);
		this.schedule();
		return res;
	}

	// One renew cycle now (the timer calls this; tests/probes call it to
	// avoid sleeping). Success extends the known expiry; a terminal deny
	// stops the keeper with a LeaseLostError; transient faults are logged
	// and retried on the next tick.
	async renewNow(): Promise<boolean> {
		if (this.leaseId === null || this.lost || this.renewing) return false;
		this.renewing = true;
		try {
			const res = await this.hub.renew(this.leaseId, this.holder);
			this.expiresLc = res.expires_lc;
			this.renews += 1;
			try {
				this.onRenew?.(res.expires_lc);
			} catch {}
			return true;
		} catch (e: any) {
			const reason = e instanceof HubLeaseError ? e.reason : "network";
			const terminal = e instanceof HubLeaseError ? terminalReason(e.status, e.reason) : false;
			if (terminal) {
				this.fail(new LeaseLostError(this.leaseId, reason));
			} else {
				this.status(`renew failed (transient): ${String(e?.message ?? e)}`);
			}
			return false;
		} finally {
			this.renewing = false;
		}
	}

	// Release the lease (holder wind-down) and stop the timer. A release
	// is a deliberate free, not a loss — leaseError() stays null.
	async release(): Promise<void> {
		this.unschedule();
		const ref = this.leaseId;
		this.leaseId = null;
		this.fencingToken = null;
		if (ref === null) return;
		try {
			await this.hub.release(ref, this.holder);
			this.status(`lease released: ${ref}`);
		} catch (e: any) {
			this.status(`release failed: ${String(e?.message ?? e)}`);
		}
	}

	stop(): void {
		this.unschedule();
	}

	// Turn-loop observation: the named error, or null while held/healthy.
	leaseError(): LeaseLostError | null {
		return this.lost;
	}

	held(): boolean {
		return this.leaseId !== null && this.lost === null;
	}

	leaseRef(): string | null {
		return this.leaseId;
	}

	// The winning claim's lc — echo on every transition/submit while held.
	fencing(): number {
		this.requireHeld();
		return this.fencingToken ?? -1;
	}

	// Stamp a transition/submit body with the fencing token. Throws
	// LeaseLostError when the lease is gone: zombie writes never leave
	// the host with a live-looking token (the hub would 409 stale-fence
	// them anyway — this fails fast, before the write).
	stamp<T extends Record<string, unknown>>(body: T): T & { fencing: number } {
		return { ...body, fencing: this.fencing() };
	}

	requireHeld(): void {
		if (this.lost) throw this.lost;
		if (this.leaseId === null) throw new LeaseLostError("(unheld)", "no-lease");
	}

	stats(): { renews: number; expiresLc: number; fencing: number | null; lost: string | null } {
		return { renews: this.renews, expiresLc: this.expiresLc, fencing: this.fencingToken, lost: this.lost?.reason ?? null };
	}

	private fail(err: LeaseLostError): void {
		if (this.lost) return;
		this.lost = err;
		this.unschedule();
		this.status(`keeper stopped: ${err.message}`);
		try {
			this.onLost?.(err);
		} catch {}
	}

	private schedule(): void {
		if (this.timer || this.lost || this.leaseId === null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.renewNow().then(() => this.schedule());
		}, this.intervalMs);
		if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
	}

	private unschedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
