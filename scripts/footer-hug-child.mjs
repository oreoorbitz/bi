// bi/scripts/footer-hug-child.mjs — pty-side harness for footer-hug.mjs (bi#208).
//
// Runs ON the pty (child of e2e-pty-spawn.py --dsr): exercises
// HostFooter against a real terminal cursor and prints markers the
// parent asserts on. Modes: hug | overflow | junk. No readline here —
// the input gate suspend/resume are noops, so any reply bytes in the
// stream come from the terminal or the library host, never readline.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { HostFooter, ensureReplTui, retainReplTui } = await import(join(HERE, "..", "dist", "src", "tui.js"));

const mode = process.argv[2] ?? "hug";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Geometry via env under the pipe-terminal (stdout.rows is undefined
// on pipes); the pty transport sets the real winsize instead.
const ROWS = Number(process.env.BI_HUG_ROWS ?? 0) || process.stdout.rows || 12;
const COLS = Number(process.env.BI_HUG_COLS ?? 0) || process.stdout.columns || 80;
const dims = () => ({ rows: ROWS, cols: COLS });

function makeFooter() {
	const footer = new HostFooter(dims, () => true, (s) => process.stderr.write(s), {
		corpus: [],
		intervalMs: 60000,
	});
	footer.setInputGate({ suspend() {} });
	return footer;
}

function readLine() {
	return new Promise((resolve) => {
		let buf = "";
		const onData = (d) => {
			buf += String(d);
			const i = buf.search(/[\r\n]/);
			if (i !== -1) {
				process.stdin.removeListener("data", onData);
				try {
					process.stdin.pause();
				} catch {}
				resolve(buf.slice(0, i));
			}
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

try {
	if (mode === "hug" || mode === "overflow") {
		const footer = makeFooter();
		console.log("t1");
		console.log("t2");
		console.log("t3");
		await footer.showAsync("FRAME1", "MODEL1", "FB1");
		await footer.homeInput();
		console.log("HUG-DONE");
		if (mode === "overflow") {
			for (let i = 1; i <= 30; i++) console.log(`o${i}`);
			await footer.showAsync("FRAME2", "MODEL2", "FB2");
			console.log("OVER-DONE");
		}
		await sleep(200);
		footer.dispose();
		process.exit(0);
	}
	if (mode === "scroll") {
		// hub#237 (bi.jpg shape): tall screen, paint near the top, then
		// a welcome/BAIS-length scroll before the first prompt. The
		// prompt margin must follow the fresh settle (small), never the
		// stale install (which pushed the modal off-screen), and the
		// move must not blank the recycled rows.
		const footer = makeFooter();
		console.log("w1");
		console.log("w2");
		console.log("w3");
		await footer.showAsync("FRAME1", "MODEL1", "FB1");
		for (let i = 1; i <= 26; i++) console.log(`s${i}`);
		await footer.homeInput();
		console.log(`RESERVE:${footer.reserveBottom()}`);
		console.log("SCROLL-DONE");
		await sleep(200);
		footer.dispose();
		process.exit(0);
	}
	if (mode === "modal") {
		// hub#237 modal-first: a full-height picker runs BEFORE the
		// first footer paint (the session picker with 200 sessions).
		// Teardown must home the cursor to the bottom — the next DSR
		// settles pinned (never row 1), the reserve stays 2, the
		// footer installs at the fold.
		retainReplTui();
		ensureReplTui(mkdtempSync(join(tmpdir(), "bi-hug-")));
		// Production order (hub#237): the footer exists BEFORE the
		// picker, so the picker teardown homes the cursor.
		const footer = makeFooter();
		const { pickList } = await import(join(HERE, "..", "dist", "src", "prompt.js"));
		console.log("PICK-OPEN");
		const idx = await pickList("pick one", Array.from({ length: 30 }, (_, i) => ({ label: `item-${i}` })), 0);
		console.log(`PICK:${idx}`);
		await footer.showAsync("FRAME1", "MODEL1", "FB1");
		await footer.homeInput();
		console.log(`RESERVE:${footer.reserveBottom()}`);
		console.log("MODAL-DONE");
		await sleep(200);
		footer.dispose();
		process.exit(0);
	}
	if (mode === "junk") {
		// Library host live (its stdin listener sees every DSR reply —
		// the leak vector), then the hug flow, then a modal, then a
		// raw line read. Anything the replies disturb shows up as a
		// wrong pick or a polluted line.
		retainReplTui();
		ensureReplTui(mkdtempSync(join(tmpdir(), "bi-hug-")));
		const footer = makeFooter();
		console.log("t1");
		console.log("t2");
		await footer.showAsync("FRAME1", "MODEL1", "FB1");
		await footer.homeInput();
		console.log(`RESERVE:${footer.reserveBottom()}`);
		const { pickList } = await import(join(HERE, "..", "dist", "src", "prompt.js"));
		console.log("PICK-OPEN");
		const idx = await pickList("pick one", [{ label: "aaa" }, { label: "bbb" }, { label: "ccc" }], 0);
		console.log(`PICK:${idx}`);
		console.log("READY");
		const line = await readLine();
		console.log(`GOT:${line}`);
		await sleep(200);
		process.exit(0);
	}
	if (mode === "line") {
		// Pipe-terminal junk arm: no library host, no modal (both need
		// a TTY) — proves the DSR query consumes its reply exactly
		// and leaves stdin usable.
		const footer = makeFooter();
		console.log("t1");
		console.log("t2");
		console.log("t3");
		await footer.showAsync("FRAME1", "MODEL1", "FB1");
		await footer.homeInput();
		console.log("READY");
		const line = await readLine();
		console.log(`GOT:${line}`);
		await sleep(200);
		process.exit(0);
	}
	console.error(`unknown mode ${mode}`);
	process.exit(1);
} catch (e) {
	console.error(`CHILD-FAIL ${e?.stack ?? e}`);
	process.exit(1);
}
