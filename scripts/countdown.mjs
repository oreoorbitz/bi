// bi/scripts/countdown.mjs — offline harness for bi#95 (plain node, real timers).
// Proves the shared CountdownTimer primitive: expire fires exactly once,
// unmount (dispose) always clears the interval, and a login-expiry dialog
// plus a retry countdown share the implementation with BAML-shaped labels.
// No live-login testing: the consumer is future bi#94.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(fileURLToPath(import.meta.url));
const { CountdownTimer, countdown_label, countdown_retry_text, format_countdown_text } = await import(
	join(ROOT, "..", "dist", "src", "countdown.js")
);
// BAML-side shaping straight from the SDK (host must not re-shape seconds).
const { format_countdown, countdown_title } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- BAML owns second-formatting ---
check("baml format 7s", format_countdown(7) === "7s", JSON.stringify(format_countdown(7)));
check("baml format clamps negative", format_countdown(-3) === "0s");
check("baml title shape", countdown_title("Sign in", 5) === "Sign in (5s)");
check("host label delegates to baml", countdown_label("Sign in", 5) === "Sign in (5s)");
check("host retry text delegates to baml", countdown_retry_text(1, 3, 7) === "Retrying (1/3) in 7s...");
check("host bare duration", format_countdown_text(9) === "9s");

// --- expire fires exactly once ---
{
	const ticks = [];
	let expires = 0;
	new CountdownTimer(1100, undefined, (s) => ticks.push(s), () => expires++);
	await sleep(2600); // ceil(1100/1000)=2: ticks at 0s,1s,2s(+expire)
	check("expiry tick sequence", JSON.stringify(ticks) === JSON.stringify([2, 1, 0]), JSON.stringify(ticks));
	check("expire fires exactly once", expires === 1, `expires=${expires}`);
	await sleep(1300); // a refiring interval would strike again here
	check("expire never refires", expires === 1, `expires=${expires}`);
}

// --- unmount always clears the interval (no stray ticks after Esc) ---
{
	const ticks = [];
	let expires = 0;
	const t = new CountdownTimer(8000, undefined, (s) => ticks.push(s), () => expires++);
	await sleep(1300); // let 1-2 ticks land: [8, 7]
	t.dispose(); // Esc: unmount the dialog
	const frozen = ticks.length;
	check("timer ticked before unmount", frozen >= 1, `ticks=${JSON.stringify(ticks)}`);
	check("settled after dispose", t.settled === true);
	t.dispose(); // double-dispose must be safe
	await sleep(1500); // a live interval would tick again here
	check("no stray ticks after unmount", ticks.length === frozen, `ticks=${JSON.stringify(ticks)}`);
	check("no expiry after unmount", expires === 0, `expires=${expires}`);
}

// --- login expiry + retry countdown share the implementation ---
{
	let loginTitle = "";
	let retryLine = "";
	let logins = 0;
	let retries = 0;
	const renders = { n: 0 };
	const target = { requestRender: () => renders.n++ };
	// bi#94-style consumer: device-code dialog title with expiry cancel.
	const login = new CountdownTimer(1100, target, (s) => (loginTitle = countdown_label("Sign in", s)), () => logins++);
	// Retry-style consumer: status-indicator line, cancel-safe.
	const retry = new CountdownTimer(
		1100,
		target,
		(s) => (retryLine = countdown_retry_text(1, 3, s)),
		() => retries++,
	);
	check("both timers tick from one class", login instanceof CountdownTimer && retry instanceof CountdownTimer);
	await sleep(2600);
	check(
		"login title shows BAML-shaped expiry",
		loginTitle === "Sign in (0s)" && logins === 1,
		`title=${JSON.stringify(loginTitle)} expires=${logins}`,
	);
	check(
		"retry line shows BAML-shaped countdown",
		retryLine === "Retrying (1/3) in 0s..." && retries === 1,
		`line=${JSON.stringify(retryLine)} expires=${retries}`,
	);
	check("render target nudged on ticks", renders.n >= 2, `renders=${renders.n}`);
	check("both timers settled", login.settled && retry.settled);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PROBE ALL PASS" : `PROBE ${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
