// bi/scripts/tool-exec.mjs — bi#150/bash + bi#151/read-only executor conformance.
//
// Drives the REAL host executors (handleTool, the exact function the agent
// loop calls) over fixtures in a temp dir (removed after) and asserts the
// issue acceptance bullets: allowlist (git/node pass, curl-to-unknown fails
// loud with the policy reason), runaway sleep killed at timeout,
// secret-looking output redacted; read/grep/ls/find succeed inside root
// with caps applied, symlink escape + oversize refuse loud with
// BAML-owned reasons. Also self-checks advertise/execute parity by hand
// (every ListTools name has a handleTool case) until bi#152's gate covers
// both directions in CI (it now does — tool-parity.mjs; this probe is the
// runtime half: cases actually execute, not just parse).
//
// Red-check record (bi#57, 2026-09-06, all observed live):
//   bash allowlist gate removed (BASH_ALLOW.has -> true):
//     => FAIL curl-to-unknown refuses with the policy reason, exit 1
//   timeout branch forced off (err.killed -> false):
//     => FAIL runaway sleep killed at timeout (got: bash exited ?: sleep 5), exit 1
//   redactSecrets reduced to identity (redacted = raw):
//     => FAIL secret-looking output redacted from transcript
//        + FAIL key=value secret redacted from transcript, exit 1
//   read jail bypassed (jailResolve -> resolve):
//     => FAIL read symlink escape refuses (../escape.txt)
//        + FAIL read symlink escape refuses (evil-file), exit 1
//   read binary guard removed:
//     => FAIL read binary refuses, exit 1
//   ls jail bypassed: => FAIL ls escape refuses, exit 1
//   grep jail bypassed: => FAIL grep escape refuses, exit 1
//   find jail bypassed: => FAIL find escape refuses, exit 1
//   each restored -> tool-exec: all green, exit 0.
// A passing suite that cannot go red is camouflage, not coverage.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const BI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { handleTool } = await import(join(BI, "src", "tools.js"));
const { ListTools_async: sdkList } = await import(join(BI, "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};
const errText = (e) => String(e?.message ?? e);

// --- fixtures in a temp project root ---
const root = mkdtempSync(join(tmpdir(), "bi-exec-"));
process.chdir(root);
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "sub", "a.txt"), "hello\nworld\n");
writeFileSync(join(root, "bin.dat"), Buffer.concat([Buffer.from("binmarker"), Buffer.from([0]), Buffer.from("zzzz")]));
writeFileSync(join(root, "big.log"), "x".repeat(300 * 1024));
const needles = Array.from({ length: 250 }, (_, i) => `needle ${i}`).join("\n") + "\n";
writeFileSync(join(root, "sub", "needles.txt"), needles);
const outside = join(tmpdir(), `bi-exec-outside-${process.pid}.txt`);
writeFileSync(outside, "outside secret\n");
symlinkSync(outside, join(root, "evil-file"));
symlinkSync(join(root, "sub", "a.txt"), join(root, "ok-link"));

// --- bi#150: bash allowlist ---
const git = await handleTool("bash", { command: "git --version" });
check(git.includes("git version"), "git passes the allowlist");
const node = await handleTool("bash", { command: "node --version" });
check(node.trim().startsWith("v"), "node passes the allowlist");
try {
	const rg = await handleTool("bash", { command: "rg --version" });
	check(rg.includes("ripgrep"), "rg passes the allowlist");
} catch (e) {
	check(!errText(e).includes("allowlist"), `rg is allowlisted even without the binary (got: ${errText(e).slice(0, 60)})`);
}
try {
	await handleTool("bash", { command: "curl https://example.invalid/x" });
	check(false, "curl-to-unknown refuses");
} catch (e) {
	check(errText(e).includes("not on the bash allowlist") && errText(e).includes("curl https://example.invalid/x"), `curl-to-unknown refuses with the policy reason (got: ${errText(e).slice(0, 80)})`);
}

// --- bi#150: timeout/kill ---
try {
	await handleTool("bash", { command: "sleep 5", timeout: 1 });
	check(false, "runaway sleep killed at timeout");
} catch (e) {
	check(errText(e).includes("timed out and was killed after 1s"), `runaway sleep killed at timeout (got: ${errText(e).slice(0, 80)})`);
}

// --- bi#150: secret redaction + env scrubbing ---
const sk = await handleTool("bash", { command: "echo sk-ant-abcdefghijklmnopqrst" });
check(sk.includes("[REDACTED]") && !sk.includes("sk-ant-abcdefghijklmnopqrst"), "secret-looking output redacted from transcript");
const kv = await handleTool("bash", { command: "echo token=hunter2secret" });
check(kv.includes("token=[REDACTED]") && !kv.includes("hunter2secret"), "key=value secret redacted from transcript");
process.env.BI_EXEC_PROBE_KEY = "probe-secret-value";
const leak = await handleTool("bash", { command: "echo leak:$BI_EXEC_PROBE_KEY" });
check(!leak.includes("probe-secret-value"), "scrubbed env keeps secrets out of the child");
delete process.env.BI_EXEC_PROBE_KEY;

// --- bi#151: read ---
const whole = await handleTool("read", { path: "sub/a.txt" });
check(whole === "hello\nworld\n", "read inside root returns content");
const slice = await handleTool("read", { path: "sub/a.txt", offset: 2, limit: 1 });
check(slice === "world", `read offset/limit slices (got: ${JSON.stringify(slice)})`);
const inside = await handleTool("read", { path: "ok-link" });
check(inside === "hello\nworld\n", "read through an inside symlink succeeds");
for (const p of ["../escape.txt", "evil-file"]) {
	try {
		await handleTool("read", { path: p });
		check(false, `read symlink escape refuses (${p})`);
	} catch (e) {
		check(errText(e).includes("outside the project root"), `read symlink escape refuses (${p})`);
	}
}
try {
	await handleTool("read", { path: "bin.dat" });
	check(false, "read binary refuses");
} catch (e) {
	check(errText(e).includes("text only"), `read binary refuses with text-only reason (got: ${errText(e).slice(0, 60)})`);
}
try {
	await handleTool("read", { path: "big.log" });
	check(false, "read oversize refuses");
} catch (e) {
	check(errText(e).includes("byte tool cap"), `read oversize refuses with the cap named (got: ${errText(e).slice(0, 60)})`);
}

// --- bi#151: ls ---
const ls = JSON.parse(await handleTool("ls", { path: "sub" }));
check(ls.entries.some((e) => e.name === "a.txt" && e.kind === "file") && ls.truncated === false, "ls inside root lists entries");
try {
	await handleTool("ls", { path: "../" });
	check(false, "ls escape refuses");
} catch (e) {
	check(errText(e).includes("outside the project root"), "ls escape refuses with BAML reason");
}

// --- bi#151: grep ---
const g = JSON.parse(await handleTool("grep", { pattern: "world", path: "sub" }));
check(g.matches.length === 1 && g.matches[0].line === 2 && g.truncated === false, "grep inside root finds line hits");
const gcap = JSON.parse(await handleTool("grep", { pattern: "needle" }));
check(gcap.matches.length === 200 && gcap.truncated === true, `grep truncates past the cap (got ${gcap.matches.length}, truncated=${gcap.truncated})`);
const gbin = JSON.parse(await handleTool("grep", { pattern: "binmarker" }));
check(gbin.matches.length === 0 && gbin.skipped_binary >= 1, "grep skips binary files with a count");
try {
	await handleTool("grep", { pattern: "x", path: "../" });
	check(false, "grep escape refuses");
} catch (e) {
	check(errText(e).includes("outside the project root"), "grep escape refuses with BAML reason");
}

// --- bi#151: find ---
const f = JSON.parse(await handleTool("find", { pattern: "*.txt" }));
check(f.paths.includes("sub/a.txt") && f.truncated === false, `find globs inside root (got: ${JSON.stringify(f.paths).slice(0, 80)})`);
try {
	await handleTool("find", { pattern: "*", path: "../" });
	check(false, "find escape refuses");
} catch (e) {
	check(errText(e).includes("outside the project root"), "find escape refuses with BAML reason");
}

// --- bi#193 color arm: tool names primary, args/result tail text_dim ---
// Pins the chrome composition the cli tool path paints (chromeToolLine in
// theme-files.ts) over the real BAML-shaped start/done lines. Red-check
// (bi#57), executed 2026-09-08: reverted chromeToolLine's primary wrap to
// pass the name through plain => FAIL tool start name pops primary
// (got: plain name), restored => green.
{
	const tf = await import(join(BI, "src", "theme-files.js"));
	const { format_tool_start_async, format_tool_done_async } = await import(join(BI, "baml_sdk", "index.js"));
	const PRIMARY = tf.chromeAnsi("primary", {});
	const DIM = tf.chromeAnsi("text_dim", {});
	const RESET = tf.CHROME_RESET;
	check(PRIMARY === "\x1b[38;2;214;2;112m" && DIM === "\x1b[38;2;155;79;150m", "tool chrome byte-pins #D60270 / #9B4F96");

	const start = await format_tool_start_async("read", JSON.stringify({ path: "sub/a.txt" }), { theme: null });
	const startColored = tf.chromeToolLine(start, "read", true, {});
	check(
		startColored === `${DIM}◌ ${PRIMARY}read${DIM} — {"path":"sub/a.txt"}${RESET}`,
		`tool start name pops primary, args tail dims (got: ${JSON.stringify(startColored).slice(0, 90)})`,
	);
	const done = await format_tool_done_async("read", "hello\nworld\n", false, { theme: null });
	check(
		tf.chromeToolLine(done, "read", true, {}) === `${DIM}✓ ${PRIMARY}read${DIM} · 12 chars${RESET}`,
		"tool done name pops primary, result tail dims",
	);
	const failed = await format_tool_done_async("read", "open sub/nope.txt: no such file", true, { theme: null });
	const failedColored = tf.chromeToolLine(failed, "read", true, {});
	check(
		failedColored === `${DIM}✗ ${PRIMARY}read${DIM} — open sub/nope.txt: no such file${RESET}`,
		`failed done keeps the ✗ shape, path tail dims (got: ${JSON.stringify(failedColored).slice(0, 90)})`,
	);
	// Pipes (paint=false) and both suppression gates are byte-identical.
	check(tf.chromeToolLine(start, "read", false, {}) === start, "pipe paint=false is the BAML line byte-identical");
	check(tf.chromeToolLine(start, "read", true, { NO_COLOR: "1" }) === start, "NO_COLOR is the BAML line byte-identical");
	check(tf.chromeToolLine(start, "read", true, { BI_THEME: "none" }) === start, "BI_THEME=none is the BAML line byte-identical");
	// A themed BAML line still composes (chrome re-colors inside the span).
	const themed = await format_tool_start_async("read", JSON.stringify({ path: "sub/a.txt" }), { theme: "default" });
	const themedColored = tf.chromeToolLine(themed, "read", true, {});
	check(themedColored.includes(`${PRIMARY}read${DIM}`) && themedColored.endsWith(RESET), "themed line composes without a splice fight");
}

// --- parity self-check: every advertised name executes (no 'unknown tool') ---
const advertised = await sdkList();
for (const t of advertised) {
	try {
		await handleTool(t.name, {});
		check(true, `parity: ${t.name} executes`);
	} catch (e) {
		check(!errText(e).startsWith("unknown tool"), `parity: ${t.name} executes (got: ${errText(e).slice(0, 60)})`);
	}
}
rmSync(root, { recursive: true, force: true });
rmSync(outside, { force: true });
if (failures) { process.exit(1); }
console.log("tool-exec: all green");
