// bi/scripts/tui-diff.mjs — HostTui differential-render conformance.
// Captures the byte stream, replays it on a virtual screen, and asserts
// (1) repaint bytes never full-clear on same-count frames, (2) the final
// screen equals the last frame (no scroll creep, no stale rows), and
// (3) the rows the host rewrote match BAML diff_lines for the same
// transition (the pinned spec both sides implement).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { HostTui } = await import(join(ROOT, "..", "dist", "src", "tui.js"));
const { diff_lines_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
// bi#161: width primitives come from the same pi-tui dep the host reuses —
// the drill measures with the pinned spec, never its own ANSI math.
const { visibleWidth } = await import("@earendil-works/pi-tui");

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Minimal screen: printable runs, \n \r, EL 2K, save/restore, up-N,
// full clear. Anything else throws (byte contract stays explicit).
function replay(bytes) {
	const grid = [""];
	let y = 0;
	let x = 0;
	let saved = null;
	const row = () => (grid[y] ??= "");
	let i = 0;
	while (i < bytes.length) {
		const c = bytes[i];
		if (c === "\n") {
			y++;
			x = 0;
			i++;
			continue;
		}
		if (c === "\r") {
			x = 0;
			i++;
			continue;
		}
		if (c === "\x1b" && bytes[i + 1] === "[") {
			// bi#161: synchronized output bracketing (?2026h/l) wraps every
			// repaint — zero-width markers, skipped by the replay.
			const sync = bytes.slice(i).match(/^\x1b\[\?2026[hl]/);
			if (sync) {
				i += sync[0].length;
				continue;
			}
			// bi#161: SGR styling (e.g. in truncated styled lines) carries no
			// cells — skipped so styled frames stay replayable.
			const sgr = bytes.slice(i).match(/^\x1b\[[\d;]*m/);
			if (sgr) {
				i += sgr[0].length;
				continue;
			}
			const m = bytes.slice(i).match(/^\x1b\[(\d*);?(\d*)([AJKHsu])/);
			if (!m) throw new Error(`unsupported escape at offset ${i}: ${JSON.stringify(bytes.slice(i, i + 8))}`);
			const n = m[1] === "" ? 1 : Number(m[1]);
			const op = m[3];
			if (op === "J") {
				grid.length = 0;
				grid.push("");
				y = 0;
				x = 0;
			} else if (op === "H") {
				y = 0;
				x = 0;
			} else if (op === "K") {
				grid[y] = "";
				x = 0;
			} else if (op === "s") {
				saved = [y, x];
			} else if (op === "u") {
				[y, x] = saved ?? [0, 0];
			} else if (op === "A") {
				y = Math.max(0, y - n);
			}
			i += m[0].length;
			continue;
		}
		const r = row();
		grid[y] = r.slice(0, x) + c + r.slice(x + 1);
		x++;
		i++;
	}
	while (grid.length > 1 && grid[grid.length - 1] === "") grid.pop();
	return { grid, cursor: [y, x] };
}

const A = ["bi — ready BAIS", "bi#01  Alpha", "bi#02  Beta"];
const B = ["bi — ready BAIS", "bi#01  Alpha!", "bi#03  Gamma"];

let out = "";
const tui = new HostTui(80, (s) => {
	out += s;
});
tui.render(A);
const firstBytes = out;
out = "";
tui.render(B);
const repaint = out;

check(!repaint.includes("\x1b[2J"), "same-count repaint never full-clears");
const rewritten = [...repaint.matchAll(/\x1b\[2K([^\x1b\r\n]*)/g)].map((m) => m[1]);
check(JSON.stringify(rewritten) === JSON.stringify(["bi#01  Alpha!", "bi#03  Gamma"]), `only changed rows rewrite (got ${JSON.stringify(rewritten)})`);

const bamlDiff = await diff_lines_async(A, B);
check(JSON.stringify([...bamlDiff].sort()) === JSON.stringify(["1", "2"]), `BAML diff_lines agrees on changed rows (got ${JSON.stringify(bamlDiff)})`);

const screen = replay(firstBytes + repaint);
check(JSON.stringify(screen.grid) === JSON.stringify(B), `replayed screen converges to frame B (got ${JSON.stringify(screen.grid)})`);
check(screen.cursor[0] === B.length, `cursor parks below the frame (row ${screen.cursor[0]}, want ${B.length})`);

// Count change still full-clears and converges (inside the ?2026 bracket).
out = "";
tui.render([...B, "bi#04  Delta"]);
check(out.startsWith("\x1b[?2026h\x1b[2J\x1b[H"), "count change full-clears");
const screen2 = replay(firstBytes + repaint + out);
check(JSON.stringify(screen2.grid) === JSON.stringify([...B, "bi#04  Delta"]), "grown frame converges after clear");

// bi#161 RED-CHECK drill — harden HostTui differential rendering.
// Hunk under test (bi/src/tui.ts, HostTui render/visibleWidth ONLY):
//   render truncates overwide lines via pi-tui sliceByColumn, visibleWidth
//   measures cells via pi-tui visibleWidth, every repaint is ?2026-bracketed,
//   a columns change between renders takes the resize path (full re-render
//   at the new width, stale rows cleared, never 2J).
// Why it was red before: render wrote the raw 20-cell styled line into a
// width-10 frame (29 bytes on the wire, terminal wraps, region misaligns),
// visibleWidth returned the 29-byte length, output had no ?2026 bracketing,
// and a columns change rendered at the stale width with misaligned diffs.
// Green after: payload truncates to <=10 cells, ?2026 wraps the buffer,
// visibleWidth reports 20 (cells, not bytes), resize re-renders in place.
{
	const STYLED = "\x1b[31m" + "x".repeat(20) + "\x1b[0m"; // 20 cells, 29 bytes
	check(HostTui.visibleWidth(STYLED) === 20, `visibleWidth counts cells, not bytes (got ${HostTui.visibleWidth(STYLED)})`);
	check(HostTui.visibleWidth(STYLED) !== STYLED.length, "styled line width differs from byte length");
	check(visibleWidth(STYLED) === 20, "drill oracle (pi-tui visibleWidth) agrees on 20 cells");

	const savedCols = process.stdout.columns;
	try {
		// Overwide styled line into a narrow pty: single first-render frame.
		process.stdout.columns = 10;
		let narrow = "";
		const ntui = new HostTui(10, (s) => {
			narrow += s;
		});
		ntui.render([STYLED]);
		check(narrow.includes("\x1b[?2026h") && narrow.includes("\x1b[?2026l"), "repaint buffer is ?2026-bracketed");
		const body = narrow.replaceAll("\x1b[?2026h", "").replaceAll("\x1b[?2026l", "").replace(/\n$/, "");
		check(visibleWidth(body) === 10, `overwide styled line truncates to the frame width (got ${visibleWidth(body)} cells)`);
		check(body.startsWith("\x1b[31m"), "truncation keeps the in-range style open");
		const ns = replay(narrow);
		check(JSON.stringify(ns.grid) === JSON.stringify(["x".repeat(10)]), `narrow replay converges to the truncated row (got ${JSON.stringify(ns.grid)})`);

		// SIGWINCH/columns change between renders: full re-render at the new
		// width, never 2J. Same logical lines, terminal shrinks 80 -> 40.
		process.stdout.columns = 80;
		let rout = "";
		const rtui = new HostTui(80, (s) => {
			rout += s;
		});
		const R1 = ["aaa", "b".repeat(60)];
		rtui.render(R1);
		rout = "";
		process.stdout.columns = 40;
		rtui.render(R1);
		check(!rout.includes("\x1b[2J"), "resize re-render never 2J-clears");
		check(rout.includes("\x1b[?2026h") && rout.includes("\x1b[?2026l"), "resize buffer is ?2026-bracketed");
		const rewrittenR = [...rout.matchAll(/\x1b\[2K([^\x1b\r\n]*)/g)].map((m) => m[1]);
		check(rewrittenR.length === 2, `resize rewrites every row at the new width (got ${rewrittenR.length})`);
		check(rewrittenR[1] !== undefined && visibleWidth(rewrittenR[1]) <= 40, `60-wide row truncates to the shrunk width (got ${rewrittenR[1] === undefined ? "no rewrite" : `${visibleWidth(rewrittenR[1])} cells`})`);

		// Shrink the frame on the resize path: stale rows clear in place,
		// still no 2J, replay converges, cursor parks below the frame.
		rout = "";
		process.stdout.columns = 30;
		rtui.render(["only"]);
		check(!rout.includes("\x1b[2J"), "resize+shrink clears stale rows without 2J");
		check(rout.includes("\x1b[?2026h") && rout.includes("\x1b[?2026l"), "shrink buffer is ?2026-bracketed");
	} finally {
		if (savedCols === undefined) delete process.stdout.columns;
		else process.stdout.columns = savedCols;
	}
}

// bi#163 RED-CHECK drill — declared frame composition over pi-tui's VStack
// sizing contract (bi/src/tui.ts, composeFrame + renderSelectList + HostFooter
// show ONLY; BAML frame fns keep their signatures).
// Hunk under test:
//   composeFrame resolves visible(viewport) + allocateStackSizes on ordered
//   regions and returns the clipped line array; the select frame + divider
//   compose as one HostTui frame (no direct stdout assembly); HostFooter
//   show() composes footer (minSize 1) + model (minSize 1, visible w>=40).
// Why it was red before: frames assembled by string concatenation with no
// minimum heights, no narrow-terminal guard, no responsive region —
// transcript never yielded, width<40 risked negative padding, model always
// painted. Green after: chrome declares minSize, transcript yields first,
// narrow hides the model line, degenerate widths clamp to 1.
{
	const { composeFrame, HostFooter, renderSelectList, MODEL_LINE_MIN_WIDTH } = await import(join(ROOT, "..", "dist", "src", "tui.js"));
	const { render_divider_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
	check(MODEL_LINE_MIN_WIDTH === 40, "model line hides below width 40");

	const transcript = Array.from({ length: 10 }, (_, k) => `t${k}`);
	const chrome = () => [
		{ lines: transcript, grow: 1, shrink: 1, minSize: 0 },
		{ lines: ["FOOT"], minSize: 1, shrink: 0 },
		{ lines: ["MODEL"], minSize: 1, shrink: 0, visible: (vp) => vp.width >= MODEL_LINE_MIN_WIDTH },
	];

	// Footer + model minSize 1: at 4 rows the transcript yields first.
	const h4 = composeFrame(chrome(), { width: 80, height: 4 });
	check(JSON.stringify(h4) === JSON.stringify(["t8", "t9", "FOOT", "MODEL"]), `4-row frame keeps chrome, transcript yields to tail (got ${JSON.stringify(h4)})`);
	// Tighter screens: chrome still intact, transcript keeps shrinking.
	const h3 = composeFrame(chrome(), { width: 80, height: 3 });
	check(JSON.stringify(h3) === JSON.stringify(["t9", "FOOT", "MODEL"]), `3-row frame keeps both chrome rows (got ${JSON.stringify(h3)})`);
	const h2 = composeFrame(chrome(), { width: 80, height: 2 });
	check(JSON.stringify(h2) === JSON.stringify(["FOOT", "MODEL"]), `2-row frame is chrome-only (got ${JSON.stringify(h2)})`);

	// Narrow widths: no throw, no negative-width padding, model hides.
	for (const w of [39, 10, 1, 0, -5, NaN]) {
		let got = null;
		let threw = null;
		try {
			got = composeFrame(chrome(), { width: w, height: 4 });
		} catch (e) {
			threw = e;
		}
		check(threw === null, `width ${String(w)} renders without throwing`);
		if (got !== null) {
			const cap = Math.max(1, Number.isFinite(Math.floor(w)) && Math.floor(w) > 0 ? Math.floor(w) : 1);
			check(got.every((l) => visibleWidth(l) <= cap), `width ${String(w)} pads never negative (cap ${cap})`);
			check(!got.includes("MODEL"), `width ${String(w)} hides the model line`);
			check(got[got.length - 1] === "FOOT".slice(0, cap), `width ${String(w)} keeps the capped footer row`);
		}
	}

	// Height omitted: passthrough concatenation, width-capped.
	const pass = composeFrame([{ lines: ["aa", "b".repeat(60)], grow: 1 }], { width: 40 });
	check(pass.length === 2 && visibleWidth(pass[1]) <= 40, "height omitted concatenates capped, not clipped");

	// Select path composes frame + divider as ONE HostTui frame: a single
	// ?2026 bracket, divider last, zero raw stdout writes after the frame.
	const realWrite = process.stdout.write.bind(process.stdout);
	let sel = "";
	process.stdout.write = (s) => {
		sel += s;
		return true;
	};
	try {
		await renderSelectList("alpha\nbeta", 0, 40, null);
	} finally {
		process.stdout.write = realWrite;
	}
	const divider = await render_divider_async(40, { theme: null });
	const selBody = sel.replaceAll("\x1b[?2026h", "").replaceAll("\x1b[?2026l", "");
	check(sel.split("\x1b[?2026h").length - 1 === 1, "select renders as a single bracketed frame");
	check(sel.trimEnd().endsWith("\x1b[?2026l"), "select output ends with the bracket close (divider inside, no raw tail write)");
	check(selBody.trimEnd().split("\n").pop() === divider, "select frame closes with the BAML divider");
	check(selBody.includes("alpha") && selBody.includes("beta"), "select frame carries the BAML rows");

	// HostFooter narrow TTY (cols 30): CUP-only install (zero DECSTBM,
	// bi#194), frame pins to N-1, the model row erases (never model
	// text), replay converges.
	let nout = "";
	const nfooter = new HostFooter(() => ({ rows: 24, cols: 30 }), () => true, (s) => {
		nout += s;
	});
	nfooter.show("F1", "M1", "F1");
	check(!/\x1b\[\d*(;\d*)?r/.test(nout), "narrow install writes zero DECSTBM (bi#194 CUP-only)");
	check(nout.includes("\x1b[23;1H\x1b[2KF1"), "narrow install sets frame row 23");
	check(nout.includes("\x1b[24;1H\x1b[2K"), "narrow install erases model row 24");
	check(!nout.includes("M1"), "narrow install never paints model text");
}

if (failures) process.exit(1);
console.log("tui-diff: all green");
