// bi/src/paths.ts — recursive fuzzy file-path completion (bi#159).
//
// Kimi-code `CombinedAutocompleteProvider` completes paths recursively
// (`walkDirectoryWithFd`: `fd --base-directory … --type f --type d
// --follow --hidden --exclude .git`, `--full-path` when the query
// contains `/`, exact/prefix/substring scoring with a directory bonus,
// quote-aware prefixes, directories applied without trailing space).
// Bi's old `completePathPrefix` was one `readdirSync` level with a
// case-sensitive `startsWith` filter: no recursion, dotfiles hidden,
// no quotes, so `.bais/issues/…` was uncompletable and spaced paths
// split into two tokens.
//
// This module ports the recipe host-side: fd-backed recursive search
// with a bounded `readdirSync` fallback (no hard fd dependency —
// failure still completes nothing), shared filter/rank/format so both
// backends agree, dotfiles included, `.git` (and fallback-only
// `node_modules`) excluded, quote round-trip for spaced paths,
// directories suffixed `/` with no trailing space, files with a
// trailing space (or closing quote + space) so the next Tab continues
// or moves on. Both the readline completer and `makeSlashProvider`
// consume these values verbatim through `argCandidates`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Cap + bounds: at most this many display values; the fallback walk
// visits at most this many entries and descends at most this deep.
export const PATH_COMPLETION_LIMIT = 20;
const WALK_ENTRY_BUDGET = 4000;
const WALK_MAX_DEPTH = 8;

// Score an entry against the query, higher first (kimi `scoreEntry`
// shape: exact filename > filename prefix > filename substring >
// full-path substring, directories bonused when they match at all).
export function scorePathEntry(relPath: string, query: string, isDirectory: boolean): number {
	const fileName = basename(relPath);
	const lowerName = fileName.toLowerCase();
	const lowerQuery = query.toLowerCase();
	let score = 0;
	if (lowerName === lowerQuery) score = 100;
	else if (lowerName.startsWith(lowerQuery)) score = 80;
	else if (lowerName.includes(lowerQuery)) score = 50;
	else if (relPath.toLowerCase().includes(lowerQuery)) score = 30;
	if (isDirectory && score > 0) score += 10;
	return score;
}

// Never complete inside `.git` (fd gets `--exclude .git*`; the walk
// and both filters enforce the same rule on the relative path).
function isGitPath(rel: string): boolean {
	return rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/") || rel.includes("/.git");
}

interface PathEntry {
	rel: string;
	isDirectory: boolean;
}

function escapeFdRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// fd backend (kimi `walkDirectoryWithFd` args). Returns null when fd
// is absent, times out, or exits nonzero — the caller falls back to
// the walk with identical ranking. `toDisplayPath` stays POSIX (fd
// prints `/` even on Windows; bi runs POSIX but the normalize is free).
function tryFdPaths(cwd: string, query: string, limit: number): PathEntry[] | null {
	try {
		const args = [
			"--base-directory",
			cwd,
			"--max-results",
			String(limit * 10),
			"--type",
			"f",
			"--type",
			"d",
			"--follow",
			"--hidden",
			"--exclude",
			".git",
			"--exclude",
			".git/*",
			"--exclude",
			".git/**",
		];
		if (query.includes("/")) args.push("--full-path");
		if (query) args.push(escapeFdRegex(query));
		const out = spawnSync("fd", args, { cwd, encoding: "utf8", timeout: 1500, maxBuffer: 1 << 20 });
		if (out.error || out.status !== 0 || !out.stdout) return null;
		const entries: PathEntry[] = [];
		for (const line of String(out.stdout).trim().split("\n")) {
			if (!line) continue;
			const display = line.replace(/\\/g, "/");
			const isDirectory = display.endsWith("/");
			const rel = isDirectory ? display.slice(0, -1) : display;
			if (!rel || isGitPath(rel)) continue;
			entries.push({ rel, isDirectory });
		}
		return entries;
	} catch {
		return null;
	}
}

// Bounded recursive walk (the no-fd fallback). Same exclusions as fd
// (plus `node_modules`, which fd drops via `.gitignore` on real repos
// but a raw walk would otherwise crawl). Sync by readline's contract.
function walkPaths(cwd: string): PathEntry[] {
	const entries: PathEntry[] = [];
	let budget = WALK_ENTRY_BUDGET;
	const walk = (dir: string, depth: number): void => {
		if (budget <= 0 || depth > WALK_MAX_DEPTH) return;
		let children;
		try {
			children = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const child of children) {
			if (budget <= 0) return;
			// `.git` never completes; `node_modules` is skipped here for
			// walk speed (explicit navigation still works via the scoped
			// branch, and the shared rank filter keeps fd identical).
			if (child.name === ".git" || child.name === "node_modules") continue;
			const abs = join(dir, child.name);
			let isDirectory = child.isDirectory();
			if (!isDirectory && child.isSymbolicLink()) {
				try {
					isDirectory = statSync(abs).isDirectory();
				} catch {
					// Broken symlink — treat as a file below.
				}
			}
			const rel = relative(cwd, abs).split(sep).join("/");
			if (!rel || isGitPath(rel)) continue;
			budget -= 1;
			entries.push({ rel, isDirectory });
			if (isDirectory) walk(abs, depth + 1);
		}
	};
	walk(cwd, 0);
	return entries;
}

// Shared match predicate: queries with `/` match across the full
// relative path (fd `--full-path` mode); bare queries match the
// basename (fd filename mode). Case-insensitive both ways.
function matchesQuery(rel: string, query: string): boolean {
	const lower = rel.toLowerCase();
	const q = query.toLowerCase();
	if (!q) return true;
	if (q.includes("/")) return lower.includes(q);
	return basename(rel).toLowerCase().includes(q);
}

// Shared rank: score desc, directories first, then alphabetical.
function sortPaths(entries: PathEntry[], query: string, limit: number): PathEntry[] {
	const scored = entries.map((e) => ({ entry: e, score: scorePathEntry(e.rel, query, e.isDirectory) }));
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.entry.isDirectory !== b.entry.isDirectory) return a.entry.isDirectory ? -1 : 1;
		return a.entry.rel.localeCompare(b.entry.rel);
	});
	return scored.slice(0, limit).map((s) => s.entry);
}

// `node_modules` never matches recursively (fd drops it via
// `.gitignore` on real repos; the walk skips the dir for speed; this
// shared filter keeps both backends identical even with no gitignore).
// Explicit navigation still works — the scoped branch below lists real
// directories whatever they are called.
function hasExcludedSegment(rel: string): boolean {
	return rel.split("/").includes("node_modules");
}

// Shared filter + rank, capped. The filter is skipped for already
// filtered sets (scoped directory children whose display form —
// `./`-stripped, `..`-resolved — no longer contains the raw query).
function rankPaths(entries: PathEntry[], query: string, limit: number): PathEntry[] {
	const filtered = entries
		.filter((e) => !hasExcludedSegment(e.rel))
		.filter((e) => matchesQuery(e.rel, query))
		.filter((e) => (query ? scorePathEntry(e.rel, query, e.isDirectory) > 0 : true));
	return sortPaths(filtered, query, limit);
}

// Quote a display value when it needs it (spaces) or the user already
// opened a quote: `"my dir/file.md"`. Directories never take a
// trailing space (completion continues into them); files take one
// (or closing-quote + space) so the next Tab moves to a fresh token.
export function formatPathValue(rel: string, isDirectory: boolean, quoted: boolean): string {
	const needsQuotes = quoted || rel.includes(" ");
	// The slash sits INSIDE the quotes (`"my dir/"`) so quote-mode
	// continuation strips one leading `"` and still names the dir.
	if (isDirectory) return needsQuotes ? `"${rel}/"` : `${rel}/`;
	return needsQuotes ? `"${rel}" ` : `${rel} `;
}

// Filesystem-path completion for the file-taking slashes (tree,
// attach, import, export). Recursive across the tree below `cwd`,
// capped and ranked directories-first; failures complete nothing.
// A leading `"` marks quoted mode (values stay quoted); `~/` expands
// against home like before.
export function completePathPrefix(prefix: string, opts: { cwd?: string; limit?: number } = {}): string[] {
	try {
		const cwd = opts.cwd ?? process.cwd();
		const limit = opts.limit ?? PATH_COMPLETION_LIMIT;
		const quoted = prefix.startsWith('"');
		let raw = quoted ? prefix.slice(1) : prefix;
		const tilde = raw.startsWith("~/");
		const home = homedir();
		if (tilde) raw = join(home, raw.slice(2));
		// Anchored queries (absolute or `~/`) stay single-level scoped
		// like before — values keep the typed anchor, never cwd-relative.
		if (raw.startsWith("/")) {
			const isDirQuery = raw.endsWith("/");
			const absDir = isDirQuery ? raw : dirname(raw);
			const base = isDirQuery ? "" : basename(raw);
			try {
				const children = readdirSync(absDir, { withFileTypes: true });
				const out: { rel: string; score: number; isDir: boolean }[] = [];
				for (const child of children) {
					if (child.name === ".git") continue;
					if (!child.name.toLowerCase().startsWith(base.toLowerCase())) continue;
					let isDirectory = child.isDirectory();
					if (!isDirectory && child.isSymbolicLink()) {
						try {
							isDirectory = statSync(join(absDir, child.name)).isDirectory();
						} catch {}
					}
					let display = join(absDir, child.name).split(sep).join("/");
					if (tilde) {
						const absEntry = join(absDir, child.name);
						display = `~/${relative(home, absEntry).split(sep).join("/")}`;
					}
					if (isGitPath(display)) continue;
					out.push({ rel: display, score: scorePathEntry(child.name, base || child.name, isDirectory), isDir: isDirectory });
				}
				out.sort((a, b) => b.score - a.score || (a.isDir === b.isDir ? a.rel.localeCompare(b.rel) : a.isDir ? -1 : 1));
				return out.slice(0, limit).map((e) => formatPathValue(e.rel, e.isDir, quoted));
			} catch {
				return [];
			}
		}
		const abs = resolve(cwd, raw);
		// Fast scoped path: the query names an existing directory (or a
		// prefix of entries inside one) — list that directory's children
		// directly, then merge recursive matches below for depth.
		let entries: PathEntry[] | null = null;
		const dirPart = raw.endsWith("/") ? raw : dirname(raw);
		const absDir = resolve(cwd, dirPart);
		if (absDir === abs || existsSync(absDir)) {
			try {
				const base = raw.endsWith("/") ? "" : basename(raw);
				const children = readdirSync(raw.endsWith("/") ? abs : absDir, { withFileTypes: true });
				entries = [];
				// Top-level listings (no explicit directory typed) skip
			// `node_modules` like the recursive search; explicit
			// navigation (`node_modules/p…`) still lists it.
			const explicitDir = dirPart !== "." && dirPart !== "";
			for (const child of children) {
				if (child.name === ".git") continue;
				if (!explicitDir && child.name === "node_modules") continue;
				if (!child.name.toLowerCase().startsWith(base.toLowerCase())) continue;
				let isDirectory = child.isDirectory();
				if (!isDirectory && child.isSymbolicLink()) {
					try {
						isDirectory = statSync(join(raw.endsWith("/") ? abs : absDir, child.name)).isDirectory();
					} catch {}
				}
					const childRaw = raw.endsWith("/") ? `${raw}${child.name}` : `${dirPart === "." ? "" : `${dirPart}/`}${child.name}`;
					const rel = relative(cwd, resolve(cwd, childRaw)).split(sep).join("/");
					if (!rel || isGitPath(rel)) continue;
					entries.push({ rel, isDirectory });
				}
			} catch {
				entries = null;
			}
		}
		// Recursive matches below cwd (fd, else bounded walk).
		const fdEntries = tryFdPaths(cwd, raw, limit);
		const recursive = rankPaths(fdEntries ?? walkPaths(cwd), raw, limit);
		const seen = new Set<string>();
		const merged: PathEntry[] = [];
		for (const e of [...(entries ?? []), ...recursive]) {
			if (seen.has(e.rel)) continue;
			seen.add(e.rel);
			merged.push(e);
		}
		// Both halves arrive pre-filtered — sort only, so scoped
		// children keep their exact prefix matches.
		const ranked = sortPaths(merged, raw, limit);
		return ranked.map((e) => formatPathValue(e.rel, e.isDirectory, quoted));
	} catch {
		return [];
	}
}

// Split the argument rest of a `/cmd "…` line into the completion
// token (null when the line is not quote-shaped — the caller keeps the
// old regex path byte-identical). Closed-quote-then-more (`"a b" c`)
// completes the token after the quote; unclosed (`"a b/c`) completes
// the whole rest including the quote so values stay quoted.
export function splitCompletionToken(rest: string): string | null {
	if (!rest.startsWith('"')) return null;
	const closed = rest.match(/^"[^"]*"\s+(.*)$/s);
	if (closed) {
		const after = closed[1] ?? "";
		if (after.startsWith('"')) return splitCompletionToken(after);
		return after.match(/(\S*)$/)?.[1] ?? "";
	}
	return rest;
}

// Split a `/cmd args…` line into command + completion token. The plain
// `\S*` shape is first (byte-identical to the old inline regexes); the
// quoted branch (`/attach "my dir/fi`) splits the quote instead. Null
// when neither matches — the caller keeps its old fallthrough. Shared
// by the readline completer and `makeSlashProvider` so both agree.
export function splitSecondWord(line: string): { cmd: string; token: string } | null {
	const second = line.match(/^\/(\S+)[ \t]+(\S*)$/);
	if (second) return { cmd: second[1]!, token: second[2]! };
	const quoted = line.match(/^\/(\S+)[ \t]+(".*)$/s);
	if (quoted) {
		const token = splitCompletionToken(quoted[2]!);
		if (token !== null) return { cmd: quoted[1]!, token };
	}
	return null;
}

// Strip one surrounding `"…"` pair (attachment/arg read-back: the
// quoted completion is one token again).
export function unquotePath(arg: string): string {
	const t = arg.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
	return t;
}
