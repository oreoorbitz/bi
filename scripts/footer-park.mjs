// bi/scripts/footer-park.mjs — hub#239 footer park for command output.
// HostFooter with faked dims/tty/write (no pty device needed):
// (1) suspend erases exactly the installed rows in place (frame 23 +
// model 24 on 24x80) and drops the paint caches; (2) resume scrolls
// two fresh rows then repaints both rows through the normal path;
// (3) a second resume writes zero bytes (the park released);
// (4) suspend on an uninstalled footer writes zero bytes (pipes stay
// escape-free); (5) a repaint between suspend and resume (nested
// turn/modal re-show) releases the park, so resume no-ops instead of
// double-parking. Red-checks: drop the suspend and resume stays
// silent; drop the repaint and resume repaints.
// Pty arms (stale-row counts on /help + /tui-debug) SKIP here — the
// merger runs them on a pty host.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { HostFooter } = await import(join(HERE, "..", "dist", "src", "tui.js"));

let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};
const settle = () => new Promise((r) => setTimeout(r, 100));
const mk = () => {
	let out = "";
	const f = new HostFooter(
		() => ({ rows: 24, cols: 80 }),
		() => true,
		(s) => {
			out += s;
		},
		{ corpus: [], intervalMs: 60000 },
	);
	return { f, bytes: () => out, clear: () => (out = "") };
};

// --- suspend erases exactly the installed rows ---
{
	const { f, bytes, clear } = mk();
	await f.showAsync("F1", "M1", "fb");
	await settle();
	check("park.install paints frame 23", bytes().includes("\x1b[23;1H\x1b[2KF1"));
	check("park.install paints model 24", bytes().includes("\x1b[24;1H") && bytes().includes("M1"));
	clear();
	f.suspendForOutput();
	const b = bytes();
	check("park.suspend erases frame row", b.includes("\x1b[23;1H\x1b[2K"));
	check("park.suspend erases model row", b.includes("\x1b[24;1H\x1b[2K"));
	check("park.suspend writes no text", !b.includes("F1") && !/[M]1/.test(b.replace(/\x1b\[2K/g, "")));
	f.dispose();
}

// --- resume scrolls fresh rows then repaints ---
{
	const { f, bytes, clear } = mk();
	await f.showAsync("F1", "M1", "fb");
	await settle();
	clear();
	f.suspendForOutput();
	clear();
	f.resumeAfterOutput();
	await settle();
	const b = bytes();
	check("park.resume scrolls two rows", b.startsWith("\n\n"), JSON.stringify(b.slice(0, 12)));
	check("park.resume repaints frame", b.includes("F1"));
	check("park.resume repaints model", b.includes("\x1b[24;1H"));
	const n = bytes().length;
	f.resumeAfterOutput();
	await settle();
	check("park.second resume silent", bytes().length === n, `+${bytes().length - n} bytes`);
	f.dispose();
}

// --- uninstalled suspend is silent; nested repaint releases ---
{
	const { f, bytes } = mk();
	f.suspendForOutput();
	check("park.uninstalled suspend silent", bytes() === "", JSON.stringify(bytes().slice(0, 40)));
	f.dispose();

	const g = mk();
	await g.f.showAsync("F1", "M1", "fb");
	await settle();
	g.f.suspendForOutput();
	await g.f.showAsync("F1", "M1", "fb"); // nested re-show (turn/modal)
	await settle();
	g.clear();
	g.f.resumeAfterOutput();
	await settle();
	check("park.nested repaint releases resume", g.bytes() === "", JSON.stringify(g.bytes().slice(0, 40)));
	g.f.dispose();
}

if (failures) process.exit(1);
console.log("footer-park: all green");
