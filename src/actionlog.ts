// bi/src/actionlog.ts — host-recorded action log (bi#75).
//
// The host loop already observes every action, so it holds the pen:
// one append-only line per event, `<ts> <session> <code> <detail>`,
// in a single shared file (~/.bi/actions.log). Agents never write
// here, which is what makes the log checkable — reads are `rg` over
// one file with one total order for free.
//
// BAML owns the codebook + line shape (baml_src/action_log.baml); this
// file owns the append. Any failure (bad path, unknown code, VM error)
// is swallowed and counted — a log write must never break a turn.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { format_action_line } from "../baml_sdk/index.js";
import { getBiSessionsDir } from "./session.js";

export function actionLogFile(): string {
	return join(dirname(getBiSessionsDir()), "actions.log");
}

// JSON for log details that can never throw (LLM args are plain data,
// but the log path must hold even when they are not).
export function safeJson(o: unknown): string {
	try {
		return JSON.stringify(o) ?? "?";
	} catch {
		return "?";
	}
}

export class ActionLog {
	private writeFailures = 0;
	private droppedCodes = 0;
	constructor(
		private session: string,
		private file?: string,
	) {}
	// One O(1) append. Never throws — callers must not branch on it.
	record(code: string, detail = ""): void {
		try {
			const line = format_action_line(new Date().toISOString(), this.session, code, detail);
			if (line === null) {
				this.droppedCodes += 1;
				return;
			}
			const target = this.file ?? actionLogFile();
			try {
				mkdirSync(dirname(target), { recursive: true });
			} catch {}
			appendFileSync(target, line + "\n");
		} catch {
			this.writeFailures += 1;
		}
	}
	counters(): { writeFailures: number; droppedCodes: number } {
		return { writeFailures: this.writeFailures, droppedCodes: this.droppedCodes };
	}
}
