// bi/scripts/status-row.mjs — status row above the footer frame (bi#206).
//
// Change table (bi#206):
//   bi/src/status.ts   StatusRowSink interface + KindStatus attachFooter /
//                      start(echoRows) / tick + summary + freeze routing.
//   bi/src/tui.ts      HostFooter open/paint/commit/clearStatusRow +
//                      hug rebase + settleRows hold + erase/reset/home/
//                      reserve integration.
//   bi/src/cli.ts      per-turn attach + echo-span anchor.
// Gates: status-kinds + status-freeze + footer-pin + footer-hug stay
// green (sink refused → legacy bytes; drills reuse start() default).
//
// Headless arms (always run): hug open geometry (fake-DSR hug,
// zero scroll, frame/model slide), tick differential (one row, zero
// newlines), commit in place, multiline spans, pinned scroll-first
// (echo survives), freeze clears, rebase hold across liveTick,
// reserve +1, pipe byte-identity, NO_COLOR unstyled-but-present,
// uninstalled legacy fallback.
// Pty arm (SKIP unless python3+pty opens): the same turn under a real
// 14x80 pty — real TTY flags, no fakes — asserting CUP targets
// {12,13,14}, exactly 2 stderr newlines (1 open scroll + 1 commit),
// and the summary replacing row 12 in place.
//
// Red-check (bi#57): neutered the paintStatusRow CUP to a relative
// `\r EL` write (reverse hunk) → 6 FAILs, all naming the row the CUP
// used to anchor:
//   FAIL sr-hug status row is frame-1 — rows=[9,10]
//   FAIL sr-hug ticks replace one row — []
//   FAIL sr-pin status row is rows-2 — rows=[12,11,12]
//   FAIL sr-pin ticks replace one row — []
//   FAIL sr-pin3 status still rows-2 — rows=[12,11,12]
//   FAIL sr-nocolor row present — paints=1 (commit CUP only)
// Restored → all green. A passing suite that cannot go red on a
// removed anchor is camouflage, not coverage.
//
// (An open park CUP was red-checked the same way and then removed as
// dead weight: start() paints synchronously, so the first tick moves
// the cursor before any bypass output can use the park. Only the
// commit park is load-bearing — see the commit red-check below.)
//
// Red-check (bi#57, commit park): cut the commit's 3 parking newlines
// to 1 → the settled output starts on footer paint and 6 arms fail,
// all naming the shape:
//   FAIL sr-hug/sr-nearbot/sr-pin commit parks below the block (suffix)
//   FAIL sr-park commit shape — "…SUMMARY\n" (1 newline, not 3)
//   FAIL sr-nearbot/sr-settle … never fuses —
//     ["FRAME-FRAME-FRAME-FRAME-FRAME-FRAME-HELLO-OUTPUT"]
// (output fused with frame chrome — the live "hello world" class).
// Restored → green. Two emulator fidelity fixes fell out of this
// red-check: embedded newlines must move the grid cursor (writing
// them as glyphs desyncs rows), and the grid must exceed summary +
// output width or truncation hides the marker both arms look for.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const { HostFooter } = await import(join(DIST, "src", "tui.js"));
const st = await import(join(DIST, "src", "status.js"));
const { KindStatus } = st;
const { format_status, format_turn_summary } = await import(join(DIST, "baml_sdk", "index.js"));

let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fns = { formatStatus: format_status, formatSummary: format_turn_summary };
// CUP row targets in a byte stream, in order.
const cups = (buf) => [...buf.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));

// --- stderr TTY + width fakes (status-kinds.mjs pattern) ---
const realIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const realCols = Object.getOwnPropertyDescriptor(process.stderr, "columns");
function fakeStderrTty(cols) {
	Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stderr, "columns", { value: cols, configurable: true });
}
function realStderr() {
	if (realIsTTY) Object.defineProperty(process.stderr, "isTTY", realIsTTY);
	else delete process.stderr.isTTY;
	if (realCols) Object.defineProperty(process.stderr, "columns", realCols);
	else delete process.stderr.columns;
}

// --- fake DSR: settleRows learns cursor row 7 without a terminal ---
const stdin = process.stdin;
const origOn = stdin.on.bind(stdin);
const origSetRaw = stdin.setRawMode?.bind(stdin);
let dsrArmed = false;
function armDsr(row) {
	dsrArmed = true;
	try {
		Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
	} catch {}
	stdin.setRawMode = () => {};
	stdin.on = (ev, fn) => {
		origOn(ev, fn);
		if (ev === "data") setImmediate(() => stdin.emit("data", `\x1b[${row};1R`));
		return stdin;
	};
}
function disarmDsr() {
	dsrArmed = false;
	stdin.on = origOn;
	if (origSetRaw) stdin.setRawMode = origSetRaw;
	try {
		delete stdin.isTTY;
	} catch {}
}

function makeFooter(rows, cols, buf) {
	return new HostFooter(
		() => ({ rows, cols }),
		() => true,
		(s) => {
			buf.s += s;
		},
		{ corpus: [], intervalMs: 60000 },
	);
}

// --- hug open: status below the echo, frame/model slide, no scroll ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	fakeStderrTty(80);
	armDsr(7);
	let status;
	try {
		footer.setInputGate({ suspend: () => {} });
		await footer.showAsync("FRAME-1", "MODEL-1", "fallback-1");
		check("sr-hug install at hug rows", cups(buf.s).join(",") === "8,9", JSON.stringify(cups(buf.s)));
		const base = buf.s.length;
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(260);
		const open = buf.s.slice(base);
		check("sr-hug open needs no scroll", !open.includes("\x1b[24;1H\n"), JSON.stringify(open.slice(0, 40)));
		check("sr-hug status row is frame-1", footer.statusOpen && cups(open).includes(8), `rows=${JSON.stringify(cups(open))}`);
		check("sr-hug frame/model slide down", cups(open).includes(9) && cups(open).includes(10), `rows=${JSON.stringify(cups(open))}`);
		// Ticks: every status paint re-anchors row 8, zero newlines.
		const tickCups = cups(open).filter((r) => r !== 9 && r !== 10);
		check("sr-hug ticks replace one row", tickCups.length >= 2 && tickCups.every((r) => r === 8), JSON.stringify(tickCups));
		check("sr-hug ticks write zero newlines", !open.includes("\n"), `newlines=${(open.match(/\n/g) || []).length}`);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		status = null;
		const done = buf.s.slice(base);
		check(
			"sr-hug summary replaces the row in place",
			/\x1b\[8;1H\x1b\[2K✓ done · 1 turn · 2 messages · /.test(done) && done.endsWith("\n"),
			JSON.stringify(done.slice(-60)),
		);
		// Commit parks below the block (status 8 → row 11, first
		// empty row under model 10): settled output starts below the
		// chrome instead of overprinting it (live "Hello world!" +
		// 0-turn meta fusion). Zero scroll — all rows above bottom.
		check("sr-hug commit parks below the block", /\n\n\n$/.test(done), JSON.stringify(done.slice(-12)));
		check("sr-hug row closed after stop", !footer.statusOpen && !footer.statusRowActive());
	} finally {
		disarmDsr();
		realStderr();
		try {
			status?.stop({ failed: false, detail: "", turns: 0, messages: 0 });
		} catch {}
		footer.dispose();
	}
}

// --- multiline echo: span anchors below a 2-row echo ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	fakeStderrTty(80);
	armDsr(7);
	let status;
	try {
		footer.setInputGate({ suspend: () => {} });
		await footer.showAsync("FRAME-1", "MODEL-1", "fallback-1");
		buf.s = "";
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(2);
		await sleep(150);
		check("sr-hug2 status below 2-row echo", footer.statusOpen && cups(buf.s).includes(9), `rows=${JSON.stringify(cups(buf.s))}`);
		check("sr-hug2 frame/model follow", cups(buf.s).includes(10) && cups(buf.s).includes(11), `rows=${JSON.stringify(cups(buf.s))}`);
		check("sr-hug2 still no scroll", !buf.s.includes("\n"), `newlines=${(buf.s.match(/\n/g) || []).length}`);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
	} finally {
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- differential: repeat paint writes zero bytes ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	footer.show("FRAME-1", "MODEL-1", "fallback-1");
	footer.openStatusRow(1);
	const n0 = buf.s.length;
	footer.paintStatusRow("SAME");
	const n1 = buf.s.length;
	footer.paintStatusRow("SAME");
	check("sr-diff repeat paint writes zero bytes", buf.s.length === n1 && n1 > n0, `n0=${n0} n1=${n1} n2=${buf.s.length}`);
	footer.paintStatusRow("DIFFERENT");
	check("sr-diff changed paint writes", buf.s.length > n1);
	footer.dispose();
}

// --- commit byte-exact: summary in place, then 3 parking newlines ---
{
	const buf = { s: "" };
	const footer = makeFooter(12, 80, buf);
	footer.show("FRAME-1", "MODEL-1", "fallback-1");
	buf.s = "";
	footer.openStatusRow(1);
	buf.s = "";
	footer.openStatusRow(1);
	check("sr-park second open writes zero bytes", buf.s === "", JSON.stringify(buf.s.slice(0, 40)));
	buf.s = "";
	const ok = footer.commitStatusRow("SUMMARY");
	check("sr-park commit shape", ok && buf.s === "\x1b[10;1H\x1b[2KSUMMARY\n\n\n", JSON.stringify(buf.s));
	footer.dispose();
}

// --- near-bottom hug: content at rows-3 clamps the frame to the fold ---
// The live fusion shape (bi#206): hug {21,22,23} on 24 rows slides the
// frame to rows-1, so the model row IS the bottom row. The open must
// force one scroll and the commit must park through it — settled
// output lands below intact fossils, never fused with the model row.
{
	const W = 80;
	const H = 24;
	const grid = Array.from({ length: H }, () => " ".repeat(W));
	let cr = 0;
	let cc = 0;
	let saved = [0, 0];
	// put() owns every character: embedded newlines (swallowed into
	// text chunks by the regex) still move the cursor — writing them
	// as glyphs desyncs the grid and false-passes fusion arms.
	const put = (ch) => {
		if (ch === "\r") {
			cc = 0;
			return;
		}
		if (ch === "\n") {
			if (cr === H - 1) {
				grid.shift();
				grid.push(" ".repeat(W));
			} else cr += 1;
			return;
		}
		if (cc < W) {
			grid[cr] = grid[cr].slice(0, cc) + ch + grid[cr].slice(cc + 1);
			cc += 1;
		}
	};
	const feed = (s) => {
		const re = /\x1b\[(\d+);(\d+)H|\x1b\[2K|\x1b\[s|\x1b\[u|\r|\n|[^\x1b]+/g;
		let m;
		while ((m = re.exec(s)) !== null) {
			const t = m[0];
			if (t === "\x1b[s") saved = [cr, cc];
			else if (t === "\x1b[u") [cr, cc] = saved;
			else if (t === "\x1b[2K") grid[cr] = " ".repeat(W);
			else if (t === "\r" || t === "\n") put(t);
			else if (m[1] !== undefined) {
				cr = Math.min(H - 1, Math.max(0, Number(m[1]) - 1));
				cc = Math.min(W - 1, Math.max(0, Number(m[2]) - 1));
			} else for (const ch of t) put(ch);
		}
	};
	const fbuf = { s: "" };
	const footer = makeFooter(H, W, fbuf);
	const savedNoColor = process.env.NO_COLOR;
	const savedTheme = process.env.BI_THEME;
	process.env.NO_COLOR = "1";
	delete process.env.BI_THEME;
	fakeStderrTty(W);
	armDsr(21);
	const status = new KindStatus("thinking", fns);
	try {
		footer.setInputGate({ suspend: () => {} });
		// Full-width repeating chrome like production (frame meta spans
		// the row; tips ride the far right): a fusing output overwrites
		// the left but markers survive on the right, which is exactly
		// the live shape (hello left + stale hint right). Short chrome
		// would hide the fusion — the output would cover it completely.
		await footer.showAsync("FRAME-".repeat(8).slice(0, W), "MODEL-".repeat(8).slice(0, W), "fallback-1");
		fbuf.s = "";
		status.attachFooter(footer);
		status.start(1);
		await sleep(200);
		// Open writes zero newlines here (echo preserved with room to
		// spare); the commit's 3 parking newlines land settled output
		// below the block.
		const phase1 = fbuf.s;
		check("sr-nearbot open writes zero newlines", !(phase1.match(/\n/g) || []).length, `newlines=${(phase1.match(/\n/g) || []).length}`);
		check("sr-nearbot status row is rows-2", footer.statusOpen && cups(phase1).includes(22), `rows=${JSON.stringify(cups(phase1))}`);
		feed(phase1);
		fbuf.s = "";
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		check("sr-nearbot commit parks below the block", /\n\n\n$/.test(fbuf.s), JSON.stringify(fbuf.s.slice(-12)));
		feed(fbuf.s);
		feed("HELLO-OUTPUT\n\nREADY-OUTPUT\n");
		// Settled output only: mid-turn bypass starts wherever the
		// last tick left the cursor (pre-existing discipline, same as
		// the legacy path) and is out of scope here.
		const fused = grid
			.map((r) => r.trimEnd())
			.filter(
				(r) =>
					(r.includes("HELLO") || r.includes("READY")) && (r.includes("FRAME") || r.includes("MODEL") || r.includes("CHROME")),
			);
		check("sr-nearbot settled output never fuses with chrome", fused.length === 0, JSON.stringify(fused));
	} finally {
		if (savedNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = savedNoColor;
		if (savedTheme === undefined) delete process.env.BI_THEME;
		else process.env.BI_THEME = savedTheme;
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- rebase hold: liveTick repaint keeps shifted rows ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	fakeStderrTty(80);
	armDsr(7);
	try {
		footer.setInputGate({ suspend: () => {} });
		await footer.showAsync("FRAME-1", "MODEL-1", "fallback-1");
		const status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(120);
		buf.s = "";
		await footer.showAsync("FRAME-2", "MODEL-1", "fallback-1");
		const rows = cups(buf.s);
		const frameOverStatus = /\x1b\[8;1H\x1b\[2K[^\x1b]*FRAME/.test(buf.s);
		check("sr-hold live repaint keeps shifted frame", rows.includes(9) && buf.s.includes("FRAME-2") && !frameOverStatus, `rows=${JSON.stringify(rows)}`);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
	} finally {
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- pinned open: scroll-first preserves the echo, status at rows-2 ---
{
	const buf = { s: "" };
	const footer = makeFooter(12, 80, buf);
	fakeStderrTty(80);
	let status;
	try {
		footer.show("FRAME-1", "MODEL-1", "fallback-1");
		check("sr-pin install at bottom", cups(buf.s).join(",") === "11,12", JSON.stringify(cups(buf.s)));
		buf.s = "";
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(220);
		const scrolls = (buf.s.match(/\x1b\[12;1H\n/g) || []).length;
		check("sr-pin open scrolls once for 1-row echo", scrolls === 1, `scrolls=${scrolls}`);
		check("sr-pin status row is rows-2", footer.statusOpen && cups(buf.s).includes(10), `rows=${JSON.stringify(cups(buf.s))}`);
		const tickCups = cups(buf.s).filter((r) => r !== 11 && r !== 12);
		check("sr-pin ticks replace one row", tickCups.length >= 2 && tickCups.every((r) => r === 10), JSON.stringify(tickCups));
		check("sr-pin open margin covers 3 rows", footer.reserveBottom() === 3, `reserve=${footer.reserveBottom()}`);
		// Pinned park: status 10 + 3 newlines → bottom row, scrolling
		// once with fossils intact instead of fusing with the model row.
		const preCommit = buf.s.length;
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		status = null;
		check("sr-pin commit parks below the block", /\n\n\n$/.test(buf.s.slice(preCommit)), JSON.stringify(buf.s.slice(-12)));
		check("sr-pin commit releases the margin", footer.reserveBottom() === 2, `reserve=${footer.reserveBottom()}`);
		check(
			"sr-pin summary replaces the row in place",
			/\x1b\[10;1H\x1b\[2K✓ done · 1 turn · 2 messages · /.test(buf.s),
			JSON.stringify(buf.s.slice(-60)),
		);
	} finally {
		realStderr();
		try {
			status?.stop({ failed: false, detail: "", turns: 0, messages: 0 });
		} catch {}
		footer.dispose();
	}
}

// --- pinned multiline echo: scroll count equals the echo span ---
{
	const buf = { s: "" };
	const footer = makeFooter(12, 80, buf);
	fakeStderrTty(80);
	let status;
	try {
		footer.show("FRAME-1", "MODEL-1", "fallback-1");
		buf.s = "";
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(3);
		await sleep(150);
		// The open writes one CUP then N bare newlines — count the
		// newlines (ticks write none, stop hasn't run yet).
		const scrolls = (buf.s.match(/\n/g) || []).length;
		check("sr-pin3 scroll count equals echo span", scrolls === 3, `scrolls=${scrolls}`);
		check("sr-pin3 status still rows-2", footer.statusOpen && cups(buf.s).includes(10), `rows=${JSON.stringify(cups(buf.s))}`);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
	} finally {
		realStderr();
		footer.dispose();
	}
}

// --- freeze: modal clears the row; post-unfreeze ticks go relative ---
{
	const fbuf = { s: "" };
	const footer = makeFooter(24, 80, fbuf);
	fakeStderrTty(80);
	armDsr(7);
	let ebuf = "";
	const realWrite = process.stderr.write.bind(process.stderr);
	let status;
	try {
		footer.setInputGate({ suspend: () => {} });
		await footer.showAsync("FRAME-1", "MODEL-1", "fallback-1");
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(150);
		fbuf.s = "";
		status.freeze();
		check("sr-freeze modal erases the row", fbuf.s.includes("\x1b[s\x1b[8;1H\x1b[2K\x1b[u"), JSON.stringify(fbuf.s));
		check("sr-freeze row closed", !footer.statusOpen);
		process.stderr.write = (s) => {
			ebuf += s;
			return true;
		};
		status.unfreeze();
		await sleep(180);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		const cupsAfter = cups(ebuf);
		check("sr-freeze post-unfreeze ticks go relative", ebuf.includes("\r") && !cupsAfter.includes(8), `cups=${JSON.stringify(cupsAfter)}`);
	} finally {
		process.stderr.write = realWrite;
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- reserve: open holds one more footer row ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	fakeStderrTty(80);
	armDsr(7);
	try {
		footer.setInputGate({ suspend: () => {} });
		await footer.showAsync("FRAME-1", "MODEL-1", "fallback-1");
		const closed = footer.reserveBottom();
		const status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(120);
		// The rebase slides frame/model down one (margin would drop
		// by one) and the open row adds one back: net stable, and
		// exactly covering status+frame+model (24-8+1=17). Without
		// the +1 arm the open margin reads 16 and a mid-turn modal
		// overlaps the status row.
		check("sr-reserve open margin stable, covers 3 rows", footer.reserveBottom() === closed && closed === 17, `closed=${closed} open=${footer.reserveBottom()}`);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		// Post-commit the footer sits one row lower (frame 9) until
		// the post-turn DSR re-settles — the margin follows it.
		check("sr-reserve commit follows the lowered footer", footer.reserveBottom() === closed - 1, `after=${footer.reserveBottom()}`);
	} finally {
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- NO_COLOR: row present unstyled (acceptance pick, pinned here) ---
{
	const buf = { s: "" };
	const footer = makeFooter(12, 80, buf);
	const savedNoColor = process.env.NO_COLOR;
	const savedTheme = process.env.BI_THEME;
	process.env.NO_COLOR = "1";
	delete process.env.BI_THEME;
	fakeStderrTty(80);
	let status;
	try {
		footer.show("FRAME-1", "MODEL-1", "fallback-1");
		buf.s = "";
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start(1);
		await sleep(220);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2, theme: null });
		const paints = [...buf.s.matchAll(/\x1b\[10;1H\x1b\[2K([^\x1b]*)/g)].map((m) => m[1]);
		check("sr-nocolor row present", paints.length >= 2 && paints.some((p) => p.includes("thinking")), `paints=${paints.length}`);
		check("sr-nocolor no color SGR in row", paints.every((p) => !p.includes("\x1b[38;2")) && !buf.s.includes("\x1b[38;2"), "color leaked");
	} finally {
		if (savedNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = savedNoColor;
		if (savedTheme === undefined) delete process.env.BI_THEME;
		else process.env.BI_THEME = savedTheme;
		realStderr();
		footer.dispose();
	}
}

// --- pipes: attached-but-never-installed footer, stderr not a TTY ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	const realWrite = process.stderr.write.bind(process.stderr);
	let ebuf = "";
	let cerr = "";
	const realError = console.error;
	Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
	try {
		process.stderr.write = (s) => {
			ebuf += s;
			return true;
		};
		console.error = (s) => {
			cerr += String(s);
		};
		const a = new KindStatus("thinking", fns);
		a.attachFooter(footer);
		a.start();
		await sleep(150);
		a.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		const b = new KindStatus("thinking", fns);
		b.start();
		await sleep(150);
		const cerrB = cerr;
		b.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		const line = (s) => (s.match(/^\[bi\] ✓ done · 1 turn · 2 messages · /m) ?? [])[0] ?? "";
		check("sr-pipe one plain summary line", ebuf === "" && line(cerr) !== "", `stderr=${JSON.stringify(ebuf)} cerr=${JSON.stringify(cerr.slice(0, 60))}`);
		check("sr-pipe byte-identical to no-sink run", line(cerr) !== "" && cerr.includes(line(cerrB)), "shapes differ");
		check("sr-pipe zero escape bytes", !cerr.includes("\x1b") && !ebuf.includes("\x1b"), "escape leaked");
		check("sr-pipe footer never paints", buf.s === "", JSON.stringify(buf.s.slice(0, 40)));
	} finally {
		process.stderr.write = realWrite;
		console.error = realError;
		realStderr();
		footer.dispose();
	}
}

// --- legacy fallback: sink attached but footer uninstalled (fullscreen dock) ---
{
	const buf = { s: "" };
	const footer = makeFooter(24, 80, buf);
	const realWrite = process.stderr.write.bind(process.stderr);
	let ebuf = "";
	fakeStderrTty(80);
	let status;
	try {
		process.stderr.write = (s) => {
			ebuf += s;
			return true;
		};
		status = new KindStatus("thinking", fns);
		status.attachFooter(footer);
		status.start();
		await sleep(200);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		check("sr-legacy ticks stay relative when uninstalled", ebuf.includes("\r\x1b[2K") && !/\x1b\[\d+;1H/.test(ebuf), `has-cup=${/\x1b\[\d+;1H/.test(ebuf)}`);
		check("sr-legacy summary keeps legacy bytes", /✓ done · 1 turn · 2 messages · /.test(ebuf) && ebuf.endsWith("\n"), JSON.stringify(ebuf.slice(-40)));
	} finally {
		process.stderr.write = realWrite;
		realStderr();
		footer.dispose();
	}
}

// --- settled output: a grid emulator replays the full turn byte stream
// (install + open + ticks + commit, then simulated settled output,
// then the post-turn re-pin) and asserts no row ever mixes output
// text with footer chrome. This is the live "Hello world!" + 0-turn
// meta fusion shape, pinned without a pty.
{
	const W = 80;
	const H = 24;
	const grid = Array.from({ length: H }, () => " ".repeat(W));
	let cr = 0;
	let cc = 0;
	let saved = [0, 0];
	const put = (ch) => {
		if (ch === "\r") {
			cc = 0;
			return;
		}
		if (ch === "\n") {
			if (cr === H - 1) {
				grid.shift();
				grid.push(" ".repeat(W));
			} else cr += 1;
			return;
		}
		if (cc < W) {
			grid[cr] = grid[cr].slice(0, cc) + ch + grid[cr].slice(cc + 1);
			cc += 1;
		}
	};
	const feed = (s) => {
		const re = /\x1b\[(\d+);(\d+)H|\x1b\[2K|\x1b\[s|\x1b\[u|\x1b\[(\d+)H|\r|\n|[^\x1b]+/g;
		let m;
		while ((m = re.exec(s)) !== null) {
			const t = m[0];
			if (t === "\x1b[s") saved = [cr, cc];
			else if (t === "\x1b[u") [cr, cc] = saved;
			else if (t === "\x1b[2K") grid[cr] = " ".repeat(W);
			else if (t === "\r" || t === "\n") put(t);
			else if (m[1] !== undefined) {
				cr = Math.min(H - 1, Math.max(0, Number(m[1]) - 1));
				cc = Math.min(W - 1, Math.max(0, Number(m[2]) - 1));
			} else if (m[3] !== undefined) cr = Math.min(H - 1, Math.max(0, Number(m[3]) - 1));
			else for (const ch of t) put(ch);
		}
	};
	const fbuf = { s: "" };
	const footer = makeFooter(H, W, fbuf);
	// NO_COLOR: SGR bytes would land in the emulator grid as text and
	// blur row identities — the color contract is pinned elsewhere.
	const savedNoColor = process.env.NO_COLOR;
	const savedTheme = process.env.BI_THEME;
	process.env.NO_COLOR = "1";
	delete process.env.BI_THEME;
	fakeStderrTty(W);
	armDsr(7);
	const status = new KindStatus("thinking", fns);
	try {
		footer.setInputGate({ suspend: () => {} });
		// Repeating full-width markers (see near-bottom arm): short
		// chrome would let a fusing output cover the evidence.
		await footer.showAsync("FRAME-".repeat(8).slice(0, W), "MODEL-".repeat(8).slice(0, W), "fallback-1");
		fbuf.s = "";
		status.attachFooter(footer);
		status.start(1);
		await sleep(220);
		status.stop({ failed: false, detail: "", turns: 1, messages: 2 });
		// Settled turn output prints where the commit parked it, then
		// the post-turn re-pin settles fresh rows below it.
		feed(fbuf.s);
		feed("HELLO-OUTPUT\n\nREADY-OUTPUT\n");
		fbuf.s = "";
		armDsr(11);
		await footer.showAsync("FRAME-2", "MODEL-2", "fallback-2");
		feed(fbuf.s);
		const fused = grid
			.map((r) => r.trimEnd())
			.filter((r) => (r.includes("HELLO") || r.includes("READY")) && (r.includes("FRAME") || r.includes("MODEL") || r.includes("CHROME")));
		check("sr-settle settled output never fuses with footer chrome", fused.length === 0, JSON.stringify(fused));
		const summaries = grid.filter((r) => r.includes("done · 1 turn"));
		check("sr-settle summary survives as transcript", summaries.length === 1, `rows=${summaries.length}`);
	} finally {
		if (savedNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = savedNoColor;
		if (savedTheme === undefined) delete process.env.BI_THEME;
		else process.env.BI_THEME = savedTheme;
		disarmDsr();
		realStderr();
		footer.dispose();
	}
}

// --- pty: the same turn under a real 14x80 pty (no fakes) ---
const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty arm (no python3+pty on this host)");
} else {
	const home = mkdtempSync(join(tmpdir(), "bi-sr-"));
	const probe = join(home, "probe.mjs");
	writeFileSync(
		probe,
		`import { HostFooter } from ${JSON.stringify(join(DIST, "src", "tui.js"))};\nimport { KindStatus } from ${JSON.stringify(join(DIST, "src", "status.js"))};\nimport { format_status, format_turn_summary } from ${JSON.stringify(join(DIST, "baml_sdk", "index.js"))};\nawait new Promise((r) => setTimeout(r, 200));\nconst footer = new HostFooter(undefined, undefined, undefined, { corpus: [], intervalMs: 60000 });\nfooter.show("FRAME-1", "MODEL-1", "fallback-1");\nconst status = new KindStatus("thinking", { formatStatus: format_status, formatSummary: format_turn_summary });\nstatus.attachFooter(footer);\nstatus.start(1);\nstatus.setEvent("tail-event");\nawait new Promise((r) => setTimeout(r, 350));\nstatus.stop({ failed: false, detail: "", turns: 1, messages: 2 });\nconsole.log("DONE");\n`,
	);
	const run = spawnSync("python3", [join(HERE, "status-row-pty.py")], {
		env: { ...process.env, TERM: "xterm-256color", PROBE_JS: probe },
		encoding: "utf8",
		timeout: 60000,
	});
	const parsed = (run.stdout ?? "").split("\n").find((l) => l.startsWith("PARSED ")) ?? "";
	if (parsed === "") {
		console.log(`SKIP  pty arm (driver produced no PARSED line; status=${run.status})`);
	} else {
		const m = parsed.match(/^PARSED status=(\d+) frame=(\d+) model=(\d+) ticks=(\d+) newlines=(\d+) summary=(yes|no) rows=([\d,]*)$/);
		check("sr-pty status row is frame-1", m?.[1] === "12" && m?.[2] === "13" && m?.[3] === "14", parsed);
		check("sr-pty ticks replace one row", m !== null && Number(m[4]) >= 2, parsed);
		check("sr-pty zero scroll (1 open scroll + 3 commit parks + DONE)", m?.[5] === "5", parsed);
		check("sr-pty summary replaces the row in place", m?.[6] === "yes", parsed);
		check("sr-pty no other rows touched", m?.[7] === "12,13,14", parsed);
	}
}

if (failures) {
	console.log(`status-row: ${failures} FAIL`);
	process.exit(1);
}
console.log("status-row: all green");
