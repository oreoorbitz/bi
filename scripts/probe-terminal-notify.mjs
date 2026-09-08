// /tmp/b171-probe/terminal-notify.mjs — bi#171 verification probe (plain node).
// Follows bi/scripts/*.mjs style: check() lines + nonzero exit on failure.
// Imports the built host (bi/dist), so run `npm run build --prefix bi` first.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "/Users/adrian/code/orion/orion-learn-baml/bi";
const {
	TerminalNotifier,
	notifyTurnComplete,
	notifyApprovalRequired,
	buildTerminalNotificationSequences,
	supportsOsc9Notification,
	isInsideTmux,
	formatTerminalNotification,
	terminalNotifyGate,
	TERMINAL_ESC,
	TERMINAL_BEL,
} = await import(join(ROOT, "dist", "src", "notify.js"));

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function ttySink() {
	const writes = [];
	return { sink: { isTTY: true, write: (s) => writes.push(s) }, writes };
}
function pipeSink() {
	const writes = [];
	return { sink: { write: (s) => writes.push(s) }, writes }; // isTTY undefined
}

// --- 1. pure sequence builders (kimi parity) ---
check(
	"osc9 shape",
	buildTerminalNotificationSequences("hi", { supportsOsc9: true, insideTmux: false })[0] ===
		`${TERMINAL_ESC}]9;hi${TERMINAL_BEL}`,
);
check(
	"bel fallback",
	JSON.stringify(buildTerminalNotificationSequences("hi", { supportsOsc9: false, insideTmux: false })) ===
		JSON.stringify([TERMINAL_BEL]),
);
check(
	"bel fallback ignores tmux",
	JSON.stringify(buildTerminalNotificationSequences("hi", { supportsOsc9: false, insideTmux: true })) ===
		JSON.stringify([TERMINAL_BEL]),
);
{
	const [seq] = buildTerminalNotificationSequences("hi", { supportsOsc9: true, insideTmux: true });
	check(
		"tmux dcs wrap",
		seq === `${TERMINAL_ESC}Ptmux;${TERMINAL_ESC}${TERMINAL_ESC}]9;hi${TERMINAL_BEL}${TERMINAL_ESC}\\`,
		JSON.stringify(seq),
	);
}
check("empty message emits nothing", buildTerminalNotificationSequences("", { supportsOsc9: true, insideTmux: false }).length === 0);

// --- 2. allow-list matrix ---
check("iterm osc9", supportsOsc9Notification({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }) === true);
check("wezterm osc9", supportsOsc9Notification({ TERM_PROGRAM: "WezTerm" }) === true);
check("ghostty osc9", supportsOsc9Notification({ TERM_PROGRAM: "ghostty" }) === true);
check("warp osc9", supportsOsc9Notification({ TERM_PROGRAM: "WarpTerminal" }) === true);
check("kitty osc9 via TERM", supportsOsc9Notification({ TERM: "xterm-kitty" }) === true);
check("xterm-ghostty osc9 via TERM", supportsOsc9Notification({ TERM: "xterm-ghostty" }) === true);
check("plain xterm bel", supportsOsc9Notification({ TERM: "xterm-256color" }) === false);
check("empty env bel", supportsOsc9Notification({}) === false);
check("tmux detected", isInsideTmux({ TMUX: "/tmp/tmux-1,2,3" }) === true);
check("no tmux", isInsideTmux({}) === false);

// --- 3. BAML shaping + sanitize ---
check("baml join", formatTerminalNotification("bi turn complete") === "bi turn complete");
check("baml title+body", formatTerminalNotification("t", "b") === "t: b");
check("baml strips controls", formatTerminalNotification("abc", "x\ny") === "a b c: x y");
{
	const out = formatTerminalNotification("m", "x".repeat(500));
	check("baml caps 240", out.length === 240, `len=${out.length}`);
}
check("baml empty shapes empty", formatTerminalNotification("", "") === "");

// --- 4. gate: unset = disabled (byte-identical today) ---
for (const v of [undefined, null, "off", "loud-typo"]) {
	check(`gate disabled for ${JSON.stringify(v)}`, terminalNotifyGate(v).enabled === false);
}
check("gate unfocused", JSON.stringify(terminalNotifyGate("unfocused")) === JSON.stringify({ enabled: true, condition: "unfocused" }));
check("gate always", JSON.stringify(terminalNotifyGate("always")) === JSON.stringify({ enabled: true, condition: "always" }));

// --- 5. notifyOnce behavior ---
{
	const n = new TerminalNotifier();
	const { sink, writes } = ttySink();
	const r = notifyTurnComplete(n, 3, { setting: undefined, stream: sink, supportsOsc9: false });
	check("SILENCE unset key emits zero bytes", r === false && writes.length === 0, `r=${r} writes=${writes.length}`);
}
{
	const n = new TerminalNotifier();
	const { sink, writes } = pipeSink();
	const r = notifyTurnComplete(n, 3, { setting: "always", stream: sink, supportsOsc9: false });
	check("SILENCE pipe emits nothing", r === false && writes.length === 0, `r=${r} writes=${writes.length}`);
}
{
	const n = new TerminalNotifier();
	const { sink, writes } = ttySink();
	const r1 = notifyTurnComplete(n, 7, { setting: "always", stream: sink, supportsOsc9: false });
	check("emit once per turn", r1 === true && writes.length === 1 && writes[0] === TERMINAL_BEL, `writes=${writes.length}`);
	const r2 = notifyTurnComplete(n, 7, { setting: "always", stream: sink, supportsOsc9: false });
	check("dedupe same key", r2 === false && writes.length === 1, `writes=${writes.length}`);
	const r3 = notifyTurnComplete(n, 8, { setting: "always", stream: sink, supportsOsc9: false });
	check("next turn pages again", r3 === true && writes.length === 2, `writes=${writes.length}`);
	const r4 = notifyTurnComplete(n, 1, { session: "sess-A", setting: "always", stream: sink, supportsOsc9: false });
	const r5 = notifyTurnComplete(n, 1, { session: "sess-A", setting: "always", stream: sink, supportsOsc9: false });
	const r6 = notifyTurnComplete(n, 1, { session: "sess-B", setting: "always", stream: sink, supportsOsc9: false });
	check("session-scoped keys survive /new reset", r4 === true && r5 === false && r6 === true && writes.length === 4, `writes=${writes.length}`);
}
{
	const n = new TerminalNotifier();
	const { sink, writes } = ttySink();
	const r = notifyTurnComplete(n, 1, { setting: "unfocused", focused: true, stream: sink, supportsOsc9: false });
	check("unfocused gate suppresses focused", r === false && writes.length === 0);
	const r2 = notifyTurnComplete(n, 2, { setting: "always", focused: true, stream: sink, supportsOsc9: false });
	check("always pages focused", r2 === true && writes.length === 1);
}
{
	// payload carries no smuggled control bytes (BEL terminator + ESC framing only)
	const n = new TerminalNotifier();
	const { sink, writes } = ttySink();
	notifyTurnComplete(n, 1, { setting: "always", stream: sink, supportsOsc9: true, insideTmux: false });
	const seq = writes[0];
	const payload = seq.slice(`${TERMINAL_ESC}]9;`.length, -1);
	check("payload control-free", !/[\x00-\x1f\x7f-\x9f]/.test(payload), JSON.stringify(payload));
}
{
	// approval reuse helper: same machinery, independent key namespace
	const n = new TerminalNotifier();
	const { sink, writes } = ttySink();
	const r1 = notifyApprovalRequired(n, "a1", "edit", { setting: "always", stream: sink, supportsOsc9: false });
	const r2 = notifyApprovalRequired(n, "a1", "edit", { setting: "always", stream: sink, supportsOsc9: false });
	check("approval emits + dedupes", r1 === true && r2 === false && writes.length === 1);
	const r3 = notifyApprovalRequired(n, "a2", "edit", { setting: undefined, stream: sink, supportsOsc9: false });
	check("approval silent when unset", r3 === false && writes.length === 1);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PROBE ALL PASS" : `PROBE ${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
