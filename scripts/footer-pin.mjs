// bi/scripts/footer-pin.mjs — HostFooter conformance (bi#67 + brand model row
// + bi#184 row dedup + bi#186 tips slot shape).
// Captures the byte stream, replays it on a region-aware virtual screen,
// and asserts (1) pipes get the plain printed footer plus the plain model
// line with zero escapes, (2) TTY setup reserves the last TWO rows via
// DECSTBM (frame row N-1, brand model row N), (3) repaints are differential
// per row (unchanged rows write zero bytes, changed rows rewrite without
// clear/reset), (4) both rows survive region scrolling, (5) resize
// reinstalls, (6) dispose resets the region and erases both rows, and
// (7) the BAML frame is byte-identical to format_repl_footer on wide
// terminals (the contract the host's pipe fallback relies on).
// bi#184: the model row is ctx-only — the provider/model · thinking
// prefix lives exclusively on the frame row. bi#186: sections 13+ pin
// the right-aligned muted tips slot on the model row; rotation/dispose/
// hint behavior lives in footer-tips.mjs. Harnesses inject an empty tips
// corpus so the async BAML corpus load stays out of the byte pins.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { HostFooter } = await import(join(ROOT, "..", "dist", "src", "tui.js"));
const { render_footer_frame_async, format_repl_footer_async, render_model_line_async } = await import(
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
			// SGR (…m): zero-width styling — skipped, never grid content.
			const sgr = bytes.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (sgr) {
				i += sgr[0].length;
				continue;
			}
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
// bi#184: the model row is ctx-only (the repeated prefix moved to row 1).
const M1 = "ctx 200k";
const M2 = "ctx 128k";

function harness(rows, tty, tips = { corpus: [] }) {
	let out = "";
	const footer = new HostFooter(() => ({ rows, cols: 80 }), () => tty, (s) => {
		out += s;
	}, tips);
	return { footer, bytes: () => out, clear: () => { out = ""; } };
}

// 1 — pipe fallback: plain footer + plain model line, zero escapes, silent dispose.
{
	const h = harness(24, false);
	h.footer.show(F1, M1, F1);
	check(h.bytes() === F1 + "\n" + M1 + "\n", `pipe fallback prints both plain lines (got ${JSON.stringify(h.bytes())})`);
	check(!h.bytes().includes("\x1b"), "pipe fallback emits zero escapes");
	h.clear();
	h.footer.dispose();
	check(h.bytes() === "", "dispose without install is silent");
}

// 2 — TTY setup: DECSTBM reserves the last two rows, cursor restored.
{
	const h = harness(24, true);
	h.footer.show(F1, M1, F1);
	check(h.bytes().includes("\x1b[1;22r"), "setup installs scroll region 1..22");
	check(h.bytes().includes("\x1b[23;1H"), "setup addresses frame row 23");
	check(h.bytes().includes("\x1b[24;1H"), "setup addresses model row 24");
	const screen = replay(h.bytes());
	check(screen.grid.length === 24 && screen.grid[22] === F1 && screen.grid[23] === M1, `frame lands on 23, model on 24 (got ${JSON.stringify(screen.grid[22])} / ${JSON.stringify(screen.grid[23])})`);
	check(screen.cursor[0] === 0 && screen.cursor[1] === 0, `cursor restored to transcript (got ${JSON.stringify(screen.cursor)})`);
}

// 3 — differential: unchanged repaint writes zero bytes.
{
	const h = harness(24, true);
	h.footer.show(F1, M1, F1);
	h.clear();
	h.footer.show(F1, M1, F1);
	check(h.bytes() === "", "unchanged footer writes zero bytes");
}

// 4 — changed repaint: no clear, no region reset, only changed rows update.
{
	const h = harness(24, true);
	h.footer.show(F1, M1, F1);
	h.clear();
	h.footer.show(F2, M1, F1);
	check(!h.bytes().includes("\x1b[2J"), "repaint never full-clears");
	check(!h.bytes().includes("\x1b[r"), "repaint keeps the region (no reset)");
	check(h.bytes().includes("\x1b[23;1H"), "frame-only change re-addresses row 23");
	check(!h.bytes().includes("\x1b[24;1H"), "frame-only change leaves row 24 alone");
	const screen = replay(h.bytes());
	check(screen.grid[22] === F2, "repainted frame row converges");
	h.clear();
	h.footer.show(F2, M2, F1);
	check(h.bytes().includes("\x1b[24;1H"), "model-only change re-addresses row 24");
	check(!h.bytes().includes("\x1b[23;1H"), "model-only change leaves row 23 alone");
	const screen2 = replay(h.bytes());
	check(screen2.grid[23] === M2, "repainted model row converges");
}

// 5 — region scroll: transcript scrolls above both pinned rows.
{
	const h = harness(24, true);
	h.footer.show(F1, M1, F1);
	const install = h.bytes();
	h.clear();
	let transcript = "";
	for (let n = 0; n < 30; n++) transcript += `t${n}\n`;
	// Transcript (stdout) and footer (stderr) share the terminal: the
	// install paints both rows first, then output scrolls the region.
	const screen = replay(install + transcript);
	check(screen.grid[22] === F1, "frame survives 30 scrolled lines");
	check(screen.grid[23] === M1, "model row survives 30 scrolled lines");
	// The last newline scrolled and left the cursor row empty — a real
	// terminal shows the same: 21 lines plus the empty cursor row.
	check(
		JSON.stringify(screen.grid.slice(0, 21)) === JSON.stringify(Array.from({ length: 21 }, (_, k) => `t${k + 9}`)) &&
			screen.grid[21] === "",
		`transcript window is t9..t29 plus empty cursor row (got ${JSON.stringify(screen.grid[0])}..${JSON.stringify(screen.grid[21])})`,
	);
}

// 6 — resize reinstalls the region and repaints even for identical text.
{
	let rows = 24;
	let out = "";
	const footer = new HostFooter(() => ({ rows, cols: 80 }), () => true, (s) => {
		out += s;
	}, { corpus: [] });
	footer.show(F1, M1, F1);
	out = "";
	rows = 20;
	footer.show(F1, M1, F1);
	check(out.includes("\x1b[1;18r"), "resize reinstalls the region");
	const screen = replay(out);
	check(screen.grid[18] === F1, "frame re-pins to row 19");
	check(screen.grid[19] === M1, "model re-pins to the new bottom row");
}

// 7 — dispose: region reset, both rows erased, transcript intact.
{
	const h = harness(24, true);
	h.footer.show(F2, M2, F1);
	h.clear();
	h.footer.dispose();
	check(h.bytes().includes("\x1b[r"), "dispose resets the scroll region");
	const screen = replay(h.bytes());
	check(screen.grid[22] === "" && screen.grid[23] === "", "dispose erases both rows");
	check(screen.region.bottom === Number.POSITIVE_INFINITY, "region is full after dispose");
}

// 8 — degenerate screen (rows < 3): plain fallback, no escapes.
{
	const h = harness(2, true);
	h.footer.show(F1, M1, F1);
	check(h.bytes() === F1 + "\n" + M1 + "\n", "2-row screen falls back to plain lines");
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

// 10 — location segments: cwd/branch appended when present, omitted when null.
{
	const base = await format_repl_footer_async("xai", "grok-4.6", "high", 2, 5, { theme: null });
	check(base === "xai/grok-4.6 · thinking high · 2 turns · 5 messages", "null segments render the legacy footer");
	const withLoc = await format_repl_footer_async("xai", "grok-4.6", "high", 2, 5, { theme: null, cwd: "~/bi", branch: "main" });
	check(withLoc === `${base} · ~/bi · main`, `segments append in order (got ${JSON.stringify(withLoc)})`);
	const cwdOnly = await format_repl_footer_async("xai", "grok-4.6", "high", 2, 5, { theme: null, cwd: "~/bi" });
	check(cwdOnly === `${base} · ~/bi`, "cwd alone appends without branch");
	const frameLoc = await render_footer_frame_async("xai", "grok-4.6", "high", 2, 5, 200, { theme: null, cwd: "~/bi", branch: "main" });
	check(frameLoc === withLoc, "wide frame with segments is byte-identical to the printed footer");
}

// 12 — model line (bi#184): ctx-only shaping, brand wrap, stale-safe, width-capped.
{
	const plain = await render_model_line_async("anthropic", "claude-haiku-4-5", "medium", 200, { theme: null });
	check(plain === "ctx 200k", `plain model line carries ctx only (got ${JSON.stringify(plain)})`);
	// The dedup: no fact from the frame row repeats on the model row.
	check(!plain.includes("anthropic") && !plain.includes("thinking"), "model row repeats neither backend nor thinking");
	const styled = await render_model_line_async("anthropic", "claude-haiku-4-5", "medium", 200, { theme: "default" });
	check(styled.includes("\x1b[38;2;168;85;247m") && styled.endsWith("\x1b[0m"), "default theme wraps the line in BAML purple");
	const none = await render_model_line_async("anthropic", "claude-haiku-4-5", "medium", 200, { theme: "none" });
	check(none === plain, "none theme degrades to the plain line");
	const stale = await render_model_line_async("anthropic", "nope-xyz", "medium", 200, { theme: null });
	check(stale === "", `stale id renders an empty row, never bricks (got ${JSON.stringify(stale)})`);
	const narrow = await render_model_line_async("anthropic", "claude-haiku-4-5", "medium", 6, { theme: null });
	check(narrow === "ctx 20…", `narrow caps to one row (got ${JSON.stringify(narrow)})`);
}

// 13 — bi#186 tips slot: right-aligned on the model row, textMuted.
{
	const savedTheme = process.env.BI_THEME;
	const savedNoColor = process.env.NO_COLOR;
	delete process.env.BI_THEME;
	delete process.env.NO_COLOR;
	try {
		const h = harness(24, true, { corpus: ["tip one", "tip two"], intervalMs: 60000 });
		h.footer.show(F1, M1, F1);
		const screen = replay(h.bytes());
		const row = screen.grid[23];
		check(row.startsWith("ctx 200k"), `model row keeps the ctx content on the left (got ${JSON.stringify(row)})`);
		check(row.endsWith("tip one | tip two"), `tips pair right-aligns on the model row (got ${JSON.stringify(row)})`);
		check(row.length === 80, `tips row pads to the full width (got ${row.length})`);
		check(h.bytes().includes("\x1b[38;2;107;107;107m"), "tips render in textMuted #6B6B6B");
		check(screen.grid[22] === F1, "frame row untouched by the tips slot");
		// Pipes: no tips, no escapes, fallback byte-shape unchanged.
		const p = harness(24, false, { corpus: ["tip one", "tip two"], intervalMs: 60000 });
		p.footer.show(F1, M1, F1);
		check(p.bytes() === F1 + "\n" + M1 + "\n", "pipe fallback carries no tips and no escapes");
	} finally {
		if (savedTheme === undefined) delete process.env.BI_THEME;
		else process.env.BI_THEME = savedTheme;
		if (savedNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = savedNoColor;
	}
}

// 11 — host segment suppliers (footer_info): ~/ collapse, branch oracle.
{
	const { execFileSync } = await import("node:child_process");
	const { footerCwd, gitBranch } = await import(join(ROOT, "..", "dist", "src", "footer_info.js"));
	const cwd = process.cwd();
	const savedHome = process.env.HOME;
	process.env.HOME = dirname(cwd);
	try {
		check(footerCwd() === `~/${cwd.split("/").pop()}`, `cwd collapses under HOME (got ${JSON.stringify(footerCwd())})`);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	}
	// Independent oracle: git itself, not our parsing.
	let expected = null;
	try {
		expected = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
		if (expected === "HEAD") expected = null;
	} catch {
		expected = null;
	}
	check(gitBranch() === expected, `branch matches git oracle (got ${JSON.stringify(gitBranch())})`);
	// Outside any repo the branch is null (never throws, never "HEAD").
	const probe = execFileSync(process.execPath, ["--input-type=module", "-e",
		`import(${JSON.stringify(join(ROOT, "..", "dist", "src", "footer_info.js"))}).then((m) => process.stdout.write(String(m.gitBranch())))`,
	], { cwd: "/tmp", encoding: "utf8" });
	check(probe === "null", `non-repo cwd yields null branch (got ${JSON.stringify(probe)})`);
}

if (failures) process.exit(1);
console.log("footer-pin: all green");
