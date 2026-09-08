// bi/scripts/paths.mjs — bi#159 recursive path completion conformance.
//
// Runs against a self-built fixture under os.tmpdir (never the repo
// layout): recursive matching without intermediate slashes, dotfile
// reachability with .git excluded, quote round-trip (completion inserts
// a quoted form, unquotePath reads it back whole), dir-`/` vs file-
// space suffixes, the 20-result cap, fd-vs-fallback agreement, BAML
// complete_arg end-to-end (quoted/trailing-space values survive rank),
// and the modal provider + readline token shapes. Non-path pools are
// untouched (bi#106 acceptance intact — asserted via unknown-command
// null and the quoted fallthrough).
// Red-check (bi#57): force the scoped branch off (entries = null) and
// `recursive without intermediate slashes` fails; restore the dotfile
// filter (`!e.name.startsWith(".")`) and `dotfiles complete` fails;
// make unquotePath identity and `quote round-trips` fails. Restore all
// for green.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const paths = await import(join(ROOT, "..", "dist", "src", "paths.js"));
const { completePathPrefix, splitCompletionToken, splitSecondWord, unquotePath, scorePathEntry, formatPathValue, PATH_COMPLETION_LIMIT } = paths;
const { makeSlashProvider } = await import(join(ROOT, "..", "dist", "src", "prompt.js"));
const { complete_arg_async } = await import(join(ROOT, "..", "dist", "baml_sdk", "index.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

// Fixture tree.
const FIX = join(tmpdir(), "bi-paths-fixture");
rmSync(FIX, { recursive: true, force: true });
for (const d of ["src/sub", "my dir", ".bais/issues", ".git", "node_modules/pkg"]) mkdirSync(join(FIX, d), { recursive: true });
writeFileSync(join(FIX, "src", "cli.ts"), "x");
writeFileSync(join(FIX, "src", "sub", "deep.ts"), "x");
writeFileSync(join(FIX, "my dir", "file.md"), "x");
writeFileSync(join(FIX, ".bais", "issues", "bi#01.toml"), "x");
writeFileSync(join(FIX, ".git", "HEAD"), "x");
writeFileSync(join(FIX, "node_modules", "pkg", "x.js"), "x");
for (let i = 0; i < 30; i++) writeFileSync(join(FIX, "src", `pad${i}.ts`), "x");
const at = (prefix) => completePathPrefix(prefix, { cwd: FIX });

// 1 — recursive matching without intermediate slashes.
{
	const r = at("src/cl");
	check(r.includes("src/cli.ts "), `recursive without intermediate slashes (got ${JSON.stringify(r.slice(0, 4))})`);
	const bare = at("deep");
	check(bare.includes("src/sub/deep.ts "), `bare basename reaches depth (got ${JSON.stringify(bare)})`);
}

// 2 — dotfiles reachable, .git never completed.
{
	const d = at(".bais");
	check(d.includes(".bais/"), `dotfiles complete (got ${JSON.stringify(d.slice(0, 4))})`);
	const di = at(".bais/");
	check(di.includes(".bais/issues/"), `second Tab reaches inside dot dirs (got ${JSON.stringify(di.slice(0, 4))})`);
	const g = at(".g");
	check(!g.some((s) => /(^|\/)\.git\//.test(s) || s === ".git/" || s === ".git "), `no .git entries (got ${JSON.stringify(g.slice(0, 4))})`);
	const all = at("");
	check(!all.some((s) => s.includes(".git/")), "bare prefix never surfaces .git");
	check(!at("").some((s) => s.includes("node_modules")), "fallback walk skips node_modules");
}

// 3 — suffixes: directories append `/` with no space, files a space.
{
	const d = at("src/");
	check(d.includes("src/sub/") && d.includes("src/cli.ts "), `scoped listing mixes dirs and files (got ${JSON.stringify(d.slice(0, 4))})`);
	check(d.every((s) => s.endsWith("/") !== s.endsWith(" ")), "every value takes exactly one suffix kind");
	const f = at("src/cl");
	check(f.filter((s) => s.includes("cli.ts")).every((s) => s.endsWith(" ")), "files append a trailing space");
	check(!f.some((s) => s.endsWith("/ ")), "no value mixes slash and space");
}

// 4 — cap.
check(at("").length <= PATH_COMPLETION_LIMIT && PATH_COMPLETION_LIMIT === 20, `results capped at 20 (got ${at("").length})`);

// 5 — quotes: completion inserts the quoted form, read-back is one token.
{
	const q = at('"my dir/fi');
	check(q.includes('"my dir/file.md" '), `spaced path completes quoted (got ${JSON.stringify(q)})`);
	check(unquotePath('"my dir/file.md"') === "my dir/file.md", "quote round-trips through unquotePath");
	check(unquotePath("src/cli.ts") === "src/cli.ts", "unquoted args pass through");
	check(unquotePath('"open') === '"open', "unclosed quotes stay literal");
	check(splitCompletionToken('"my dir/fi') === '"my dir/fi', "unclosed quote completes whole");
	check(splitCompletionToken('"a b" c/d') === "c/d", "closed quote completes the next token");
	check(splitCompletionToken('"a b" ') === "", "closed quote plus space starts a fresh token");
	check(splitCompletionToken("plain") === null, "unquoted rest keeps the old regex path");
	// 5b — splitSecondWord: the shared readline/provider shape.
	check(JSON.stringify(splitSecondWord("/attach src/cl")) === JSON.stringify({ cmd: "attach", token: "src/cl" }), "plain second word splits");
	check(JSON.stringify(splitSecondWord("/trust ")) === JSON.stringify({ cmd: "trust", token: "" }), "trailing space splits empty");
	check(JSON.stringify(splitSecondWord('/attach "my dir/fi')) === JSON.stringify({ cmd: "attach", token: '"my dir/fi' }), "quoted token splits whole");
	check(JSON.stringify(splitSecondWord('/attach "a b" c/d')) === JSON.stringify({ cmd: "attach", token: "c/d" }), "closed quote splits the next token");
	check(splitSecondWord("/attach a b") === null, "unquoted multi-token keeps the old null");
	check(splitSecondWord("hello") === null, "free text keeps the old null");
	check(splitSecondWord("/model") === null, "bare command keeps the old null");
	check(formatPathValue("a/b", true, false) === "a/b/", "dir formats slash-only");
	check(formatPathValue("a/f.ts", false, false) === "a/f.ts ", "file formats with space");
	check(formatPathValue("my dir", true, false) === '"my dir/"', "spaced dir quotes without space");
}

// 6 — scoring shape (kimi scoreEntry ports).
check(scorePathEntry("src/cli.ts", "cli.ts", false) === 100, "exact basename scores 100");
check(scorePathEntry("src/cli.ts", "cl", false) > scorePathEntry("src/decl.ts", "cl", false), "prefix beats substring");
check(scorePathEntry("src/sub", "sub", true) > scorePathEntry("src/sub.ts", "sub", false), "matching dirs bonus over files");

// 7 — fd vs fallback agreement (same ranking fn; PATH scrub forces the walk).
{
	const queries = ["src/cl", "deep", ".bais", '"my dir/fi', ""];
	const withFd = process.env.PATH;
	let fdBin = null;
	for (const dir of String(withFd).split(":")) {
		if (existsSync(join(dir, "fd"))) { fdBin = dir; break; }
	}
	const runAll = () => queries.map((q) => JSON.stringify(at(q)));
	const baseline = runAll();
	if (fdBin) {
		process.env.PATH = `/usr/bin:/bin:/usr/sbin:/sbin`;
		const fallback = runAll();
		process.env.PATH = withFd;
		check(JSON.stringify(baseline) === JSON.stringify(fallback), "fd and fallback walks agree exactly");
	} else {
		check(true, "fd absent here — fallback walk is the only backend (no hard dep)");
	}
	check(JSON.stringify(baseline) === JSON.stringify(runAll()), "completion is deterministic run to run");
}

// 8 — BAML end-to-end: quoted/trailing-space values survive complete_arg.
{
	for (const token of ["src/cl", '"my dir/fi', ".bais"]) {
		const pool = completePathPrefix(token, { cwd: FIX });
		const m = await complete_arg_async(token, pool);
		check(m.length > 0, `complete_arg keeps ${token} matches (got ${JSON.stringify(m.slice(0, 2))})`);
	}
	const empty = await complete_arg_async("", ["a", "b"]);
	check(empty.join(",") === "a,b", "empty prefix returns the pool unchanged (bi#106 shape)");
}

// 9 — modal provider end-to-end (second-word path commands + quoted branch).
{
	const pool = {
		names: () => ["attach", "tree", "model"],
		describe: () => null,
		argPool: async (cmd, prefix) => (cmd === "attach" || cmd === "tree" ? completePathPrefix(prefix, { cwd: FIX }) : []),
	};
	const provider = makeSlashProvider(pool);
	const s = await provider.getSuggestions(["/attach src/cl"], 0, 14, { signal: AbortSignal.abort() });
	check(s !== null && s.prefix === "src/cl" && s.items.some((i) => i.value === "src/cli.ts "), `provider completes paths (got ${JSON.stringify(s && s.items.slice(0, 2))})`);
	const q = await provider.getSuggestions(['/attach "my dir/fi'], 0, 18, { signal: AbortSignal.abort() });
	check(q !== null && q.prefix === '"my dir/fi' && q.items.some((i) => i.value === '"my dir/file.md" '), `provider completes quoted paths (got ${JSON.stringify(q && q.items)})`);
	const dir = await provider.getSuggestions(["/attach src/sub/"], 0, 16, { signal: AbortSignal.abort() });
	check(dir !== null && dir.items.some((i) => i.value === "src/sub/deep.ts "), "completion continues into directories");
	const acc = provider.applyCompletion(['/attach "my dir/fi'], 0, 18, { value: '"my dir/file.md" ', label: '"my dir/file.md" ' }, '"my dir/fi');
	check(acc.lines[0] === '/attach "my dir/file.md" ', `quoted accept splices verbatim (got ${JSON.stringify(acc.lines[0])})`);
	check((await provider.getSuggestions(["/nope x"], 0, 7, { signal: AbortSignal.abort() })) === null, "unknown command still completes nothing");
	check((await provider.getSuggestions(["/attach a b"], 0, 11, { signal: AbortSignal.abort() })) === null, "unquoted multi-token keeps the old null");
	check((await provider.getSuggestions(["/model x"], 0, 8, { signal: AbortSignal.abort() })) === null, "non-path pools unchanged (empty pool, no match)");
}

rmSync(FIX, { recursive: true, force: true });

if (failures) process.exit(1);
console.log("paths: all green");
