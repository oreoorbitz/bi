// bi/scripts/fullscreen.mjs — BI_FULLSCREEN=1 alt-screen drill (bi#160)
// plus headless proofs for bi#158 search shaping and the bi#160 frame
// contract.
//
// Headless (always runs, no TTY needed):
//   shaping      transcriptLines maps history to header+text rows.
//   gates        searchScreenAvailable/fullscreenRequested env matrix.
//   layout       buildFullscreenRoot carries a primary follow-end ScrollView.
//   frame-pin    composeFullscreenFrame keeps the footer at >=1 row for
//                every height 1..40 (the VStack dock contract, headless).
//   lib-match    pi-tui's own findAltScreenSearchMatches is case-
//                insensitive over ANSI-stripped text (the matching half
//                of the /search acceptance; highlight coordinates and
//                viewport nav stay library-owned).
// Pty (needs python3 with stdlib pty; SKIP otherwise, exit 0):
//   fs-enter-exit  BI_FULLSCREEN=1 enters (1049h) and exits (1049l) the
//                  alt screen, exit code 0.
//   fs-replay      the tail after 1049l holds the transcript ("/quit",
//                  "session kept") and the dock prompt row ("bi[0]> ")
//                  — the host replay path.
//   fs-no-leak     the replayed tail holds no 1049h of its own.
//   fs-unset       without the flag no alt screen is entered.
//   fs-pipes       piped stdio with the flag never enters the alt screen.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "src", "cli.js");

const {
	transcriptLines,
	TRANSCRIPT_SEARCH_NOTE,
	searchScreenAvailable,
	composeFullscreenFrame,
} = await import(join(HERE, "..", "dist", "src", "tui.js"));
const { fullscreenRequested, buildFullscreenRoot } = await import(
	join(HERE, "..", "dist", "src", "screen-fullscreen.js")
);
const { findAltScreenSearchMatches } = await import(
	join(HERE, "..", "node_modules", "@earendil-works", "pi-tui", "dist", "alt-screen-search.js")
);
const { VStack, ScrollView } = await import("@earendil-works/pi-tui");

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures += 1;
}

// --- headless: shaping (bi#158) ---
{
	const lines = transcriptLines([
		{ role: "user", text: "hello\nworld" },
		{ role: "assistant", text: "hi" },
	]);
	check("shaping headers+rows", JSON.stringify(lines) === JSON.stringify(["### user", "hello", "world", "### assistant", "hi"]), JSON.stringify(lines));
	check("shaping empty history", transcriptLines([]).length === 0);
	check(
		"shaping missing fields",
		JSON.stringify(transcriptLines([{}])) === JSON.stringify(["### unknown"]),
	);
	check("usage note points at /export", TRANSCRIPT_SEARCH_NOTE.includes("/export"));
}

// --- headless: gates ---
{
	check("search gate needs explicit env only (pure fn present)", typeof searchScreenAvailable({}) === "boolean");
	check("search gate BI_SCREEN=0 closed", searchScreenAvailable({ BI_SCREEN: "0" }) === false);
	check("fullscreen gate unset closed", fullscreenRequested({}) === false);
	check("fullscreen gate other value closed", fullscreenRequested({ BI_FULLSCREEN: "yes" }) === false);
	check(
		"fullscreen gate flag-only shape",
		fullscreenRequested({ BI_FULLSCREEN: "1" }) === (!!process.stdin.isTTY && !!process.stdout.isTTY),
	);
}

// --- headless: layout root (bi#160) ---
{
	const parts = buildFullscreenRoot();
	check("layout root is VStack", parts.root instanceof VStack);
	check("transcript scroll primary", parts.scroll instanceof ScrollView && parts.scroll.primary === true);
	check("scroll follows end", parts.scroll.isFollowingEnd === true);
}

// --- headless: frame-pin (dock contract without a pty) ---
{
	const input = {
		transcript: Array.from({ length: 200 }, (_, i) => `t${i}`),
		promptRow: "bi[3]> ",
		footer: ["FOOTER-FRAME", "model line"],
	};
	let pinOk = true;
	let collapseOk = true;
	for (const width of [20, 80, 160]) {
		for (let h = 1; h <= 40; h++) {
			const frame = composeFullscreenFrame(input, { width, height: h });
			if (!frame.includes("FOOTER-FRAME")) pinOk = false;
			// Prompt row collapses before the footer does: at height 1
			// only the footer survives.
			if (h === 1 && frame.some((l) => l.includes("bi[3]>"))) collapseOk = false;
		}
	}
	check("frame-pin footer never below 1 row (h=1..40, w=20/80/160)", pinOk);
	check("frame-pin prompt row yields first at h=1", collapseOk);
}

// --- headless: library matching contract over shaped lines ---
{
	const lines = transcriptLines([
		{ role: "user", text: "Run the \x1b[1mSWARM\x1b[0m deploy" },
		{ role: "assistant", text: "swarm done" },
	]);
	const m = findAltScreenSearchMatches(lines, "swarm");
	check("lib match case-insensitive over ANSI", m.length === 2, `got ${m.length}`);
	check("lib match rows map to source lines", m[0]?.segments[0]?.row === 1 && m[1]?.segments[0]?.row === 3, JSON.stringify(m.map((x) => x.segments[0]?.row)));
	check("lib match empty query none", findAltScreenSearchMatches(lines, "   ").length === 0);
}

// --- pty half (SKIP without python3+pty) ---
const hasPty = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
if (!hasPty) {
	console.log("SKIP  pty half (no python3+pty on this host)");
} else {
	const makeSandbox = () => {
		const home = mkdtempSync(join(tmpdir(), "bi-fs-"));
		mkdirSync(join(home, ".bi", "sessions"), { recursive: true });
		// realpath: macOS /tmp symlinks would otherwise mismatch the
		// CLI-side process.cwd() and drop the run into the trust modal.
		writeFileSync(join(home, ".bi", "trust.json"), JSON.stringify({ [realpathSync(process.cwd())]: "allow" }) + "\n");
		writeFileSync(join(home, ".bi", "settings.json"), JSON.stringify({ setup_done: true }) + "\n");
		return home;
	};
	// Transport relays stdin<->pty and answers kitty bursts itself
	// (same helper the e2e harness uses; pty is 40 rows x 160 cols).
	const runPty = ({ extraEnv = {}, stdinBeats = [], timeoutS = 25 }) =>
		new Promise((resolve) => {
			const home = makeSandbox();
			const env = { ...process.env, HOME: home, TERM: "xterm-kitty", ...extraEnv };
			delete env.BI_TUI_DEBUG;
			const child = spawn("python3", [join(HERE, "e2e-pty-spawn.py"), "0", String(timeoutS), "node", CLI], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (d) => { out += d.toString("utf8"); });
			for (const [atMs, bytes] of stdinBeats) {
				setTimeout(() => {
					try { child.stdin.write(bytes); } catch {}
				}, atMs);
			}
			child.on("close", (code) => resolve({ out, code }));
		});
	const ENTER = "\x1b[?1049h";
	const EXIT = "\x1b[?1049l";

	// A: fullscreen enter/exit + replay.
	{
		const { out, code } = await runPty({
			extraEnv: { BI_FULLSCREEN: "1" },
			stdinBeats: [[5000, "/quit\r"], [10000, "/quit\r"]],
		});
		const enter = out.indexOf(ENTER);
		const exit = out.lastIndexOf(EXIT);
		check("fs-enter-exit alt screen entered+left, exit 0", enter !== -1 && exit !== -1 && exit > enter && code === 0, `code=${code}`);
		const tail = exit !== -1 ? out.slice(exit + EXIT.length) : "";
		check("fs-replay transcript visible in scrollback", tail.includes("/quit") && tail.includes("session kept"), JSON.stringify(tail.slice(-160)));
		check("fs-replay dock prompt row pinned", tail.includes("bi[0]>"));
		check("fs-no-leak no enter sequence inside replay", !tail.includes(ENTER));
	}
	// A2: /search inside fullscreen (readline-forced input needs no
	// modal submit, so this proves the bi#158 intercept end-to-end on
	// trees where modal submit is unavailable). The viewer nests a
	// second alt screen; Esc closes it and the loop quits clean.
	// Known v1 limit: the inner exit drops the outer session to the
	// main screen (documented in NOTES) — asserted here is the open
	// half plus clean survival, not outer repaint fidelity.
	{
		const { out, code } = await runPty({
			extraEnv: { BI_FULLSCREEN: "1" },
			stdinBeats: [[5000, "/search\r"], [11000, "\x1b"], [13000, "\x1b"], [17000, "/quit\r"], [22000, "/quit\r"]],
			timeoutS: 30,
		});
		check("fs-search-nested viewer opens inside fullscreen", out.split(ENTER).length - 1 >= 2 && out.includes("Find transcript"), `code=${code}`);
		check("fs-search-nested loop survives nested exit", code === 0);
	}
	// B: unset flag byte-identical (no alt screen).
	{
		const { out, code } = await runPty({ stdinBeats: [[5000, "/quit\r"], [10000, "/quit\r"]] });
		check("fs-unset no alt screen, exit 0", !out.includes(ENTER) && !out.includes(EXIT) && code === 0, `code=${code}`);
		check("fs-unset session kept", out.includes("session kept"));
	}
	// C: pipes never enter, even flagged.
	{
		const home = makeSandbox();
		const child = spawn("node", [CLI], {
			env: { ...process.env, HOME: home, TERM: "xterm-kitty", BI_FULLSCREEN: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => { out += d.toString("utf8"); });
		child.stderr.on("data", (d) => { out += d.toString("utf8"); });
		child.stdin.write("/quit\n");
		child.stdin.end();
		const code = await new Promise((res) => {
			const t = setTimeout(() => { try { child.kill(); } catch {} res("timeout"); }, 20000);
			child.on("close", (c) => { clearTimeout(t); res(c); });
		});
		check("fs-pipes no alt screen on pipes", !out.includes(ENTER) && !out.includes(EXIT), `code=${code}`);
	}
}

if (failures > 0) {
	console.error(`fullscreen drill: ${failures} failure(s)`);
	process.exit(1);
}
console.log("fullscreen drill: green");
