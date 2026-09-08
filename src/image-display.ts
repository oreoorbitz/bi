// bi/src/image-display.ts — transcript-only image display (bi#27, bi#70 display leg).
// Split: BAML owns the fallback text (format_image_placeholder); this module
// owns protocol detection + emission bytes. The clipboard INPUT/paste path is
// bi#32's — nothing here reads the clipboard or stages images for turns.
//
// Detection mirrors pi/packages/tui terminal-image.ts (image-relevant subset)
// plus live query responses (bi#70): tmux/screen never get graphics;
// kitty/ghostty/wezterm/warp speak kitty; iTerm2 speaks iterm2; everything
// else (including unknown terminals) falls back to the placeholder.
// BI_IMAGE_PROTOCOL overrides (kitty|iterm2|none|0), like pi's
// PI_IMAGE_PROTOCOL. Pipes always take the placeholder — control bytes in
// logs are never worth it.
//
// Query layer (bi#70): environment sniffing cannot see past ssh or minimal
// TERM values, so when the env is inconclusive the host may ask the terminal
// directly: DA1 (`ESC [ c`, sixel == attribute 4) + the kitty graphics query
// (`ESC _ G i=1,a=q ESC \`, a reply means kitty per the graphics-protocol
// spec) + XTVERSION (`CSI > 0 q`, names xterm/wezterm/…). Sixel is detected
// and reported but renders as the placeholder — the host carries no raster
// decoder, so sixel emission from PNG/JPEG bytes is out of scope (see
// shouldShowInline). iTerm2 answers no useful query; it stays env-only.
//
// Geometry + lifecycle (bi#167): dimension parsing, aspect-correct cell
// sizing, and the kitty encode/delete verbs all delegate to pi-tui's
// terminal-image toolkit (the pinned @earendil-works/pi-tui 0.84.3 ships
// it) — bi keeps the BI_IMAGE_PROTOCOL override and the pipes-placeholder
// contract, never re-implements the wire bytes.

// BAML owns the fallback text; the wire verbs below are pi-tui's so the
// bytes bi emits are the toolkit's bytes by construction.
import {
	allocateImageId as piAllocateImageId,
	deleteKittyImage as piDeleteKittyImage,
	encodeITerm2 as piEncodeITerm2,
	encodeKitty as piEncodeKitty,
	getCellDimensions as piGetCellDimensions,
	getGifDimensions as piGetGifDimensions,
	getImageDimensions as piGetImageDimensions,
	getJpegDimensions as piGetJpegDimensions,
	getPngDimensions as piGetPngDimensions,
	getWebpDimensions as piGetWebpDimensions,
	setCellDimensions as piSetCellDimensions,
	type CellDimensions,
	type ImageDimensions,
} from "@earendil-works/pi-tui";
// calculateImageCellSize is toolkit-internal (index only re-exports
// calculateImageRows) — deep path, same module as the verbs above.
import { calculateImageCellSize as piCalculateImageCellSize } from "@earendil-works/pi-tui/dist/terminal-image.js";

export type ImageProtocol = "kitty" | "iterm2" | null;

// Wire-level graphics capability, including states the transcript cannot
// emit inline. "sixel" and "none" both render as the BAML placeholder.
export type GraphicsCapability = "kitty" | "iterm2" | "sixel" | "none";

type Env = Record<string, string | undefined>;

export function detectImageProtocol(env: Env = process.env): ImageProtocol {
	const term = (env.TERM ?? "").toLowerCase();
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	// The explicit override wins over everything (pi applies PI_IMAGE_PROTOCOL
	// last), so a forced protocol can be tested on any terminal.
	const override = (env.BI_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (override === "kitty" || override === "iterm2") return override;
	if (override === "none" || override === "0") return null;
	// tmux/screen swallow graphics: placeholder even when the outer terminal
	// could draw (pi probes tmux forwarding only for hyperlinks, never images).
	if (env.TMUX || term.startsWith("tmux") || term.startsWith("screen")) return null;
	if (env.KITTY_WINDOW_ID || termProgram === "kitty") return "kitty";
	if (termProgram === "ghostty" || term.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR) return "kitty";
	if (env.WEZTERM_PANE || termProgram === "wezterm") return "kitty";
	if (termProgram === "warpterminal" || env.WARP_SESSION_ID || env.WARP_TERMINAL_SESSION_UUID) return "kitty";
	if (env.ITERM_SESSION_ID || termProgram === "iterm.app") return "iterm2";
	return null;
}

// Query bytes sent to the terminal (bi#70). DA1 is last: terminals always
// answer DA, so its reply is the completion barrier — a timeout is no
// evidence, but a completed DA1 without a preceding kitty ack is live
// negative evidence for kitty on the effective path.
export const TERMINAL_QUERY = "\x1b_Gi=1,a=q\x1b\\\x1b[>0q\x1b[c";
export const KITTY_QUERY_REPLY = "\x1b_Gi=1;OK";

// Pure parse of a terminal reply buffer (bi#70). Precedence inside one
// buffer: a kitty graphics ack wins (explicit protocol confirmation),
// then a sixel DA1 attribute, then an XTVERSION name pinning kitty
// (ghostty/wezterm/warp speak kitty; xterm-family names alone prove
// nothing about graphics, so plain "xterm" stays none).
export function parseTerminalReply(buf: string): GraphicsCapability {
	if (buf.includes(KITTY_QUERY_REPLY)) return "kitty";
	const lower = buf.toLowerCase();
	// DA1: CSI ? Pm c — sixel is attribute 4 as a WHOLE param (?62;4c
	// yes, ?64c / ?14c no). Scan every DA1 reply in the buffer.
	const da = /\x1b\[\?([0-9;]*)c/g;
	let m: RegExpExecArray | null;
	while ((m = da.exec(buf)) !== null) {
		if ((m[1] ?? "").split(";").includes("4")) return "sixel";
	}
	// XTVERSION: DCS > 0 | name ( ST — kitty-family names speak kitty.
	if (lower.includes("kitty") || lower.includes("ghostty") || lower.includes("wezterm") || lower.includes("warp")) return "kitty";
	return "none";
}

// Shared reply-drain envelope for terminal queries (bi#119 discipline, one
// path for every probe): write the query, read until the caller's barrier
// matches, resolve "unknown" (never reject) when stdio is not a TTY pair,
// under tmux/screen, on timeout, or on any error. Never steals input: the
// stdin listener is removed and pause-state restored before resolving, so no
// query reply ever leaks into prompt input — the protocol probe (bi#70) and
// the cell-size probe (bi#167) both ride this envelope; nothing queries
// mid-TUI, where reply bytes would land in the TUI's own stdin.
export interface TerminalQueryOptions {
	timeoutMs?: number;
	write?: (s: string) => void;
	stdin?: NodeJS.ReadStream;
	stdoutTTY?: boolean;
}

function readTerminalReply(
	query: string,
	isComplete: (buf: string) => boolean,
	options: TerminalQueryOptions = {},
): Promise<string | null> {
	const timeoutMs = options.timeoutMs ?? 200;
	const stdin = options.stdin ?? (process.stdin as NodeJS.ReadStream);
	const stdoutTTY = options.stdoutTTY ?? !!process.stdout.isTTY;
	const write = options.write ?? ((s: string) => process.stdout.write(s));
	return new Promise((resolve) => {
		if (!stdoutTTY || !stdin?.isTTY) {
			resolve(null);
			return;
		}
		if (process.env.TMUX) {
			resolve(null);
			return;
		}
		let done = false;
		let wasPaused = true;
		const finish = (v: string | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				stdin.removeListener("data", onData);
				if (wasPaused) stdin.pause();
			} catch {}
			resolve(v);
		};
		let chunks = "";
		const onData = (d: Buffer | string) => {
			chunks += d.toString("latin1");
			if (isComplete(chunks)) finish(chunks);
		};
		const timer = setTimeout(() => finish(chunks || null), timeoutMs);
		try {
			wasPaused = stdin.isPaused();
			stdin.on("data", onData);
			stdin.resume();
			write(query);
		} catch {
			finish(chunks || null);
		}
	});
}

// Best-effort live probe (bi#70): write TERMINAL_QUERY, read the reply,
// resolve the parsed capability. Resolves "unknown" (never rejects) when
// stdio is not a TTY pair, under tmux/screen, on timeout, or on any error —
// the caller falls back to environment detection.
export function queryTerminalProtocol(options: TerminalQueryOptions = {}): Promise<GraphicsCapability | "unknown"> {
	const protocolBarrier = (buf: string) =>
		// DA1 reply completes the barrier: parse what arrived.
		/\x1b\[\?[0-9;]*c/.test(buf) || buf.includes(KITTY_QUERY_REPLY);
	return readTerminalReply(TERMINAL_QUERY, protocolBarrier, options).then((buf) =>
		buf === null ? "unknown" : parseTerminalReply(buf),
	);
}

// Cell-size probe (bi#167): `CSI 16 t` asks the terminal for its cell pixel
// size; the reply is `CSI 6 ; height ; width t` (same pair pi-tui's TUI uses
// to feed setCellDimensions). Measured cells make the aspect math truthful;
// without them the toolkit default (9x18) applies. Best-effort like the
// protocol probe: null when nothing usable arrived. Only ever called outside
// the TUI (showStagedImage probeLive), never mid-prompt.
export const CELL_SIZE_QUERY = "\x1b[16t";

// Pure parse of a reply buffer for the cell-size response. The buffer may
// carry other query replies alongside — the LAST cell-size response wins.
// Note the wire order: height first, then width.
export function parseCellSizeResponse(buf: string): CellDimensions | null {
	const re = /\x1b\[6;(\d+);(\d+)t/g;
	let m: RegExpExecArray | null;
	let found: CellDimensions | null = null;
	while ((m = re.exec(buf)) !== null) {
		const heightPx = Number(m[1]);
		const widthPx = Number(m[2]);
		if (heightPx > 0 && widthPx > 0) found = { widthPx, heightPx };
	}
	return found;
}

export async function queryCellSize(options: TerminalQueryOptions = {}): Promise<CellDimensions | null> {
	const buf = await readTerminalReply(CELL_SIZE_QUERY, (b) => parseCellSizeResponse(b) !== null, options);
	if (buf === null) return null;
	const dims = parseCellSizeResponse(buf);
	if (dims) piSetCellDimensions(dims);
	return dims;
}

// Full capability resolution (bi#70): the explicit override wins
// absolutely; tmux/screen pin to none (queries inside multiplexers are
// unreliable, so the probe is never even consulted there); a positively
// identified env (kitty/iterm2 markers the terminal itself sets) wins over
// an unrelated wire reply; a live query naming kitty/sixel upgrades only an
// inconclusive env (ground truth from the wire beats TERM over ssh). A live
// "none" never demotes an env detection — absence of a reply marker is not
// proof the terminal lacks graphics.
export function resolveGraphicsCapability(env: Env = process.env, probed: GraphicsCapability | "unknown" = "unknown"): GraphicsCapability {
	const override = (env.BI_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (override === "kitty" || override === "iterm2") return override;
	if (override === "none" || override === "0") return "none";
	const term = (env.TERM ?? "").toLowerCase();
	if (env.TMUX || term.startsWith("tmux") || term.startsWith("screen")) return "none";
	const envProto = detectImageProtocol(env);
	if (envProto !== null) return envProto;
	if (probed === "kitty" || probed === "sixel") return probed;
	return "none";
}

// Display policy: only kitty/iterm2 emit graphics bytes. Sixel is detected
// (so transcripts can name it) but renders as the BAML placeholder —
// emission needs decoded raster pixels and the host carries no image
// decoder. Capability → emittable protocol, or null for the placeholder.
export function emittableProtocol(cap: GraphicsCapability): ImageProtocol {
	return cap === "kitty" || cap === "iterm2" ? cap : null;
}

// Kitty graphics transmission (bi#167): delegates to pi-tui's encodeKitty —
// a=T f=100 data, optional cell size + image id, chunked m=1/m=0. The bytes
// are the toolkit's bytes by construction (drill asserts byte-identity
// against the pi-tui oracle for every shared shape).
export function encodeKitty(
	base64Data: string,
	options: { columns?: number; rows?: number; imageId?: number; moveCursor?: boolean } = {},
): string {
	return piEncodeKitty(base64Data, options);
}

// iTerm2 inline image (bi#167): delegates to pi-tui's encodeITerm2 — OSC 1337
// File= inline + byte size, optional cell size + display name,
// BEL-terminated. Same byte-identity drill as kitty.
export function encodeIterm2(
	base64Data: string,
	options: { width?: number | string; height?: number | string; name?: string; preserveAspectRatio?: boolean; inline?: boolean } = {},
): string {
	return piEncodeITerm2(base64Data, options);
}

// Image geometry (bi#167): dimensions come from the base64 payload via
// pi-tui's format parsers. With an explicit mimeType the matching parser
// runs; without one each parser is tried in format order (PNG/JPEG/GIF/
// WebP) and the first hit wins. Null when the payload parses as no known
// image (the caller then emits without a cell size, as before).
export function sniffImageDimensions(base64Data: string, mimeType?: string): ImageDimensions | null {
	if (mimeType) return piGetImageDimensions(base64Data, mimeType);
	return (
		piGetPngDimensions(base64Data) ??
		piGetJpegDimensions(base64Data) ??
		piGetGifDimensions(base64Data) ??
		piGetWebpDimensions(base64Data)
	);
}

// Live stdout width for the image cap (mirrors termWidth's fallback without
// importing the TUI module — this module stays baml_sdk-free and tui-free).
function stdoutWidth(fallback = 80): number {
	const c = process.stdout.columns;
	return typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.floor(c) : fallback;
}

export interface ImageCellGeometry extends ImageDimensions {
	columns: number;
	rows: number;
}

// Aspect-correct cell sizing (bi#167): pi-tui's calculateImageCellSize over
// the sniffed dimensions, capped to the terminal width (explicit
// maxWidthCells wins), using the live cell dimensions when queryCellSize
// measured them, else the toolkit default. Null when dimensions are
// unknown — the caller pins or omits the size instead.
export function sizeImageCells(
	base64Data: string,
	options: { mimeType?: string; maxWidthCells?: number; maxHeightCells?: number } = {},
): ImageCellGeometry | null {
	const dims = sniffImageDimensions(base64Data, options.mimeType);
	if (!dims) return null;
	const maxWidth = Math.max(1, Math.floor(options.maxWidthCells ?? stdoutWidth()));
	const size = piCalculateImageCellSize(dims, maxWidth, options.maxHeightCells, piGetCellDimensions());
	return { ...dims, columns: size.columns, rows: size.rows };
}

// Kitty image-id registry (bi#167): every kitty emission allocates an id
// (pi-tui random allocation with collision avoidance against live ids — no
// reuse across images) and teardown deletes each live id. The set is the
// leak detector: pendingKittyImages() is 0 after a clean teardown.
const liveKittyIds = new Set<number>();

export function allocateTrackedImageId(): number {
	let id = piAllocateImageId();
	while (liveKittyIds.has(id)) id = piAllocateImageId();
	liveKittyIds.add(id);
	return id;
}

export function pendingKittyImages(): number {
	return liveKittyIds.size;
}

// Session teardown (bi#167): delete every live kitty image by id (pi-tui's
// deleteKittyImage frees placement AND data) and drain the registry.
// Zero bytes when nothing was shown — pipes and image-free sessions stay
// byte-clean. Returns the deleted count.
export function teardownInlineImages(write: (s: string) => void = (s) => process.stdout.write(s)): number {
	if (liveKittyIds.size === 0) return 0;
	for (const id of liveKittyIds) write(piDeleteKittyImage(id));
	const n = liveKittyIds.size;
	liveKittyIds.clear();
	return n;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

export function isImageLine(line: string): boolean {
	return line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX) || line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

// Inline only on a capable terminal AND a live stdout: piped transcripts get
// the BAML placeholder (byte-clean, greppable).
export function shouldShowInline(protocol: ImageProtocol, stdoutTTY: boolean = !!process.stdout.isTTY): boolean {
	return protocol !== null && stdoutTTY;
}

export interface DisplayImageOptions {
	label: string;
	fallback: string;
	protocol?: ImageProtocol;
	stdoutTTY?: boolean;
	// Pinned cell size (caller-measured). When BOTH are absent the host
	// derives aspect-correct columns/rows from the payload (bi#167).
	columns?: number;
	rows?: number;
	// Sizing inputs for the derived path: payload mime type (else sniffed),
	// width cap (else the live terminal width), height cap (else uncapped).
	mimeType?: string;
	maxWidthCells?: number;
	maxHeightCells?: number;
	write?: (s: string) => void;
}

// Shared transcript echo for one staged image part (bi#70): BAML shapes
// the label + fallback text (injected so this module stays baml_sdk-free),
// the host resolves capability and emits graphics or the placeholder.
// probeLive asks the terminal directly — only outside the TUI, where reply
// bytes would land in the TUI's own stdin. Inside the REPL the env rules
// decide (same as pi, which never probes mid-TUI either).
export async function showStagedImage(
	imagePath: string,
	base64Data: string,
	deps: {
		labelForPath: (path: string) => Promise<string>;
		fallbackForLabel: (label: string) => Promise<string>;
		probeLive?: boolean;
		stdoutTTY?: boolean;
		write?: (s: string) => void;
	},
): Promise<ImageProtocol | "placeholder"> {
	const label = await deps.labelForPath(imagePath);
	const fallback = await deps.fallbackForLabel(label);
	const probed = deps.probeLive ? await queryTerminalProtocol() : "unknown";
	const protocol = emittableProtocol(resolveGraphicsCapability(process.env, probed));
	// bi#167: outside the TUI a live probe may also measure the cell size
	// (same drain envelope, still never mid-prompt) so the derived geometry
	// below uses truthful cells instead of the toolkit default.
	if (deps.probeLive) await queryCellSize().catch(() => null);
	return displayImage(base64Data, { label, fallback, protocol, stdoutTTY: deps.stdoutTTY, write: deps.write });
}

// The transcript call for an image part: emission bytes on capable TTYs,
// otherwise the BAML-shaped fallback line (already styled for the theme,
// byte-identical to the pre-geometry path — BAML fallback unchanged).
// Takes an emittable protocol — map a GraphicsCapability through
// emittableProtocol first (sixel/"none" arrive as null → placeholder).
// Sizing (bi#167): pinned columns/rows pass through untouched; otherwise the
// host sniffs the payload dimensions and sizes aspect-correctly, capped to
// the terminal width. Kitty emissions allocate a tracked image id (deleted
// at session teardown); iterm2 carries the derived cells with aspect kept.
export function displayImage(base64Data: string, opts: DisplayImageOptions): ImageProtocol | "placeholder" {
	// Explicit null is a real answer (unknown terminal), not a missing option —
	// only undefined falls back to live detection.
	const protocol = opts.protocol !== undefined ? opts.protocol : detectImageProtocol();
	const write = opts.write ?? ((s: string) => process.stdout.write(s));
	if (!shouldShowInline(protocol, opts.stdoutTTY ?? !!process.stdout.isTTY)) {
		write(opts.fallback + "\n");
		return "placeholder";
	}
	const pinned = opts.columns !== undefined && opts.rows !== undefined;
	const sized =
		pinned || protocol === null
			? null
			: sizeImageCells(base64Data, { mimeType: opts.mimeType, maxWidthCells: opts.maxWidthCells, maxHeightCells: opts.maxHeightCells });
	const columns = opts.columns ?? sized?.columns;
	const rows = opts.rows ?? sized?.rows;
	if (protocol === "kitty") {
		const imageId = allocateTrackedImageId();
		write(encodeKitty(base64Data, { columns, rows, imageId }) + "\n");
	} else {
		// Pinned callers keep the legacy width/height mapping byte-for-byte;
		// derived callers ride width + auto height (aspect kept).
		const sizeOpts =
			pinned || sized === null
				? { width: opts.columns, height: opts.rows, name: opts.label }
				: { width: columns, height: "auto" as const, name: opts.label };
		write(encodeIterm2(base64Data, sizeOpts) + "\n");
	}
	return protocol;
}
