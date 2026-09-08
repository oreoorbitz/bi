// bi/scripts/footer-tips.mjs — bi#186 rotating tips slot conformance.
// Pins: (1) the host mirror of tips_slot_text is byte-identical to the
// BAML policy across ticks/widths, (2) tips rotate on the timer with no
// turn running, repainting the model row only, (3) dispose silences the
// timer (never double-fires, never fires after dispose), (4) a transient
// hint preempts the slot and releases back, (5) pipes get neither tips
// nor hints, (6) default construction loads the BAML corpus async,
// (7) bi#169 abort-hint words resolve from BAML (abort_hint_text).
//
// Red-check (bi#57): removing clearTipsTimer() from HostFooter.reset
// (bi/src/tui.ts) fails `dispose silences the rotation timer` — bytes
// keep arriving after dispose. Verified 2026-09-07: reverted →
// `FAIL dispose silences the rotation timer (got 180 extra bytes)`,
// restored → green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { HostFooter, tipsSlotText } = await import(join(ROOT, "..", "dist", "src", "tui.js"));
const { footer_tips_async, tip_rotate_interval_ms_async, tips_slot_text_async } = await import(
	join(ROOT, "..", "dist", "baml_sdk", "index.js")
);

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome color must be live for the styling pins regardless of caller env.
const savedTheme = process.env.BI_THEME;
const savedNoColor = process.env.NO_COLOR;
delete process.env.BI_THEME;
delete process.env.NO_COLOR;

const F1 = "anthropic/claude-haiku-4-5 · thinking medium · 1 turn · 2 messages";
const M1 = "ctx 200k";

function harness(rows, tty, tips) {
	let out = "";
	const footer = new HostFooter(() => ({ rows, cols: 80 }), () => tty, (s) => {
		out += s;
	}, tips);
	return { footer, bytes: () => out, clear: () => { out = ""; } };
}

// 1 — host mirror is byte-identical to the BAML policy across ticks/widths.
{
	const corpus = await footer_tips_async();
	check(corpus.length >= 4, `BAML corpus loaded (got ${corpus.length})`);
	check((await tip_rotate_interval_ms_async()) === 10000, "BAML cadence is kimi's 10s");
	let mismatches = 0;
	const ticks = [0, 1, 2, corpus.length - 1, corpus.length, corpus.length + 1, 17];
	const widths = [0, 3, 10, 17, 25, 40, 80, 200];
	for (const tick of ticks) {
		for (const width of widths) {
			const host = tipsSlotText(corpus, tick, width);
			const baml = await tips_slot_text_async(tick, width);
			if (host !== baml) {
				mismatches++;
				console.error(`  mirror mismatch tick=${tick} width=${width}: host=${JSON.stringify(host)} baml=${JSON.stringify(baml)}`);
			}
		}
	}
	check(mismatches === 0, `host mirror == BAML tips_slot_text (${ticks.length * widths.length} cases)`);
}

// 2 — rotation without a turn running: the model row advances on the timer.
{
	const h = harness(24, true, { corpus: ["alpha", "bravo", "charlie"], intervalMs: 30 });
	h.footer.show(F1, M1, F1);
	check(h.bytes().includes("alpha | bravo"), "first tick pairs tips 0 and 1");
	h.clear();
	await sleep(110); // ~3 rotations at 30ms
	const bytes = h.bytes();
	check(bytes.includes("\x1b[24;1H"), "rotation repaints the model row");
	check(!bytes.includes("\x1b[23;1H"), "rotation never touches the frame row");
	const pairs = ["alpha | bravo", "bravo | charlie", "charlie | alpha"].filter((p) => bytes.includes(p));
	check(pairs.length >= 2, `rotation advances through pairs (saw ${JSON.stringify(pairs)})`);
	h.footer.dispose();
}

// 3 — dispose silences the timer: zero bytes after the dispose settles.
{
	const h = harness(24, true, { corpus: ["alpha", "bravo"], intervalMs: 30 });
	h.footer.show(F1, M1, F1);
	h.clear();
	h.footer.dispose();
	const settle = h.bytes().length;
	await sleep(100);
	check(h.bytes().length === settle, `dispose silences the rotation timer (got ${h.bytes().length - settle} extra bytes)`);
}

// 4 — transient hint preempts the tip and releases back.
{
	const h = harness(24, true, { corpus: ["alpha", "bravo"], intervalMs: 60000 });
	h.footer.show(F1, M1, F1);
	h.clear();
	h.footer.setHint("working — esc interrupts");
	check(h.bytes().includes("working — esc interrupts"), "hint preempts the tips slot");
	check(!h.bytes().includes("alpha"), "hint shows no tip while set");
	check(h.bytes().includes("\x1b[38;2;79;168;255m"), "hint renders in primary #4FA8FF");
	h.clear();
	h.footer.setHint(null);
	check(h.bytes().includes("alpha | bravo"), "clearing the hint releases back to the tip");
	h.footer.dispose();
}

// 5 — pipes: no tips, no hint output, no timer, fallback byte-shape unchanged.
{
	const h = harness(24, false, { corpus: ["alpha", "bravo"], intervalMs: 30 });
	h.footer.show(F1, M1, F1);
	check(h.bytes() === F1 + "\n" + M1 + "\n", "pipe fallback unchanged with tips configured");
	h.footer.setHint("working");
	await sleep(80);
	check(h.bytes() === F1 + "\n" + M1 + "\n", "pipes stay silent on hints and ticks");
}

// 7 — abort hint words are BAML-shaped (bi#169): the host paints
// abort_hint_text verbatim into the transient channel.
{
	const { abort_hint_text_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));
	check((await abort_hint_text_async()) === "turn aborted — transcript unchanged", "abort hint text comes from BAML");
}

// 6 — default wiring: no tips arg → async BAML corpus load reveals the slot.
{
	let out = "";
	const footer = new HostFooter(() => ({ rows: 24, cols: 80 }), () => true, (s) => {
		out += s;
	});
	footer.show(F1, M1, F1);
	const corpus = await footer_tips_async();
	const deadline = Date.now() + 5000;
	let found = false;
	while (Date.now() < deadline && !found) {
		await sleep(25);
		found = corpus.some((t) => out.includes(t));
	}
	check(found, "default construction loads the BAML tips corpus async");
	footer.dispose();
}

if (savedTheme === undefined) delete process.env.BI_THEME;
else process.env.BI_THEME = savedTheme;
if (savedNoColor === undefined) delete process.env.NO_COLOR;
else process.env.NO_COLOR = savedNoColor;

if (failures) process.exit(1);
console.log("footer-tips: all green");
