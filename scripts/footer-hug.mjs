// bi/scripts/footer-hug.mjs — footer follows content (bi#208).
//
// Change table (bi#208):
//   bi/src/tui.ts    footerHugRows (pure) + queryCursorRow (DSR) +
//                    HostFooter hug cache (gate/settleRows/paintRows),
//                    showAsync, async homeInput, installedFrame transport,
//                    reserveBottom.
//   bi/src/cli.ts    gate wiring + await homeInput/showAsync.
//   bi/src/prompt.ts askEdit bottom margin follows reserveBottom.
//   bi/scripts/e2e-pty-spawn.py  opt-in --dsr (cursor tracker + 6n
//                    replies) + BI_PTY_ROWS/COLS geometry. No flag, no
//                    behavior change for existing drills.
// Gates: footer-pin + footer-tips + tui-diff stay green (sync show()
// contract untouched — hug engages only with the gate set).
//
// Headless arms (always run): hug table, gate-null sync bytes,
// mute-stdin timeout pins, reserve, pinned resize reinstall.
// Pty arms (SKIP unless a pty device opens): short-screen hug,
// overflow pin, move erases without clear, junk (library live +
// modal + raw line all clean).
//
// Red-check (bi#57), 2026-09-09 (muse, bi#208): hug branch of
// footerHugRows forced to pinned — 9 FAILs, all naming the hug:
// hug.table one-above/short/small/12-row, pipe-hug frame/model/
// prompt/never-pins, pipe-overflow move-erase. Pin asserts stayed
// green (the neuter IS pinned). Restored → all green.
let failures = 0;
const check = (name, cond, extra = "") => {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
};

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { HostFooter, footerHugRows } = await import(join(HERE, "..", "dist", "src", "tui.js"));

// --- headless: pure hug table ---
{
	const eq = (got, want) => got.promptRow === want[0] && got.frameRow === want[1] && got.modelRow === want[2] && got.pinned === (want.length > 3 ? want[3] : false);
	check("hug.table null pins", eq(footerHugRows(24, null), [22, 23, 24, true]));
	check("hug.table fold pins", eq(footerHugRows(24, 22), [22, 23, 24, true]));
	check("hug.table past fold pins", eq(footerHugRows(24, 100), [22, 23, 24, true]));
	check("hug.table one above hugs", eq(footerHugRows(24, 21), [21, 22, 23]));
	check("hug.table short hugs", eq(footerHugRows(24, 5), [5, 6, 7]));
	check("hug.table small screen", eq(footerHugRows(10, 3), [3, 4, 5]));
	check("hug.table 12-row pty geometry", eq(footerHugRows(12, 4), [4, 5, 6]));
}

// --- headless: gate-null keeps the legacy sync bytes ---
{
	let out = "";
	const f = new HostFooter(() => ({ rows: 24, cols: 80 }), () => true, (s) => {
		out += s;
	});
	f.show("F1", "M1", "F1");
	check("hug.gate-null installs frame 23", out.includes("\x1b[23;1H\x1b[2KF1"), JSON.stringify(out.slice(0, 60)));
	check("hug.gate-null installs model 24", out.includes("\x1b[24;1H\x1b[2KM1"));
	out = "";
	await f.homeInput();
	check("hug.gate-null homes to 22", out === "\x1b[22;1H", JSON.stringify(out));
	check("hug.reserve pinned is 2", f.reserveBottom() === 2, `got ${f.reserveBottom()}`);
	const fresh = new HostFooter(() => ({ rows: 24, cols: 80 }), () => true, () => {});
	check("hug.reserve uninstalled is 2", fresh.reserveBottom() === 2);
	f.dispose();
	fresh.dispose();
}

// --- headless: mute stdin degrades to pinned (no gate bypass) ---
{
	let out = "";
	const f = new HostFooter(() => ({ rows: 24, cols: 80 }), () => true, (s) => {
		out += s;
	});
	f.setInputGate({ suspend() {} });
	const t0 = Date.now();
	await f.showAsync("F1", "M1", "F1");
	const dt = Date.now() - t0;
	check("hug.timeout pins to 23/24", out.includes("\x1b[23;1H\x1b[2KF1") && out.includes("\x1b[24;1H\x1b[2KM1"));
	check("hug.timeout bounded", dt < 5000, `${dt}ms`);
	f.dispose();
}

// --- headless: pinned resize reinstalls at the new fold ---
{
	let rows = 24;
	let out = "";
	const f = new HostFooter(() => ({ rows, cols: 80 }), () => true, (s) => {
		out += s;
	});
	f.show("F1", "M1", "F1");
	rows = 30;
	out = "";
	f.show("F1", "M1", "F1");
	check("hug.resize reinstalls frame 29", out.includes("\x1b[29;1H\x1b[2KF1"), JSON.stringify(out.slice(0, 80)));
	check("hug.resize reinstalls model 30", out.includes("\x1b[30;1H\x1b[2KM1"));
	f.dispose();
}

// --- pipe-terminal half (always runs): the drill plays the terminal.
//
// A real pty answers DSR itself; under pipes the drill does it: it
// tracks the virtual cursor over the child stream and replies to
// every 6n. This proves the full query→parse→hug path with real IPC
// (the kernel line discipline underneath is pty-only coverage).
{
	const makeTracker = (rows, cols) => ({
		rows,
		cols,
		y: 0,
		x: 0,
		saved: [],
		carry: "",
		feed(s) {
			const data = this.carry + s;
			this.carry = "";
			let i = 0;
			while (i < data.length) {
				const b = data[i];
				if (b === "\x1b" && data[i + 1] === "[") {
					let j = i + 2;
					while (j < data.length) {
						const c = data.charCodeAt(j);
						if (c >= 0x40 && c <= 0x7e) break;
						j += 1;
					}
					if (j >= data.length) {
						this.carry = data.slice(i);
						return;
					}
					const params = data.slice(i + 2, j);
					const final = data[j];
					const nums = params.split(";").map((p) => (/^\d+$/.test(p) ? Number(p) : null));
					if (final === "H" || final === "f") {
						this.y = Math.min(Math.max((nums[0] ?? 1) - 1, 0), this.rows - 1);
						this.x = Math.min(Math.max((nums[1] ?? 1) - 1, 0), this.cols - 1);
					} else if (final === "A") this.y = Math.max(this.y - (nums[0] ?? 1), 0);
					else if (final === "B") this.y = Math.min(this.y + (nums[0] ?? 1), this.rows - 1);
					else if (final === "C") this.x = Math.min(this.x + (nums[0] ?? 1), this.cols - 1);
					else if (final === "D") this.x = Math.max(this.x - (nums[0] ?? 1), 0);
					else if (final === "s") this.saved.push([this.y, this.x]);
					else if (final === "u") {
						const p = this.saved.pop();
						if (p) [this.y, this.x] = p;
					}
					i = j + 1;
				} else if (b === "\n") {
					this.y = Math.min(this.y + 1, this.rows - 1);
					i += 1;
				} else if (b === "\r") {
					this.x = 0;
					i += 1;
				} else i += 1;
			}
		},
	});
	const runPipe = (mode, { stdinAfter = null, timeoutMs = 15000 } = {}) =>
		new Promise((resolve) => {
			const child = spawn("node", [join(HERE, "footer-hug-child.mjs"), mode], {
				env: { ...process.env, BI_HUG_ROWS: "12", BI_HUG_COLS: "80", NO_COLOR: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const tracker = makeTracker(12, 80);
			let out = "";
			let answered = 0;
			let done = false;
			const finish = (code) => {
				if (done) return;
				done = true;
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve({ code, out });
			};
			const timer = setTimeout(() => finish(3), timeoutMs);
			child.stdout.on("data", (d) => {
				const s = String(d);
				out += s;
				tracker.feed(s);
				const queries = out.split("[6n").length - 1;
				while (answered < queries) {
					answered += 1;
					try {
						child.stdin.write(`\x1b[${tracker.y + 1};${tracker.x + 1}R`);
					} catch {}
				}
			});
			child.stderr.on("data", (d) => {
				const s = String(d);
				out += s;
				tracker.feed(s);
				const queries = out.split("[6n").length - 1;
				while (answered < queries) {
					answered += 1;
					try {
						child.stdin.write(`\x1b[${tracker.y + 1};${tracker.x + 1}R`);
					} catch {}
				}
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				setTimeout(() => finish(code ?? 3), 200);
			});
			(async () => {
				if (!stdinAfter) return;
				const { match, send, waitMs = 10000 } = stdinAfter;
				const t0 = Date.now();
				while (!out.includes(match) && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 50));
				if (out.includes(match)) {
					try {
						child.stdin.write(send);
					} catch {}
				}
			})();
		});
	{
		const { code, out } = await runPipe("hug");
		check("hug.pipe-hug exit 0", code === 0, `code=${code} tail=${JSON.stringify(out.slice(-160))}`);
		check("hug.pipe-hug frame below transcript", out.includes("\x1b[5;1H\x1b[2KFRAME1"));
		check("hug.pipe-hug model after frame", out.includes("\x1b[6;1H\x1b[2KMODEL1"));
		check("hug.pipe-hug prompt above frame", out.includes("\x1b[4;1H"));
		check("hug.pipe-hug never pins to 11", !out.includes("\x1b[11;1H"));
		check("hug.pipe-hug no clear", !out.includes("\x1b[2J"));
	}
	{
		const { code, out } = await runPipe("overflow");
		check("hug.pipe-overflow exit 0", code === 0, `code=${code}`);
		check("hug.pipe-overflow pins frame 11", out.includes("\x1b[11;1H\x1b[2KFRAME2"));
		check("hug.pipe-overflow pins model 12", out.includes("\x1b[12;1H\x1b[2KMODEL2"));
		check("hug.pipe-overflow move erases old rows", out.includes("\x1b[s\x1b[5;1H\x1b[2K\x1b[6;1H\x1b[2K\x1b[u"));
		check("hug.pipe-overflow no clear", !out.includes("\x1b[2J"));
	}
	{
		const { code, out } = await runPipe("line", { stdinAfter: { match: "READY", send: "hello\n" } });
		check("hug.pipe-line exit 0", code === 0, `code=${code} tail=${JSON.stringify(out.slice(-160))}`);
		check("hug.pipe-line stdin clean", out.includes("GOT:hello"), "reply bytes polluted the line");
	}
}

// --- pty half (SKIP unless a pty device actually opens) ---
const hasPty = spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no pty device on this host)");
} else {
	const runPty = (mode, { beats = [], timeoutS = 30 } = {}) =>
		new Promise((resolve) => {
			const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "--dsr", "0", String(timeoutS), "node", join(HERE, "footer-hug-child.mjs"), mode], {
				env: { ...process.env, BI_PTY_ROWS: "12", BI_PTY_COLS: "80", BI_MODAL_SETTLE: "0", NO_COLOR: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			let done = false;
			const finish = (code) => {
				if (done) return;
				done = true;
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve({ code, out });
			};
			const timer = setTimeout(() => finish(3), (timeoutS + 5) * 1000);
			child.stdout.on("data", (d) => {
				out += String(d);
			});
			child.stderr.on("data", (d) => {
				out += String(d);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				setTimeout(() => finish(code ?? 3), 300);
			});
			// beat driver: {match, send, waitMs, delayMs} — once match
			// appears (null matches at once), wait delayMs (modal
			// focus, paint), then send. Keys sent pre-focus are
			// dropped by the Tui, so the Down beat carries a
			// focus delay.
			(async () => {
				for (const { match, send, waitMs = 15000, delayMs = 400 } of beats) {
					if (match !== null) {
						const t0 = Date.now();
						while (!out.includes(match) && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 50));
						if (!out.includes(match)) return;
					}
					await new Promise((r) => setTimeout(r, delayMs));
					try {
						child.stdin.write(send);
					} catch {}
				}
			})();
		});

	{
		const { code, out } = await runPty("hug");
		check("hug.pty-hug exit 0", code === 0, `code=${code}`);
		check("hug.pty-hug frame below transcript", out.includes("\x1b[5;1H\x1b[2KFRAME1"));
		check("hug.pty-hug model after frame", out.includes("\x1b[6;1H\x1b[2KMODEL1"));
		check("hug.pty-hug prompt above frame", out.includes("\x1b[4;1H"));
		check("hug.pty-hug never pins to 11", !out.includes("\x1b[11;1H"));
		check("hug.pty-hug no clear", !out.includes("\x1b[2J"));
	}
	{
		const { code, out } = await runPty("overflow");
		check("hug.pty-overflow exit 0", code === 0, `code=${code}`);
		check("hug.pty-overflow pins frame 11", out.includes("\x1b[11;1H\x1b[2KFRAME2"));
		check("hug.pty-overflow pins model 12", out.includes("\x1b[12;1H\x1b[2KMODEL2"));
		check(
			"hug.pty-overflow move erases old rows",
			out.includes("\x1b[s\x1b[5;1H\x1b[2K\x1b[6;1H\x1b[2K\x1b[u"),
			"old hug rows not erased",
		);
		check("hug.pty-overflow no clear", !out.includes("\x1b[2J"));
	}
	{
		const { code, out } = await runPty("junk", {
			beats: [
				{ match: "PICK-OPEN", send: "\x1b[B", waitMs: 15000, delayMs: 1500 },
				{ match: null, send: "\r", delayMs: 800 },
				{ match: "READY", send: "hello\r", waitMs: 15000, delayMs: 300 },
			],
		});
		check("hug.pty-junk exit 0", code === 0, `code=${code} tail=${JSON.stringify(out.slice(-200))}`);
		check("hug.pty-junk reserve follows float", out.includes("RESERVE:9"), "margin not above floating footer");
		check("hug.pty-junk modal clean", out.includes("PICK:1"), "DSR bytes leaked into the modal");
		check("hug.pty-junk stdin clean", out.includes("GOT:hello"), "reply bytes polluted the line");
	}
}

if (failures) process.exit(1);
console.log("footer-hug: all green");
