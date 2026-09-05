// bi/src/pick.ts — interactive select-list picking (bi#69 slice 1).
//
// Arrow-key navigation over the shared select frame: BAML owns the rows
// (same shaped text renderSelectList prints), the host owns keys and
// repaints. TTY-gated by contract — callers check canRawPick() first and
// keep the numeric path for pipes (byte-identical fallback).
//
// Null means "no pick made" (Esc, Ctrl-C, or no TTY): the frame stays on
// screen and the caller's numeric commands still resolve, so Esc reads as
// "just browsing", never as an error.
import { render_select_frame_async } from "../baml_sdk/index.js";
import { parseKeys } from "./keys.js";
import { HostTui, termWidth } from "./tui.js";

export function canRawPick(): boolean {
	return !!process.stdin.isTTY && !!process.stdout.isTTY && typeof (process.stdin as any).setRawMode === "function";
}

export async function pickFromList(rows: string[], cursor: number, opts?: { width?: number }): Promise<number | null> {
	if (!canRawPick() || rows.length === 0) return null;
	const width = opts?.width ?? termWidth();
	const tui = new HostTui(width);
	const hint = "↑↓/jk navigate · Enter select · Esc list only";
	process.stdout.write(hint + "\n");
	let at = Math.min(Math.max(cursor, 0), rows.length - 1);
	const paint = async () => {
		tui.render(await render_select_frame_async(rows, at, width));
	};
	await paint();
	const stdin = process.stdin as any;
	return await new Promise<number | null>((resolve) => {
		const done = (v: number | null) => {
			stdin.removeListener("data", onData);
			try {
				stdin.setRawMode(false);
			} catch {}
			resolve(v);
		};
		const onData = (chunk: Buffer) => {
			if (process.env.BI_PICK_DEBUG) process.stderr.write(`[pick-debug] bytes=${JSON.stringify(chunk.toString("utf8"))}\n`);
			for (const k of parseKeys(chunk)) {
				if (k.name === "up" || k.name === "k") at = (at - 1 + rows.length) % rows.length;
				else if (k.name === "down" || k.name === "j") at = (at + 1) % rows.length;
				else if (k.name === "enter") {
					done(at);
					return;
				} else if (k.name === "esc" || k.name === "ctrl-c") {
					done(null);
					return;
				} else continue;
				void paint();
			}
		};
		try {
			stdin.setRawMode(true);
		} catch {
			done(null);
			return;
		}
		// Attach BEFORE resume: any keys typed while stdin was paused
		// are still in the pty buffer and must meet our listener first.
		stdin.on("data", onData);
		stdin.resume();
		if (process.env.BI_PICK_DEBUG) {
			process.stderr.write(`[pick-debug] attached paused=${stdin.isPaused()} listeners=${stdin.listenerCount("data")} raw=${(stdin as any).isRaw ?? "?"}\n`);
		}
	});
}
