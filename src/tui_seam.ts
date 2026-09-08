// bi/src/tui_seam.ts — bi#188 host adapter for the Go Bubble Tea shell
// (bi/tui-go, bi#187). ONE module owns every byte that crosses the seam:
// the six UI event channels run as newline-delimited JSON-RPC 2.0 to the
// Go child process over stdio (the child renders on /dev/tty; stdio is
// the seam). BAML keeps owning content shaping — render_footer_frame /
// format_tool_* / chunk_stream_text outputs cross as plain data payloads;
// nothing shaping moves to Go.
//
// Channels (the typed catalog below is the single source of truth;
// bi/scripts/seam-parity.mjs mirrors it against bi/tui-go/seam.go):
//   host→UI notifications: agent/event, assistant/delta, tool/start,
//                          tool/done, turn/result, footer/frame
//   host→UI request:       picker/open   (answered on the back-channel)
//   UI→host notification:  input/submit
//   UI→host responses:     {id, result} / {id, error -32800} for picker/open
//
// Graceful degradation (bi#55): spawn failure returns a named error and
// the caller falls back to pi-tui with a warn line; a mid-turn child exit
// fires onDead exactly once (named) and every later write is a refused
// no-op so the host path resumes printing — never a silent swap.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTextTurn, createToolUseTurn, type LlmFn } from "./agent.js";

// --- typed message catalog -------------------------------------------------

// Field types use the Go mirror's spellings so the parity selftest can
// compare without a mapping table: "string" | "bool" | "int64" |
// "[]pickerItem", with a trailing "?" for optional (Go pointer/omitempty).
export const SEAM_CATALOG = {
	hostToUiNotifications: {
		"agent/event": { kind: "string", label: "string" },
		"assistant/delta": { text: "string" },
		"tool/start": { id: "string", name: "string", summary: "string" },
		"tool/done": { id: "string", ok: "bool", line: "string" },
		"turn/result": { markdown: "string" },
		"footer/frame": {
			provider: "string", model: "string", thinking: "string",
			tokensIn: "int64", tokensOut: "int64", cwd: "string",
			turn: "int64?", messages: "int64?", branch: "string?",
		},
	},
	hostToUiRequests: {
		"picker/open": { title: "string", items: "[]pickerItem" },
	},
	uiToHostNotifications: {
		"input/submit": { text: "string" },
	},
	pickerItem: { id: "string", label: "string", description: "string" },
	pickerResult: { itemId: "string", label: "string" },
	pickerCancelCode: -32800,
} as const;

export type AgentEventKind = "spinner_start" | "spinner_stop" | "status";

export interface FooterFrameParams {
	provider: string;
	model: string;
	thinking: string;
	tokensIn: number;
	tokensOut: number;
	cwd: string;
	turn?: number;
	messages?: number;
	branch?: string;
}

export interface PickerItem {
	id: string;
	label: string;
	description: string;
}

export type PickerAnswer = { itemId: string; label: string } | "cancelled" | "error";

export type SeamStart = { seam: GoTuiSeam } | { error: string };

const HERE = dirname(fileURLToPath(import.meta.url)); // bi/dist/src

// The flag. Only "go" routes through this module; any other value is the
// pi-tui default (callers warn on unknown values, never silently).
export function goTuiRequested(): boolean {
	return process.env.BI_TUI === "go";
}

// Binary resolution: $BI_TUI_GO_BIN → bi/tui-go/bin/tui → one-shot
// `go build` when the toolchain is present. Every failure is a named
// reason, never a bare null.
export function resolveTuiGoBinary(): { path: string } | { error: string } {
	const fromEnv = process.env.BI_TUI_GO_BIN;
	if (fromEnv) {
		return existsSync(fromEnv) ? { path: fromEnv } : { error: `BI_TUI_GO_BIN=${fromEnv} does not exist` };
	}
	const tuiGoDir = join(HERE, "..", "..", "tui-go");
	const bin = join(tuiGoDir, "bin", "tui");
	if (existsSync(bin)) return { path: bin };
	const go = spawnSync("go", ["version"], { encoding: "utf8" });
	if (go.status !== 0) {
		return { error: `Go shell binary missing at ${bin} and no go toolchain on PATH to build it` };
	}
	const build = spawnSync("go", ["build", "-o", bin, "."], { cwd: tuiGoDir, encoding: "utf8", timeout: 180_000 });
	if (build.status !== 0) {
		const tail = (build.stderr || build.stdout || "").trim().split("\n").pop() ?? "unknown error";
		return { error: `go build of bi/tui-go failed: ${tail}` };
	}
	return { path: bin };
}

export class GoTuiSeam {
	private child: ChildProcess;
	private reqId = 0;
	private toolSeq = 0;
	private pending = new Map<number, (a: PickerAnswer) => void>();
	private submitQueue: string[] = [];
	private submitWaiter: ((line: string | null) => void) | null = null;
	private deadReason: string | null = null;
	private closing = false; // close() initiated: the coming exit is graceful
	private stderrTail = "";
	private onDead: (reason: string) => void;

	private constructor(child: ChildProcess, onDead: (reason: string) => void) {
		this.child = child;
		this.onDead = onDead;
		child.stderr?.on("data", (d: Buffer) => {
			// Last ~400 chars of child stderr, for crash diagnostics.
			this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-400);
		});
		child.on("error", (e) => this.markDead(`spawn error: ${e.message}`));
		child.on("exit", (code, signal) => {
			if (this.deadReason !== null) return;
			if (this.closing) {
				// Graceful EOF-close — the designed session end, not a crash.
				this.deadReason = `session closed (exit ${code ?? "null"})`;
				return;
			}
			this.markDead(`Go shell exited unexpectedly (code ${code ?? "null"}${signal ? ` signal ${signal}` : ""})${this.stderrTail.trim() ? ` — ${this.stderrTail.trim().split("\n").pop()}` : ""}`);
		});
		let buf = "";
		// EPIPE after child death arrives as an async 'error' on the pipe,
		// not a throw from write() — swallowed here; 'exit' names the death.
		(child.stdio[3] as NodeJS.EventEmitter | null)?.on("error", () => {});
		const back = child.stdio[4] as NodeJS.ReadableStream | null; // seam back-channel (fd 4)
		back?.setEncoding("utf8");
		back?.on("data", (chunk: string) => {
			buf += chunk;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line.trim()) this.handleBackChannel(line);
			}
		});
	}

	// Spawn + a short settle window so an immediately-dying child (bad
	// binary, no /dev/tty) is reported as a start failure — with the named
	// reason — instead of as a mid-turn crash.
	static async start(opts: { onDead?: (reason: string) => void } = {}): Promise<SeamStart> {
		const bin = resolveTuiGoBinary();
		if ("error" in bin) return { error: bin.error };
		const args: string[] = [];
		const dbg = process.env.BI_TUI_GO_DEBUG_LOG;
		if (dbg) args.push("--debug-log", dbg);
		// stdio 0-2 pipes + seam on fds 3/4 (the Go side's preferred
		// channel, same wiring as the pty drill harness). fd 3 MUST be
		// passed explicitly: node leaks an open fd 3 into children
		// (verified 2026-09-08: plain spawn → Go's fd3 probe wins over
		// stdin and the seam reads an instant EOF from a stray fd).
		const child = spawn(bin.path, args, { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
		const seam = new GoTuiSeam(child, opts.onDead ?? (() => {}));
		const early = await new Promise<string | null>((resolve) => {
			const timer = setTimeout(() => cleanup() && resolve(null), 250);
			const onErr = (e: Error) => { cleanup(); resolve(`spawn: ${e.message}`); };
			const onExit = (code: number | null) => { cleanup(); resolve(`exited code ${code ?? "null"} within 250ms of spawn`); };
			const cleanup = () => {
				clearTimeout(timer);
				child.off("error", onErr);
				child.off("exit", onExit);
				return true;
			};
			child.once("error", onErr);
			child.once("exit", onExit);
		});
		if (early !== null) {
			return { error: `${bin.path}: ${early}${seam.stderrTail.trim() ? ` — ${seam.stderrTail.trim().split("\n").pop()}` : ""}` };
		}
		return { seam };
	}

	get alive(): boolean {
		return this.deadReason === null;
	}

	private markDead(reason: string): void {
		if (this.deadReason !== null) return;
		this.deadReason = reason;
		this.onDead(reason);
		for (const resolve of this.pending.values()) resolve("error");
		this.pending.clear();
		if (this.submitWaiter) {
			this.submitWaiter(null);
			this.submitWaiter = null;
		}
	}

	private handleBackChannel(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			// Named, visible — malformed back-channel lines are never
			// dropped silently (bi#55), but they don't kill the seam.
			console.error(`[bi] seam: bad back-channel NDJSON line (dropped): ${e instanceof Error ? e.message : e}`);
			return;
		}
		if (msg.method === "input/submit") {
			const text = String(msg.params?.text ?? "");
			if (this.submitWaiter) {
				const w = this.submitWaiter;
				this.submitWaiter = null;
				w(text);
			} else {
				this.submitQueue.push(text);
			}
			return;
		}
		if (msg.id != null && this.pending.has(Number(msg.id))) {
			const resolve = this.pending.get(Number(msg.id))!;
			this.pending.delete(Number(msg.id));
			if (msg.error) {
				resolve(msg.error.code === SEAM_CATALOG.pickerCancelCode ? "cancelled" : "error");
			} else {
				resolve({ itemId: String(msg.result?.itemId ?? ""), label: String(msg.result?.label ?? "") });
			}
			return;
		}
		console.error(`[bi] seam: unexpected back-channel message (dropped): ${line.slice(0, 120)}`);
	}

	// All six host→UI channels + the picker request. Every send refuses
	// after death (the onDead warn already named the failure — bi#55).
	private send(env: Record<string, unknown>): boolean {
		if (!this.alive) return false;
		try {
			(this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ jsonrpc: "2.0", ...env }) + "\n");
			return true;
		} catch (e) {
			this.markDead(`seam write failed: ${e instanceof Error ? e.message : e}`);
			return false;
		}
	}

	agentEvent(kind: AgentEventKind, label: string): boolean {
		return this.send({ method: "agent/event", params: { kind, label } });
	}

	assistantDelta(text: string): boolean {
		return this.send({ method: "assistant/delta", params: { text } });
	}

	// Mints the correlation id; toolDone takes it back.
	toolStart(name: string, summary: string): string {
		const id = `t${++this.toolSeq}`;
		this.send({ method: "tool/start", params: { id, name, summary } });
		return id;
	}

	toolDone(id: string, ok: boolean, line: string): boolean {
		return this.send({ method: "tool/done", params: { id, ok, line } });
	}

	turnResult(markdown: string): boolean {
		return this.send({ method: "turn/result", params: { markdown } });
	}

	footerFrame(p: FooterFrameParams): boolean {
		return this.send({ method: "footer/frame", params: p });
	}

	openPicker(title: string, items: PickerItem[]): Promise<PickerAnswer> {
		if (!this.alive) return Promise.resolve("error");
		const id = ++this.reqId;
		return new Promise<PickerAnswer>((resolve) => {
			this.pending.set(id, resolve);
			if (!this.send({ id, method: "picker/open", params: { title, items } })) {
				this.pending.delete(id);
				resolve("error");
			}
		});
	}

	// Next user submission from the Go textarea; null on child death.
	nextSubmit(): Promise<string | null> {
		if (this.submitQueue.length) return Promise.resolve(this.submitQueue.shift()!);
		if (!this.alive) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.submitWaiter = resolve;
		});
	}

	// EOF on seam-in is the session-end signal: the Go shell commits any
	// pending streamed text to scrollback and exits 0. Await that exit
	// (bounded), then SIGKILL as the last resort.
	async close(): Promise<number> {
		this.closing = true;
		// Already-reaped child (crash path): nothing to wait for.
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			return this.child.exitCode ?? -1;
		}
		try {
			(this.child.stdio[3] as NodeJS.WritableStream | null)?.end();
		} catch {}
		const code = await new Promise<number>((resolve) => {
			const timer = setTimeout(() => {
				try {
					this.child.kill("SIGKILL");
				} catch {}
				resolve(-1);
			}, 5000);
			this.child.once("exit", (c) => {
				clearTimeout(timer);
				resolve(c ?? -1);
			});
		});
		// The exit handler already recorded the graceful close; nothing
		// more to do (no second warn — the exit was asked for).
		if (this.deadReason === null) this.deadReason = `session closed (exit ${code})`;
		return code;
	}
}

// --- drill-only scripted LLM (BI_LLM_FIXTURE) -------------------------------
//
// Offline fixture for the seam drills: canned turns from a JSON file, no
// API key, no network. The issue's "scripted prompt fixtures" path —
// production never sets BI_LLM_FIXTURE. Steps:
//   {"text": "..."}                                   → plain text turn
//     (NOTE: a text-only turn ends the agent loop — put text turns last)
//   {"toolUse": {"name": "...", "args": {...}}}       → tool-use turn
//   {"picker": {"title", "items"}, "text": "..."}     → fire picker/open
//     (non-blocking) and return the text turn: the picker sits open
//     while the text streams — a modal genuinely mid-stream
// The returned fn carries pickerAnswer(): the stored picker answer
// (null when no picker step ran) so the caller can surface the choice
// after the loop ends (a text turn ends it before the answer arrives).
export type FixtureTurn =
	| { text: string }
	| { toolUse: { name: string; id?: string; args?: Record<string, unknown> } }
	| { picker: { title: string; items: PickerItem[] }; text: string };

export type FixtureLlmFn = LlmFn & { pickerAnswer: () => Promise<PickerAnswer | null> };

export async function fixtureLlmFn(path: string, seam: GoTuiSeam | null): Promise<FixtureLlmFn> {
	const spec = JSON.parse(readFileSync(path, "utf8"));
	const turns: FixtureTurn[] = spec.turns ?? [];
	let i = 0;
	let pendingPicker: Promise<PickerAnswer> | null = null;
	const fn: FixtureLlmFn = Object.assign(
		async () => {
			const step: FixtureTurn | undefined = turns[i++];
			if (!step) return createTextTurn("(BI_LLM_FIXTURE exhausted)");
			if ("toolUse" in step) {
				return createToolUseTurn(step.toolUse.name, step.toolUse.id ?? `fx-${i}`, step.toolUse.args ?? {});
			}
			if ("picker" in step) {
				pendingPicker = seam ? seam.openPicker(step.picker.title, step.picker.items) : Promise.resolve("error" as const);
				return createTextTurn(step.text);
			}
			return createTextTurn(step.text);
		},
		{ pickerAnswer: async () => (pendingPicker ? pendingPicker : null) },
	);
	return fn;
}
