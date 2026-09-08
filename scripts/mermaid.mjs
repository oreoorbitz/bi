// bi/scripts/mermaid.mjs — mermaid degrade conformance (bi#99).
// Drives the REAL host pre-pass (dist/src/markdown.js expandMermaidFences +
// renderMarkdownTui) and asserts: (1) mermaid fences degrade to a labeled
// marker plus the raw code block, (2) non-mermaid input renders byte-identical
// with and without the pre-pass, (3) unclosed mermaid fences still degrade
// without losing rows.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const { renderMarkdownTui, expandMermaidFences } = await import(join(ROOT, "..", "dist", "src", "markdown.js"));

let failures = 0;
const check = (cond, msg) => {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${msg}`);
	} else console.log(`ok: ${msg}`);
};

const LABEL = "··· mermaid (diagram not rendered on this terminal)";

// (1) mermaid fences degrade labeled with rows intact.
const src = ["# Plan", "", "```mermaid", "graph TD", "A-->B", "```", "", "after"].join("\n");
const pre = expandMermaidFences(src);
check(pre.includes(LABEL), "pre-pass inserts the degrade marker");
check(pre.includes("graph TD") && pre.includes("A-->B"), "pre-pass keeps diagram rows");
check(!pre.includes("```mermaid"), "pre-pass strips the mermaid info string");
const rendered = renderMarkdownTui(src, 80, null).join("\n");
check(rendered.includes(LABEL), "TTY render shows the marker");
check(rendered.includes("graph TD") && rendered.includes("A-->B"), "TTY render keeps diagram rows");
check(!rendered.split("\n").some((l) => l.includes("\x1b")), "degrade adds zero escapes at theme null");

// Info-string variants take the same path.
for (const info of ["```Mermaid", "```mermaid graph TD", "```MERMAID"]) {
	const p = expandMermaidFences([info, "x", "```"].join("\n"));
	check(p.includes(LABEL) && p.includes("\nx\n"), `pre-pass degrades ${JSON.stringify(info)}`);
}

// (2) non-mermaid input is untouched.
const plain = ["# T", "", "```ts", "const x = 1;", "```", "", "text"].join("\n");
check(expandMermaidFences(plain) === plain, "pre-pass leaves non-mermaid fences alone");
check(
	JSON.stringify(renderMarkdownTui(plain, 80, null)) === JSON.stringify(renderMarkdownTui(expandMermaidFences(plain), 80, null)),
	"non-mermaid TTY render is byte-identical through the pre-pass",
);

// A ``` row inside a live code block never retriggers detection.
const nested = ["```ts", "const s = \"```mermaid\";", "```"].join("\n");
check(expandMermaidFences(nested) === nested, "fence rows inside code blocks do not retrigger");

// (3) unclosed mermaid fence degrades without losing rows.
const open = ["```mermaid", "graph TD", "A-->B"].join("\n");
const po = expandMermaidFences(open);
check(po.includes(LABEL) && po.includes("A-->B"), "unclosed mermaid fence degrades with rows intact");

if (failures) process.exit(1);
console.log("mermaid: all green");
