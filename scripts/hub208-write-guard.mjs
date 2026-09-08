// bi/scripts/hub208-write-guard.mjs — hub#208 rail 1 drill: read-before-
// write enforced by the host tool layer (handleToolInSession), offline.
// Trust is simulated through the live reader; files land in a temp dir
// (removed after). Run: node bi/scripts/hub208-write-guard.mjs
//
// Red-check record (bi#57):
//   Guard net — hunk: in bi/src/tools.ts handleToolInSession, neutralize the
//   refusal (`if (verdict instanceof WriteGuardRefuse)` → `if (false)`).
//   Expected reason: step 2's overwrite of an unread file succeeds, so the
//   drill fails naming "unguarded write succeeded".
//   Observed: FAIL: overwrite of an unread existing file refuses (unguarded
//   write succeeded — read-before-write rail is off) + FAIL: edit of an
//   unread existing file refuses (unguarded edit succeeded) — 2 failures,
//   both for the right reason. Restored, re-ran: all green.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const BI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { handleToolInSession, newToolSession, setTrustReader } = await import(join(BI, "src", "tools.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const root = mkdtempSync(join(tmpdir(), "bi-hub208-"));
process.chdir(root);
writeFileSync(join(root, "existing.txt"), "original\n");
setTrustReader(() => "allow");

// 1. New-file creation is unfenced: no read mark needed (nothing to have read).
{
	const s = newToolSession();
	const env = JSON.parse(await handleToolInSession(s, "write", { path: "new.txt", content: "fresh\n" }));
	check(env.before === "" && readFileSync(join(root, "new.txt"), "utf8") === "fresh\n", "new-file write needs no read mark");
}

// 2. Overwrite of an existing, unread file refuses with the named reason.
{
	const s = newToolSession();
	try {
		await handleToolInSession(s, "write", { path: "existing.txt", content: "clobbered\n" });
		check(false, "overwrite of an unread existing file refuses (unguarded write succeeded — read-before-write rail is off)");
	} catch (e) {
		const m = String(e.message ?? e);
		check(m.includes("read-before-write") && m.includes("existing.txt"), `overwrite refusal names the reason (got: ${m.slice(0, 70)})`);
		check(m.includes("Call read"), "overwrite refusal names the fix (read first)");
	}
	check(readFileSync(join(root, "existing.txt"), "utf8") === "original\n", "refused overwrite leaves disk untouched");
}

// 3. Edit of an unread file refuses too (its target exists by definition).
{
	const s = newToolSession();
	try {
		await handleToolInSession(s, "edit", { path: "existing.txt", edits: [{ oldText: "original", newText: "edited" }] });
		check(false, "edit of an unread existing file refuses (unguarded edit succeeded — read-before-write rail is off)");
	} catch (e) {
		check(String(e.message ?? e).includes("read-before-write"), "edit refusal names read-before-write");
	}
}

// 4. Read-then-write succeeds — the mark is keyed on the resolved path.
{
	const s = newToolSession();
	await handleToolInSession(s, "read", { path: "existing.txt" });
	const env = JSON.parse(await handleToolInSession(s, "write", { path: "existing.txt", content: "updated\n" }));
	check(env.before === "original\n" && env.after === "updated\n", "read-then-write succeeds");
	check(readFileSync(join(root, "existing.txt"), "utf8") === "updated\n", "read-then-write lands on disk");
}

// 5. Read-then-edit succeeds.
{
	const s = newToolSession();
	await handleToolInSession(s, "read", { path: "existing.txt" });
	const env = JSON.parse(await handleToolInSession(s, "edit", { path: "existing.txt", edits: [{ oldText: "updated", newText: "patched" }] }));
	check(env.after === "patched\n", "read-then-edit succeeds");
}

// 6. Marks are per-session: a fresh session has no marks.
{
	const s = newToolSession();
	try {
		await handleToolInSession(s, "write", { path: "existing.txt", content: "again\n" });
		check(false, "fresh session re-refuses overwrite of a file another session read");
	} catch (e) {
		check(String(e.message ?? e).includes("read-before-write"), "fresh session re-refuses (marks are per-session)");
	}
}

// 7. ls/grep do NOT mark: listing a directory does not bless a write.
{
	const s = newToolSession();
	await handleToolInSession(s, "ls", { path: "." });
	try {
		await handleToolInSession(s, "write", { path: "existing.txt", content: "sneaky\n" });
		check(false, "ls does not count as a read mark");
	} catch (e) {
		check(String(e.message ?? e).includes("read-before-write"), "ls does not count as a read mark");
	}
}

rmSync(root, { recursive: true, force: true });
if (failures) { process.exit(1); }
console.log("hub208-write-guard: all green");
