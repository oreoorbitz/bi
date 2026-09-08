// bi/src/clipboard.ts — clipboard both directions (bi#32), no new deps.
// Read path is image-only (text pastes through the terminal itself);
// write path is text (tool results, copied messages). macOS uses stock
// osascript/pbcopy; Linux tries wl-paste then xclip; other platforms
// report unsupported instead of failing silent.
//
// Format policy mirrors pi's clipboard-image.ts supported set
// (png/jpeg/webp/gif) minus the Photon conversion step: unsupported
// bytes (e.g. BMP) are rejected, never transcoded — no WASM dep.
// Bytes are the authority: the returned mime is sniffed from magic,
// not trusted from the advertised clipboard type.

import { execFileSync } from "node:child_process";

export type ClipboardImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ClipboardImage {
	bytes: Buffer;
	mime: ClipboardImageMime;
}

// Magic-byte sniff — the authority on what the bytes are. Returns null
// for anything outside the supported set (BMP, TIFF, ...).
export function sniffImageMime(bytes: Buffer): ClipboardImageMime | null {
	if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (bytes.length >= 6) {
		const sig = bytes.subarray(0, 6).toString("ascii");
		if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
	}
	return null;
}

export function extensionForImageMime(mime: ClipboardImageMime): string {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
	}
}

function run(cmd: string, args: string[], input?: Buffer): Buffer | null {
	try {
		return execFileSync(cmd, args, { input, timeout: 5000, maxBuffer: 50 * 1024 * 1024 });
	} catch {
		return null;
	}
}

// `get the clipboard` dumps every representation as hex — parse the PNG
// one out directly (verified live: `«class PNGf»:«data PNGf89504E47…»`).
// No file round-trip, no write-access dance, no new deps. macOS screenshots
// and copies land as PNG, so PNGf is the only representation worth parsing.
function readDarwinImage(): ClipboardImage | null {
	const out = run("osascript", ["-e", "get the clipboard"]);
	if (!out) return null;
	const m = out.toString().match(/«class PNGf»:«data PNGf([0-9A-Fa-f]+)»/);
	if (!m) return null;
	const bytes = Buffer.from(m[1], "hex");
	if (sniffImageMime(bytes) !== "image/png") return null;
	return { bytes, mime: "image/png" };
}

const LINUX_IMAGE_TYPES: ClipboardImageMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Preferred-type probing first (pi's TARGETS/--list-types shape): ask what
// the clipboard offers, try the preferred supported type first, then fall
// back through the rest. Sniffed bytes outrank the advertised type.
function readLinuxImage(): ClipboardImage | null {
	const order = preferredLinuxOrder() ?? LINUX_IMAGE_TYPES;
	for (const pass of [order, LINUX_IMAGE_TYPES]) {
		for (const mime of pass) {
			const out = readLinuxType(mime);
			if (!out || out.length === 0) continue;
			const sniffed = sniffImageMime(out);
			if (sniffed) return { bytes: out, mime: sniffed };
		}
	}
	return null;
}

function preferredLinuxOrder(): ClipboardImageMime[] | null {
	const list = run("wl-paste", ["--list-types"]) ?? run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
	if (!list) return null;
	const offered = new Set(
		list
			.toString("utf8")
			.split(/\r?\n/)
			.map((t) => t.trim().toLowerCase()),
	);
	const ranked = LINUX_IMAGE_TYPES.filter((m) => offered.has(m));
	return ranked.length ? ranked : null;
}

function readLinuxType(mime: string): Buffer | null {
	// Wayland first (xclip against a Wayland clipboard hangs or misses),
	// then X11 — pi tries wl-paste before xclip on Wayland/WSL too.
	return run("wl-paste", ["--type", mime]) ?? run("xclip", ["-selection", "clipboard", "-t", mime, "-o"]);
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
