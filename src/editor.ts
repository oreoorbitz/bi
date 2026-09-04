// bi/src/editor.ts — external editor (bi#32), ported from
// pi/packages/coding-agent/src/modes/interactive/external-editor.ts.
// Host owns process spawning; the command order (VISUAL > EDITOR > vi)
// is the pi-compatible convention.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function editorCommand(): string {
	return process.env.VISUAL || process.env.EDITOR || "vi";
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

export async function editInExternalEditor(command: string, content: string): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "bi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, content, "utf-8");
		const [editor, ...editorArgs] = command.split(" ");
		console.error(`[bi] launching ${command} — bi resumes when the editor exits`);
		// Async spawn, never spawnSync: a sync child races the parent for
		// the console input buffer (pi's Windows vim/nvim finding).
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});
		if (exitCode !== 0) return { status: "failed" };
		const raw = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
		return { status: "complete", content: raw.replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
