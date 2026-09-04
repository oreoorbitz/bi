// bi/scripts/write-jail.mjs — bi#77: write/edit executor conformance.
// Jail + affirmative trust + envelopes + atomicity, all offline: trust
// is simulated through the live reader (no disk trust touched), files
// land in a temp dir (removed after).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const BI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { handleTool, setTrustReader } = await import(join(BI, "src", "tools.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const root = mkdtempSync(join(tmpdir(), "bi-write-"));
process.chdir(root);
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "sub", "a.txt"), "hello\nworld\n");
symlinkSync("/tmp", join(root, "evil-link"));

// 1. Untrusted refuses without touching disk.
setTrustReader(() => null);
try {
	await handleTool("write", { path: "x.txt", content: "hi" });
	check(false, "untrusted write refuses");
} catch (e) {
	check(String(e.message ?? e).includes("/trust allow|session"), `untrusted names fix (got: ${String(e.message ?? e).slice(0, 60)})`);
}

// 2. Stored-allow writes a new file, envelope has empty before.
setTrustReader(() => "allow");
const w1 = JSON.parse(await handleTool("write", { path: "sub/b.txt", content: "new\n" }));
check(w1.before === "" && w1.after === "new\n" && w1.path === "sub/b.txt", "new-file envelope shape");
check(readFileSync(join(root, "sub", "b.txt"), "utf8") === "new\n", "new file on disk");

// 3. Edit applies + envelope; missing oldText is atomic.
const w2 = JSON.parse(await handleTool("edit", { path: "sub/a.txt", edits: [{ oldText: "world", newText: "there" }] }));
check(w2.before === "hello\nworld\n" && w2.after === "hello\nthere\n", "edit envelope before/after");
try {
	await handleTool("edit", { path: "sub/a.txt", edits: [{ oldText: "nope", newText: "x" }] });
	check(false, "missing oldText throws");
} catch (e) {
	check(String(e.message ?? e).includes("edit 0 does not match"), "missing oldText names index");
	check(readFileSync(join(root, "sub", "a.txt"), "utf8") === "hello\nthere\n", "failed edit leaves disk untouched");
}

// 4. Jail: parent escape + symlink escape refuse.
for (const p of ["../escape.txt", "evil-link/x.txt", "/abs/out.txt"]) {
	try {
		await handleTool("write", { path: p, content: "x" });
		check(false, `jail refuses ${p}`);
	} catch (e) {
		check(String(e.message ?? e).includes("outside the project root"), `jail refuses ${p}`);
	}
}

// 5. Mid-session deny flip refuses the very next write.
setTrustReader(() => "deny");
try {
	await handleTool("write", { path: "sub/c.txt", content: "x" });
	check(false, "deny refuses");
} catch (e) {
	check(String(e.message ?? e).includes("not allow"), "deny refuses with trust message");
}

// 6. Session trust allows without stored file.
setTrustReader(() => "session");
await handleTool("write", { path: "sub/d.txt", content: "s\n" });
check(readFileSync(join(root, "sub", "d.txt"), "utf8") === "s\n", "session trust writes");

rmSync(root, { recursive: true, force: true });
if (failures) { process.exit(1); }
console.log("write-probe: all green");
