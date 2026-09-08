// bi/scripts/image-display.mjs — transcript image-display conformance (bi#27, bi#70 display leg).
// Drives the REAL host module (dist/src/image-display.js) and asserts:
// (1) protocol detection matches pi's environment rules over injected envs,
// (2) kitty emission is chunk-framed with payload round-tripping byte-clean,
// (3) iterm2 emission carries inline/size with a BEL terminator,
// (4) pipes and unknown terminals take the BAML placeholder (byte-identical
// to format_image_placeholder), never control bytes.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(ROOT, "..", "dist", "src", "image-display.js"));
const { format_image_placeholder_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
const { detectImageProtocol, encodeKitty, encodeIterm2, isImageLine, shouldShowInline, displayImage, parseTerminalReply, resolveGraphicsCapability, emittableProtocol, queryTerminalProtocol, queryCellSize, parseCellSizeResponse, sniffImageDimensions, sizeImageCells, allocateTrackedImageId, pendingKittyImages, teardownInlineImages, CELL_SIZE_QUERY, TERMINAL_QUERY, KITTY_QUERY_REPLY } = mod;
// pi-tui oracles: delegation means bi's bytes ARE the toolkit's bytes.
const pi = await import("@earendil-works/pi-tui");
const { calculateImageCellSize: piCalculateImageCellSize } = await import("@earendil-works/pi-tui/dist/terminal-image.js");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// (1) detection matrix — pi's rules, injected envs (never the real process env).
check(detectImageProtocol({ KITTY_WINDOW_ID: "1" }) === "kitty", "kitty window id draws kitty");
check(detectImageProtocol({ TERM_PROGRAM: "kitty" }) === "kitty", "TERM_PROGRAM kitty draws kitty");
check(detectImageProtocol({ TERM_PROGRAM: "ghostty" }) === "kitty", "ghostty speaks kitty");
check(detectImageProtocol({ TERM: "xterm-ghostty" }) === "kitty", "TERM ghostty speaks kitty");
check(detectImageProtocol({ WEZTERM_PANE: "0" }) === "kitty", "wezterm speaks kitty");
check(detectImageProtocol({ WARP_SESSION_ID: "x" }) === "kitty", "warp speaks kitty");
check(detectImageProtocol({ ITERM_SESSION_ID: "x" }) === "iterm2", "iterm session draws iterm2");
check(detectImageProtocol({ TERM_PROGRAM: "iterm.app" }) === "iterm2", "TERM_PROGRAM iterm.app draws iterm2");
check(detectImageProtocol({ KITTY_WINDOW_ID: "1", TMUX: "x" }) === null, "tmux forces placeholder even for kitty");
check(detectImageProtocol({ TERM: "tmux-256color" }) === null, "tmux TERM forces placeholder");
check(detectImageProtocol({ TERM: "screen" }) === null, "screen forces placeholder");
check(detectImageProtocol({}) === null, "unknown terminal is placeholder (conservative)");
check(detectImageProtocol({ TERM_PROGRAM: "vscode" }) === null, "vscode is placeholder");
check(detectImageProtocol({ TERM_PROGRAM: "alacritty" }) === null, "alacritty is placeholder");
check(detectImageProtocol({}) === null, "windows console without markers is placeholder");
check(detectImageProtocol({ BI_IMAGE_PROTOCOL: "kitty" }) === "kitty", "BI_IMAGE_PROTOCOL=kitty overrides up");
check(detectImageProtocol({ BI_IMAGE_PROTOCOL: "iterm2" }) === "iterm2", "BI_IMAGE_PROTOCOL=iterm2 overrides up");
check(detectImageProtocol({ KITTY_WINDOW_ID: "1", BI_IMAGE_PROTOCOL: "none" }) === null, "BI_IMAGE_PROTOCOL=none forces placeholder");
check(detectImageProtocol({ KITTY_WINDOW_ID: "1", BI_IMAGE_PROTOCOL: "0" }) === null, "BI_IMAGE_PROTOCOL=0 forces placeholder");
check(detectImageProtocol({ BI_IMAGE_PROTOCOL: "sixel" }) === null, "unknown override value stays placeholder");

// (2) kitty emission — single-chunk shape plus chunked round-trip.
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64");
const single = encodeKitty(png);
check(single.startsWith("\x1b_Ga=T,f=100,q=2;") && single.endsWith("\x1b\\"), "kitty single chunk frames pi-style");
check(single.slice(single.indexOf(";") + 1, -2) === png, "kitty single payload is byte-clean");
const big = "QUJD".repeat(2000);
const multi = encodeKitty(big);
check(multi.includes(",m=1;") && multi.includes("\x1b_Gm=0;"), "kitty oversize chunks with m=1/m=0");
const payload = multi.split("\x1b\\").filter((s) => s.length > 0).map((s) => s.slice(s.indexOf(";") + 1)).join("");
check(payload === big, "kitty chunked payload round-trips byte-clean");
check(encodeKitty(png, { columns: 40 }).includes("c=40"), "kitty cell width passes through");

// (3) iterm2 emission — OSC 1337 with inline + true byte size.
const it = encodeIterm2(png, { name: "cat.png" });
check(it.startsWith("\x1b]1337;File=") && it.endsWith("\x07"), "iterm2 OSC 1337 BEL-terminated");
check(it.includes("inline=1") && it.includes(`size=${Buffer.byteLength(png, "base64")}`), "iterm2 carries inline + byte size");
check(it.includes(`name=${Buffer.from("cat.png").toString("base64")}`), "iterm2 carries base64 display name");
check(isImageLine(single) && isImageLine(it) && !isImageLine("[image: cat.png]"), "isImageLine spots emissions only");

// (4) pipe/unknown rule — placeholder path is the BAML fallback, byte-identical.
check(shouldShowInline("kitty", true) === true, "capable TTY shows inline");
check(shouldShowInline("kitty", false) === false, "pipes take the placeholder even when capable");
check(shouldShowInline(null, true) === false, "unknown terminal takes the placeholder on TTY");
const fallback = await format_image_placeholder_async("cat.png", { theme: null });
const out = [];
const r1 = displayImage(png, { label: "cat.png", fallback, protocol: "kitty", stdoutTTY: false, write: (s) => out.push(s) });
check(r1 === "placeholder" && out.join("") === fallback + "\n", "piped displayImage prints the BAML fallback only");
const out2 = [];
const r2 = displayImage(png, { label: "cat.png", fallback, protocol: null, stdoutTTY: true, write: (s) => out2.push(s) });
check(r2 === "placeholder" && out2.join("") === fallback + "\n", "unknown-terminal displayImage prints the fallback");
check(!out.join("").includes("\x1b"), "fallback path emits zero escapes");
const out3 = [];
const r3 = displayImage(png, { label: "cat.png", fallback, protocol: "kitty", stdoutTTY: true, write: (s) => out3.push(s) });
check(r3 === "kitty" && isImageLine(out3.join("")), "capable TTY emits kitty bytes");

// (5) query responses (bi#70) — pure parse over reply fixtures, no TTY needed.
check(TERMINAL_QUERY.includes("\x1b[c") && TERMINAL_QUERY.includes("i=1,a=q"), "probe asks kitty-graphics + DA1 barrier");
check(parseTerminalReply("\x1b_Gi=1;OK\x1b\\") === "kitty", "kitty graphics ack parses kitty");
check(parseTerminalReply("\x1b[?62;4c") === "sixel", "DA1 attribute 4 parses sixel");
check(parseTerminalReply("\x1b[?63;1;2;4;6c") === "sixel", "DA1 attribute 4 anywhere in list parses sixel");
check(parseTerminalReply("\x1b[?64c") === "none", "DA1 64 is not attribute 4 (no false sixel)");
check(parseTerminalReply("\x1b[?1;2c") === "none", "plain VT100 DA1 parses none");
check(parseTerminalReply("\x1bP>|kitty(0.34.1)\x1b\\") === "kitty", "XTVERSION kitty parses kitty");
check(parseTerminalReply("\x1bP>|WezTerm 20240203\x1b\\") === "kitty", "XTVERSION wezterm parses kitty (speaks kitty)");
check(parseTerminalReply("\x1bP>|XTerm(390)\x1b\\") === "none", "XTVERSION xterm alone proves no graphics");
check(parseTerminalReply("") === "none", "empty reply parses none");
check(parseTerminalReply("\x1b_Gi=1;OK\x1b\\\x1b[?62;4c") === "kitty", "kitty ack wins over sixel in one buffer");
// resolve policy: override absolute, tmux pins, wire truth upgrades, never demotes.
check(resolveGraphicsCapability({ BI_IMAGE_PROTOCOL: "kitty" }, "none") === "kitty", "override kitty wins over live none");
check(resolveGraphicsCapability({ KITTY_WINDOW_ID: "1", TMUX: "x" }, "kitty") === "none", "tmux pins none even with kitty reply");
check(resolveGraphicsCapability({ TERM: "xterm" }, "sixel") === "sixel", "live sixel upgrades inconclusive env");
check(resolveGraphicsCapability({ TERM: "xterm" }, "kitty") === "kitty", "live kitty upgrades inconclusive env");
check(resolveGraphicsCapability({ KITTY_WINDOW_ID: "1" }, "none") === "kitty", "live none never demotes env kitty");
check(resolveGraphicsCapability({ ITERM_SESSION_ID: "x" }, "sixel") === "iterm2", "env iterm2 wins over unrelated sixel reply");
check(resolveGraphicsCapability({ TERM: "xterm" }, "unknown") === "none", "unknown probe + unknown env is none");
check(resolveGraphicsCapability({ TERM: "xterm" }, "none") === "none", "live none + unknown env stays none");
// emission policy: sixel is detected but renders as the BAML placeholder.
check(emittableProtocol("kitty") === "kitty" && emittableProtocol("iterm2") === "iterm2", "kitty/iterm2 stay emittable");
check(emittableProtocol("sixel") === null && emittableProtocol("none") === null, "sixel/none map to placeholder");
const out4 = [];
const r4 = displayImage(png, { label: "cat.png", fallback, protocol: emittableProtocol("sixel"), stdoutTTY: true, write: (s) => out4.push(s) });
check(r4 === "placeholder" && out4.join("") === fallback + "\n", "sixel-capable TTY prints the BAML fallback");
// probe never rejects and never touches the terminal off-TTY.
const q1 = await queryTerminalProtocol({ stdoutTTY: false, stdin: { isTTY: false } });
check(q1 === "unknown", "piped stdio resolves unknown without probing");
const q2 = await queryTerminalProtocol({ stdoutTTY: true, stdin: { isTTY: false } });
check(q2 === "unknown", "probe needs a TTY stdin pair");

// (6) bi#167 RED-CHECK drill — aspect-correct sizing + kitty lifecycle via
// pi-tui terminal-image (bi/src/image-display.ts ONLY; BAML fallback +
// BI_IMAGE_PROTOCOL override + pipes contract above stay byte-identical).
// Hunk under test:
//   encodeKitty/encodeIterm2 delegate to pi-tui; displayImage derives
//   dimensions via getImageDimensions and sizes aspect-correctly capped to
//   width; kitty emissions allocate tracked ids deleted on teardown;
//   cell-size queries ride the shared bi#119 drain envelope.
// Why it was red before: caller-guessed columns/rows (distort/overflow),
// hand-rolled encoders, no ids, no deletion, no cell query. Green after:
// payload-measured geometry, toolkit bytes, registry + teardown.
{
	// Delegation: every shared shape is byte-identical to the pi-tui oracle.
	const shapes = [{}, { columns: 40 }, { columns: 40, rows: 10 }, { imageId: 7 }, { columns: 40, rows: 10, imageId: 7, moveCursor: false }];
	for (const o of shapes) check(encodeKitty(png, o) === pi.encodeKitty(png, o), `encodeKitty delegates ${JSON.stringify(o)}`);
	check(encodeKitty(big, { columns: 40 }) === pi.encodeKitty(big, { columns: 40 }), "encodeKitty chunked delegates byte-identical");
	const itShapes = [{}, { name: "cat.png" }, { width: 40, height: 10, name: "cat.png" }];
	for (const o of itShapes) check(encodeIterm2(png, o) === pi.encodeITerm2(png, o), `encodeIterm2 delegates ${JSON.stringify(o)}`);

	// Fixtures with real dimensions (parsers read headers, never CRCs).
	const mkPng = (w, h) => {
		const b = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
		b.writeUInt32BE(13, 8);
		b.write("IHDR", 12);
		b.writeUInt32BE(w, 16);
		b.writeUInt32BE(h, 20);
		return b.toString("base64");
	};
	const mkGif = (w, h) => {
		const b = Buffer.alloc(10);
		b.write("GIF89a", 0);
		b.writeUInt16LE(w, 6);
		b.writeUInt16LE(h, 8);
		return b.toString("base64");
	};
	const mkJpeg = (w, h) => {
		const b = Buffer.alloc(20);
		b.writeUInt8(0xff, 0); b.writeUInt8(0xd8, 1);
		b.writeUInt8(0xff, 2); b.writeUInt8(0xc0, 3);
		b.writeUInt16BE(11, 4);
		b.writeUInt8(8, 6);
		b.writeUInt16BE(h, 7);
		b.writeUInt16BE(w, 9);
		return b.toString("base64");
	};
	const png200x100 = mkPng(200, 100);
	check(JSON.stringify(sniffImageDimensions(png200x100)) === JSON.stringify({ widthPx: 200, heightPx: 100 }), "sniff reads PNG dimensions from the payload");
	check(JSON.stringify(sniffImageDimensions(png200x100, "image/png")) === JSON.stringify({ widthPx: 200, heightPx: 100 }), "sniff honors an explicit mime type");
	check(JSON.stringify(sniffImageDimensions(mkGif(60, 30))) === JSON.stringify({ widthPx: 60, heightPx: 30 }), "sniff reads GIF dimensions");
	check(JSON.stringify(sniffImageDimensions(mkJpeg(200, 100))) === JSON.stringify({ widthPx: 200, heightPx: 100 }), "sniff reads JPEG dimensions");
	check(sniffImageDimensions("QUJD") === null, "sniff returns null for non-image payloads");

	// Aspect-correct sizing against the toolkit oracle (default 9x18 cells:
	// 200x100 @ 40 cols -> 40x10), capped to the requested width.
	const oracle = piCalculateImageCellSize({ widthPx: 200, heightPx: 100 }, 40, undefined, pi.getCellDimensions());
	const sized = sizeImageCells(png200x100, { maxWidthCells: 40 });
	check(sized !== null && sized.columns === oracle.columns && sized.rows === oracle.rows, `sizeImageCells matches the toolkit oracle (got ${JSON.stringify(sized)}, want ${JSON.stringify(oracle)})`);
	check(sized !== null && sized.columns === 40 && sized.rows === 10, `200x100 @ 40 cols sizes 40x10 aspect-correct (got ${JSON.stringify(sized)})`);
	const capped = sizeImageCells(png200x100, { maxWidthCells: 10 });
	check(capped !== null && capped.columns <= 10, `width cap binds columns (got ${JSON.stringify(capped)})`);
	check(sizeImageCells("QUJD", { maxWidthCells: 40 }) === null, "unknown payload sizes null (caller pins or omits)");

	// Derived emission: kitty carries c/r + a tracked id, ids never reuse,
	// teardown deletes every live id and drains the registry.
	// Section (4)'s capable-TTY emission left one live id — tracking spans
	// calls, so drain it first and prove the registry returns to zero.
	teardownInlineImages(() => {});
	check(pendingKittyImages() === 0, "registry drains to empty");
	const k1 = [];
	displayImage(png200x100, { label: "t.png", fallback, protocol: "kitty", stdoutTTY: true, maxWidthCells: 40, write: (s) => k1.push(s) });
	const k2 = [];
	displayImage(png200x100, { label: "t.png", fallback, protocol: "kitty", stdoutTTY: true, maxWidthCells: 40, write: (s) => k2.push(s) });
	const id1 = k1.join("").match(/i=(\d+)/)?.[1];
	const id2 = k2.join("").match(/i=(\d+)/)?.[1];
	check(k1.join("").includes("c=40") && k1.join("").includes("r=10"), "derived kitty emission carries aspect-correct c/r");
	check(id1 !== undefined && id2 !== undefined && id1 !== id2, `kitty ids allocate without reuse (got ${id1} / ${id2})`);
	check(pendingKittyImages() === 2, "registry tracks both live images");
	const del = [];
	const n = teardownInlineImages((s) => del.push(s));
	check(n === 2 && pendingKittyImages() === 0, "teardown deletes all live ids and drains the registry");
	check(del.every((d, k) => d === pi.deleteKittyImage(Number([id1, id2][k]))), "teardown bytes are the toolkit delete verb per id");
	let wrote = false;
	check(teardownInlineImages(() => { wrote = true; }) === 0 && !wrote, "empty teardown writes zero bytes");
	// iterm2 derived path keeps aspect (width + auto height), never raw rows.
	const io = [];
	displayImage(png200x100, { label: "t.png", fallback, protocol: "iterm2", stdoutTTY: true, maxWidthCells: 40, write: (s) => io.push(s) });
	check(io.join("").includes("width=40") && io.join("").includes("height=auto"), "derived iterm2 emission carries width + auto height");
	// Pinned callers keep the legacy mapping byte-for-byte.
	const pin = [];
	displayImage(png, { label: "cat.png", fallback, protocol: "iterm2", stdoutTTY: true, columns: 40, rows: 10, write: (s) => pin.push(s) });
	check(pin.join("").includes("width=40") && pin.join("").includes("height=10"), "pinned iterm2 keeps the legacy width/height mapping");

	// Cell-size query: pure parse first (wire order is height, then width).
	check(CELL_SIZE_QUERY === "\x1b[16t", "cell query asks CSI 16 t");
	check(JSON.stringify(parseCellSizeResponse("noise\x1b[6;100;50t tail")) === JSON.stringify({ widthPx: 50, heightPx: 100 }), "cell reply parses height-first");
	check(JSON.stringify(parseCellSizeResponse("\x1b[6;10;10t\x1b[6;20;30t")) === JSON.stringify({ widthPx: 30, heightPx: 20 }), "last cell reply wins");
	check(parseCellSizeResponse("") === null, "empty buffer parses null");
	check(parseCellSizeResponse("\x1b[6;0;50t") === null, "degenerate cell reply parses null");
	const q3 = await queryCellSize({ stdoutTTY: false, stdin: { isTTY: false } });
	check(q3 === null, "cell probe needs a TTY pair (never rejects, never touches the terminal off-TTY)");
}

if (failures) process.exit(1);
console.log("image-display: all green");
