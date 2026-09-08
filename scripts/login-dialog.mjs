// bi/scripts/login-dialog.mjs — offline harness for bi#94 (plain node).
// Proves the in-REPL login dialog without any network: BAML shapes every
// rendered string, the dialog drives device-code expiry through the shared
// CountdownTimer (bi#95), Esc/expiry cancel without killing the session,
// and runLoginDialog is consumer-ready for the merger's /login wiring.
// Fake flow-login functions stand in for the network; no TTY needed
// (explicit stub prompters — the default TTY/modal prompter is TTY-gated
// and never fires here).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "..", "dist", "src");
const SDK = join(ROOT, "..", "dist", "baml_sdk", "index.js");

const {
	LoginDialog,
	LoginDialogError,
	runLoginDialog,
	loginBoardIndex,
	loginExpiredNotice,
	defaultDialogPrompter,
} = await import(join(DIST, "login_dialog.js"));
const { Credential } = await import(SDK);
const { modifyCredential } = await import(join(DIST, "auth.js"));

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stubWriter() {
	return { prints: [], lives: [], print(s) { this.prints.push(s); }, live(s) { this.lives.push(s); } };
}
const fakeCred = () =>
	new Credential({ provider_id: "x", type: "oauth", key: null, refresh: "r", access: "a", expires: null, account_id: null });

// --- BAML owns every rendered string ---
{
	const m = await import(SDK);
	check("baml title", m.login_dialog_title("Anthropic") === "Login to Anthropic");
	check(
		"baml device block",
		m.login_device_block("https://e.com/d", "AB-12") === "Enter this code at https://e.com/d:\n  AB-12",
	);
	check(
		"baml auth-url block",
		m.login_auth_url_block("https://e.com/a", "Cmd+click") ===
			"Complete login in your browser:\nhttps://e.com/a\nCmd+click to open",
	);
	check("baml waiting line", m.login_waiting_line() === "Waiting for authentication...");
	check("baml row hint", m.login_row_hint("xai", 7) === "/oauth 7 — xai");
	check(
		"baml expired notice",
		m.login_expired_notice("anthropic", 1) ===
			"Stored credential for anthropic expired — refreshing (see /oauth 1 — anthropic)",
	);
	check(
		"baml terminal lines",
		m.login_cancelled_line("A") === "Login to A cancelled — nothing stored, session unchanged." &&
			m.login_success_line("A") === "Logged in to A.",
	);
}

// --- frame: title + deep-link hint, in order ---
{
	const w = stubWriter();
	const d = new LoginDialog("anthropic", { providerName: "Anthropic", boardIndex: 1, writer: w });
	d.showFrame();
	check("frame title first", w.prints.some((s) => s.includes("Login to Anthropic")), JSON.stringify(w.prints));
	check("frame deep-link hint", w.prints.includes("/oauth 1 — anthropic"), JSON.stringify(w.prints));
	d.dispose();
}

// --- success path: frame, device block, success line; timer disposed ---
{
	const w = stubWriter();
	const d = new LoginDialog("x-flow", { boardIndex: 2, writer: w, prompter: async () => "code" });
	const cred = await d.run(async (flow, interaction) => {
		interaction.notify({ type: "device_code", userCode: "AB-12", verificationUri: "https://e.com/d", expiresInSeconds: 30 });
		return fakeCred();
	});
	const liveCount = w.lives.length;
	await sleep(1400); // a live 30s interval would tick again here
	check("run returns credential", cred.refresh === "r");
	check("device block printed", w.prints.some((s) => s.includes("AB-12")));
	check("expiry window printed", w.prints.some((s) => s.includes("Code expires in 30s.")));
	check("success line printed", w.prints.some((s) => s === "Logged in to x-flow."));
	check("settled after success", d.settled === true);
	check("no stray ticks after success", w.lives.length === liveCount, `lives=${w.lives.length}`);
	d.dispose();
}

// --- expiry cancels through the shared countdown (no hand-rolled timer) ---
{
	const w = stubWriter();
	const d = new LoginDialog("x-flow", { writer: w, prompter: async () => "code" });
	let rejected = null;
	try {
		await d.run(async (flow, interaction) => {
			interaction.notify({ type: "device_code", userCode: "ZZ-9", verificationUri: "https://e.com/d", expiresInSeconds: 1 });
			await new Promise((_, rej) =>
				interaction.signal.addEventListener("abort", () => rej(new Error("Login cancelled")), { once: true }),
			);
			return fakeCred();
		});
	} catch (e) {
		rejected = e;
	}
	check("expiry rejects as cancel", rejected?.message === "Login cancelled", rejected?.message);
	check("expiry prints cancelled line once", w.prints.filter((s) => s.includes("cancelled")).length === 1);
	check("expiry aborts the flow signal", d.signal.aborted === true);
	check("expiry ticks carried countdown shape", w.lives.some((s) => /Waiting for authentication \(0s\)/.test(s)), JSON.stringify(w.lives.slice(-2)));
	d.dispose();
}

// --- Esc path: null prompt entry rejects, session survives ---
{
	const w = stubWriter();
	const d = new LoginDialog("x-flow", { writer: w, prompter: async () => null });
	let rejected = null;
	try {
		await d.run(async (flow, interaction) => interaction.prompt("Enter code:"));
	} catch (e) {
		rejected = e;
	}
	check("esc rejects as cancel", rejected?.message === "Login cancelled");
	check("esc prints cancelled line", w.prints.some((s) => s.includes("cancelled")));
	check("esc aborts the flow signal", d.signal.aborted === true);
	d.dispose();
}

// --- non-cancel failure: silent teardown, error propagates untouched ---
{
	const w = stubWriter();
	const d = new LoginDialog("x-flow", { writer: w, prompter: async () => "code" });
	let rejected = null;
	try {
		await d.run(async () => {
			throw new Error("token endpoint 500");
		});
	} catch (e) {
		rejected = e;
	}
	check("network error propagates", rejected?.message === "token endpoint 500");
	check("no cancelled line for network failure", !w.prints.some((s) => s.includes("cancelled")));
	check("settled after failure", d.settled === true);
	d.dispose();
}

// --- notify mapping: auth_url block + progress line ---
{
	const w = stubWriter();
	const d = new LoginDialog("x-flow", { writer: w, prompter: async () => "code" });
	const i = d.asInteraction();
	i.notify({ type: "auth_url", url: "https://e.com/a", instructions: "do the thing" });
	i.notify({ type: "progress", message: "polling..." });
	check("auth_url block printed", w.prints.some((s) => s.includes("https://e.com/a")));
	check("auth_url instructions kept", w.prints.includes("do the thing"));
	check("progress line printed", w.prints.includes("polling..."));
	d.dispose();
}

// --- unknown provider refuses with the api-key fix ---
{
	let rejected = null;
	try {
		await runLoginDialog("definitely-not-a-provider", { writer: stubWriter() });
	} catch (e) {
		rejected = e;
	}
	check(
		"unknown provider refuses",
		rejected instanceof LoginDialogError && rejected.message.includes("bi login definitely-not-a-provider"),
		rejected?.message,
	);
}

// --- stale-row pre-flight against the reconciled bi#102 layer ---
{
	const dir = mkdtempSync(join(tmpdir(), "bi-logindialog-"));
	process.env.BI_AUTH_FILE = join(dir, "auth.json");
	const past = Date.now() - 600000;
	await modifyCredential(
		"anthropic",
		() => new Credential({ provider_id: "anthropic", type: "oauth", key: null, refresh: "r", access: "a", expires: past, account_id: null }),
	);
	const n = await loginBoardIndex("anthropic");
	check("board index resolves 1-based", typeof n === "number" && n >= 1, `n=${n}`);
	const stale = await loginExpiredNotice("anthropic", Date.now());
	check("expired oauth flags with deep-link", stale !== null && stale.includes(`/oauth ${n}`), stale);
	await modifyCredential(
		"anthropic",
		() => new Credential({ provider_id: "anthropic", type: "oauth", key: null, refresh: "r", access: "a", expires: Date.now() + 3600000, account_id: null }),
	);
	check("fresh oauth is not stale", (await loginExpiredNotice("anthropic", Date.now())) === null);
	await modifyCredential(
		"anthropic",
		() => new Credential({ provider_id: "anthropic", type: "api_key", key: "k", refresh: null, access: null, expires: null, account_id: null }),
	);
	check("api_key never stale", (await loginExpiredNotice("anthropic", Date.now())) === null);
	delete process.env.BI_AUTH_FILE;
}

// --- default prompter honors an already-aborted signal (no TTY needed) ---
{
	const ctl = new AbortController();
	ctl.abort();
	check("aborted signal resolves null", (await defaultDialogPrompter("msg", undefined, ctl.signal)) === null);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `PROBE ALL PASS (${results.length})` : `PROBE FAILURES: ${failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
