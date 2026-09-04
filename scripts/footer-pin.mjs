// bi/scripts/footer-pin.mjs — HostFooter conformance (bi#67).
// Captures the byte stream, replays it on a region-aware virtual screen,
// and asserts (1) pipes get the plain printed footer byte-identical to the
// old console.error readout with zero escapes, (2) TTY setup reserves the
// last row via DECSTBM, (3) repaints are differential (unchanged line
// writes zero bytes, changed rows rewrite without clear/reset), (4) the
// footer survives region scrolling, (5) resize reinstalls, (6) dispose
// resets the region and erases the footer row, and (7) the BAML frame is
// byte-identical to format_repl_footer on wide terminals (the contract
// the host's pipe fallback relies on).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { HostFooter } = await import(join(ROOT, "..", "dist", "src", "tui.js"));
const { render_footer_frame_async, format_repl_footer_async } = await import(
	join(ROOT, "..", "dist", "baml_sdk", "index.js")
);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Region-aware screen: printable runs, \n (scrolls inside DECSTBM),
// \r, EL 2K, save/restore, CUP row;colH, DECSTBM top;bottom r / reset r.
// Anything else throws (byte contract stays explicit).
function replay(bytes) {
	const grid = [""];
	let y = 0;
	let x = 0;
	let saved = null;
	let region = { top: 1, bottom: Number.POSITIVE_INFINITY };
	const ensure = (r) => {
		while (grid.length <= r) grid.push("");
	};
	let i = 0;
	while (i < bytes.length) {
		const c = bytes[i];
		if (c === "\n") {
			x = 0;
			const bottomIdx = region.bottom === Number.POSITIVE_INFINITY ? -1 : region.bottom - 1;
			if (y === bottomIdx) {
				// Scroll the region up one, clear the freed bottom row.
				for (let r = region.top - 1; r < bottomIdx; r++) grid[r] = grid[r + 1] ?? "";
				grid[bottomIdx] = "";
			} else {
				y++;
				ensure(y);
			}
			i++;
			continue;
		}
		if (c === "\r") {
			x = 0;
			i++;
			continue;
		}
		if (c === "\x1b" && bytes[i + 1] === "[") {
			const m = bytes.slice(i).match(/^\x1b\[(\d*)(?:;(\d*))?([rHsuAJK])/);
			if (!m) throw new Error(`unsupported escape at offset ${i}: ${JSON.stringify(bytes.slice(i, i + 10))}`);
			const n1 = m[1] === "" ? null : Number(m[1]);
			const n2 = m[2] == null || m[2] === "" ? null : Number(m[2]);
			const op = m[3];
			if (op === "r") {
				region = n1 == null ? { top: 1, bottom: Number.POSITIVE_INFINITY } : { top: n1, bottom: n2 ?? 24 };
			} else if (op === "H") {
				y = (n1 ?? 1) - 1;
				x = (n2 ?? 1) - 1;
				ensure(y);
			} else if (op === "K") {
				ensure(y);
				grid[y] = "";
				x = 0;
			} else if (op === "s") {
				saved = [y, x];
			} else if (op === "u") {
				[y, x] = saved ?? [0, 0];
			} else if (op === "A") {
				y = Math.max(0, y - (n1 ?? 1));
			} else if (op === "J") {
				grid.length = 0;
				grid.push("");
				y = 0;
				x = 0;
			}
			i += m[0].length;
			continue;
		}
		ensure(y);
		grid[y] = grid[y].slice(0, x) + c + grid[y].slice(x + 1);
		x++;
		i++;
	}
	return { grid, cursor: [y, x], region };
}

const F1 = "anthropic/claude-haiku-4-5 · thinking medium · 1 turn · 2 messages";
const F2 = "anthropic/claude-haiku-4-5 · thinking medium · 2 turns · 4 messages";

function harness(rows, tty) {
	let out = "";
	const footer = new HostFooter(() => ({ rows, cols: 80 }), () => tty, (s) => {
		out += s;
	});
	return { footer, bytes: () => out, clear: () => { out = ""; } };
}

// 1 — pipe fallback: byte-identical plain line, zero escapes, silent dispose.
{
	const h = harness(24, false);
	h.footer.show(F1, F1);
	check(h.bytes() === F1 + "\n", `pipe fallback prints plain line (got ${JSON.stringify(h.bytes())})`);
	check(!h.bytes().includes("\x1b"), "pipe fallback emits zero escapes");
	h.clear();
	h.footer.dispose();
	check(h.bytes() === "", "dispose without install is silent");
}

// 2 — TTY setup: DECSTBM reserves the last row, cursor restored.
{
	const h = harness(24, true);
	h.footer.show(F1, F1);
	check(h.bytes().includes("\x1b[1;23r"), "setup installs scroll region 1..23");
	check(h.bytes().includes("\x1b[24;1H"), "setup addresses bottom row 24");
	const screen = replay(h.bytes());
	check(screen.grid.length === 24 && screen.grid[23] === F1, `footer lands on row 24 (got ${JSON.stringify(screen.grid[23])})`);
	check(screen.cursor[0] === 0 && screen.cursor[1] === 0, `cursor restored to transcript (got ${JSON.stringify(screen.cursor)})`);
}

// 3 — differential: unchanged repaint writes zero bytes.
{
	const h = harness(24, true);
	h.footer.show(F1, F1);
	h.clear();
	h.footer.show(F1, F1);
	check(h.bytes() === "", "unchanged footer writes zero bytes");
}

// 4 — changed repaint: no clear, no region reset, row updated in place.
{
	const h = harness(24, true);
	h.footer.show(F1, F1);
	h.clear();
	h.footer.show(F2, F2);
	check(!h.bytes().includes("\x1b[2J"), "repaint never full-clears");
	check(!h.bytes().includes("\x1b[r"), "repaint keeps the region (no reset)");
	check(h.bytes().includes("\x1b[24;1H"), "repaint re-addresses the bottom row");
	const screen = replay(h.bytes());
	check(screen.grid[23] === F2, "repainted row converges to the new footer");
}

// 5 — region scroll: transcript scrolls above the pinned footer.
{
	const h = harness(24, true);
	h.footer.show(F1, F1);
	const install = h.bytes();
	h.clear();
	let transcript = "";
	for (let n = 0; n < 30; n++) transcript += `t${n}\n`;
	// Transcript (stdout) and footer (stderr) share the terminal: the
	// install paints the footer first, then output scrolls the region.
	const screen = replay(install + transcript);
	check(screen.grid[23] === F1, "footer survives 30 scrolled lines");
	// The last newline scrolled and left the cursor row empty — a real
	// terminal shows the same: 22 lines plus the empty cursor row.
	check(
		JSON.stringify(screen.grid.slice(0, 22)) === JSON.stringify(Array.from({ length: 22 }, (_, k) => `t${k + 8}`)) &&
			screen.grid[22] === "",
		`transcript window is t8..t29 plus empty cursor row (got ${JSON.stringify(screen.grid[0])}..${JSON.stringify(screen.grid[22])})`,
	);
}

// 6 — resize reinstalls the region and repaints even for identical text.
{
	let rows = 24;
	let out = "";
	const footer = new HostFooter(() => ({ rows, cols: 80 }), () => true, (s) => {
		out += s;
	});
	footer.show(F1, F1);
	out = "";
	rows = 20;
	footer.show(F1, F1);
	check(out.includes("\x1b[1;19r"), "resize reinstalls the region");
	const screen = replay(out);
	check(screen.grid[19] === F1, "footer re-pins to the new bottom row");
}

// 7 — dispose: region reset, footer row erased, transcript intact.
{
	const h = harness(24, true);
	h.footer.show(F2, F2);
	h.clear();
	h.footer.dispose();
	check(h.bytes().includes("\x1b[r"), "dispose resets the scroll region");
	const screen = replay(h.bytes());
	check(screen.grid[23] === "", "dispose erases the footer row");
	check(screen.region.bottom === Number.POSITIVE_INFINITY, "region is full after dispose");
}

// 8 — degenerate screen (rows < 2): plain fallback, no escapes.
{
	const h = harness(1, true);
	h.footer.show(F1, F1);
	check(h.bytes() === F1 + "\n", "1-row screen falls back to the plain line");
	check(!h.bytes().includes("\x1b"), "degenerate screen emits zero escapes");
}

// 9 — BAML contract: wide frame is byte-identical to the printed footer.
{
	const wide = await render_footer_frame_async("xai", "grok-4.6", "high", 2, 5, 80, { theme: null });
	const plain = await format_repl_footer_async("xai", "grok-4.6", "high", 2, 5, { theme: null });
	check(wide === plain, "wide frame is byte-identical to format_repl_footer");
	const narrow = await render_footer_frame_async("xai", "grok-4.6", "high", 2, 5, 12, { theme: null });
	check(narrow === "xai/grok-4.6…", `narrow frame caps to one row (got ${JSON.stringify(narrow)})`);
}

if (failures) process.exit(1);
console.log("footer-pin: all green");
