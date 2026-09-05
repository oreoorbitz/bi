// Footer location segments (pi footer shows pwd + git branch; BAML
// shapes the segments, the host only supplies values).
import { execFileSync } from "node:child_process";

// Home-collapsed cwd (~/…) so the one-row footer stays compact.
export function footerCwd(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const cwd = process.cwd();
	if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
	return cwd;
}

// Current branch, or null outside a repo / on detached HEAD / on error.
export function gitBranch(): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			stdio: ["ignore", "pipe", "ignore"], timeout: 2000, encoding: "utf8",
		}).trim();
		return out && out !== "HEAD" ? out : null;
	} catch {
		return null;
	}
}
