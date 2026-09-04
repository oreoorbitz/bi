// bi/src/clipboard.ts — clipboard both directions (bi#32), no new deps.
// Read path is image-only (text pastes through the terminal itself);
// write path is text (tool results, copied messages). macOS uses stock
// osascript/pbcopy; Linux tries xclip then wl-paste/wl-copy; other
// platforms report unsupported instead of failing silent.

import { execFileSync } from "node:child_process";

export interface ClipboardImage {
	bytes: Buffer;
	mime: "image/png";
}

function run(cmd: string, args: string[], input?: Buffer): Buffer | null {
	try {
		return execFileSync(cmd, args, { input, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
	} catch {
		return null;
	}
}

// `get the clipboard` dumps every representation as hex — parse the PNG
// one out directly (verified live: `«class PNGf»:«data PNGf89504E47…»`).
// No file round-trip, no write-access dance, no new deps.
function readDarwinImage(): ClipboardImage | null {
	const out = run("osascript", ["-e", "get the clipboard"]);
	if (!out) return null;
	const m = out.toString().match(/«class PNGf»:«data PNGf([0-9A-Fa-f]+)»/);
	if (!m) return null;
	const bytes = Buffer.from(m[1], "hex");
	if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
	return { bytes, mime: "image/png" };
}

function readLinuxImage(): ClipboardImage | null {
	for (const [cmd, args] of [["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]], ["wl-paste", ["--type", "image/png"]]] as [string, string[]][]) {
		const out = run(cmd, args);
		if (out && out.length > 8 && out.readUInt32BE(0) === 0x89504e47) return { bytes: out, mime: "image/png" };
	}
	return null;
}

export function readClipboardImage(): ClipboardImage | null {
	if (process.platform === "darwin") return readDarwinImage();
	if (process.platform === "linux") return readLinuxImage();
	return null;
}

export function clipboardSupportsImage(): boolean {
	return process.platform === "darwin" || process.platform === "linux";
}

export function writeClipboardText(text: string): boolean {
	const input = Buffer.from(text, "utf8");
	if (process.platform === "darwin") return run("pbcopy", [], input) !== null;
	if (process.platform === "linux") {
		if (run("xclip", ["-selection", "clipboard", "-i"], input) !== null) return true;
		return run("wl-copy", [], input) !== null;
	}
	if (process.platform === "win32") {
		const ps = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], input);
		return ps !== null;
	}
	return false;
}
