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

// Count change still full-clears and converges.
out = "";
tui.render([...B, "bi#04  Delta"]);
check(out.startsWith("\x1b[2J\x1b[H"), "count change full-clears");
const screen2 = replay(firstBytes + repaint + out);
check(JSON.stringify(screen2.grid) === JSON.stringify([...B, "bi#04  Delta"]), "grown frame converges after clear");

if (failures) process.exit(1);
console.log("tui-diff: all green");
