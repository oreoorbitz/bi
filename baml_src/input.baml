// bi/baml_src/input.baml — input chrome policy (bi#32, slice 1).
// BAML owns skip rules, tree shaping, and attachment fencing; the host
// owns FS walking, $EDITOR spawning, and staging. Image paste waits on
// the turn image pipeline (SendTurnWithImage has no host callers yet);
// custom hotkeys wait on a raw-mode input layer readline cannot give.

class TreeEntry {
    path: string,
    is_dir: bool,
    depth: int,
}

// Directory/file names never descended into or listed. Toolchain and
// VCS internals, not user work: showing them buries the signal.
function tree_skip_names() -> string[] {
    [".git", ".hg", ".svn", ".eden", "node_modules", "dist", "baml_sdk", ".baml", "__pycache__", ".venv", "target"]
}

function tree_should_skip(name: string) -> bool {
    if (name.length() == 0) {
        true
    } else if (name.slice(0, 1) == ".") {
        name != ".bais" && name != ".bi"
    } else {
        let skip = tree_skip_names();
        let hit = false;
        for (let s in skip) {
            if (s == name) {
                hit = true
            }
        }
        hit
    }
}

// Numbered rows in listed order (host keeps the same array so numbers
// resolve). Dirs carry a trailing slash; depth indents two spaces.
function format_tree(entries: TreeEntry[]) -> string {
    if (entries.length() == 0) {
        "(empty)"
    } else {
        let out = "";
        let n = 0;
        for (let e in entries) {
            n = n + 1;
            let pad = "";
            let d = 0;
            while (d < e.depth) {
                pad = `${pad}  `;
                d = d + 1
            }
            let name = if (e.is_dir) {
                `${e.path}/`
            } else {
                e.path
            };
            out = `${out}${pad}${n}  ${name}\n`;
        }
        out
    }
}

// Staged file block injected above the user prompt (like BAIS context):
// fenced, line-capped, with an explicit truncation marker so the model
// never mistakes a cut file for a whole one.
function format_attachment(name: string, content: string, max_lines: int) -> string {
    let lines = content.split("\n");
    let shown = "";
    let i = 0;
    while (i < lines.length() && i < max_lines) {
        shown = `${shown}${lines.at(i) ?? ""}\n`;
        i = i + 1
    }
    if (lines.length() > max_lines) {
        let more = lines.length() - max_lines;
        shown = `${shown}… (${more} more lines, truncated)\n`;
    }
    `[attached ${name}]\n${shown}`
}

test "skip rules hide toolchain, keep user dotfiles" {
    assert.is_true(tree_should_skip(".git"));
    assert.is_true(tree_should_skip("node_modules"));
    assert.is_true(tree_should_skip("dist"));
    assert.is_true(tree_should_skip("baml_sdk"));
    assert.is_true(tree_should_skip(".hidden"));
    assert.is_true(!tree_should_skip(".bais"));
    assert.is_true(!tree_should_skip(".bi"));
    assert.is_true(!tree_should_skip("src"));
    assert.is_true(!tree_should_skip("main.baml"))
}

test "tree numbers rows in order with depth indent" {
    let entries = [
        TreeEntry { path: "src", is_dir: true, depth: 0 },
        TreeEntry { path: "src/cli.ts", is_dir: false, depth: 1 },
        TreeEntry { path: "README.md", is_dir: false, depth: 0 },
    ];
    let out = format_tree(entries);
    assert.contains(out, "1  src/");
    assert.contains(out, "  2  src/cli.ts");
    assert.contains(out, "3  README.md");
    assert.equal(format_tree([]), "(empty)")
}

test "attachment fences and marks truncation" {
    let full = format_attachment("a.txt", "l1\nl2", 10);
    assert.contains(full, "[attached a.txt]");
    assert.contains(full, "l1\nl2");
    assert.is_true(!full.includes("truncated"));
    let cut = format_attachment("b.txt", "l1\nl2\nl3", 2);
    assert.contains(cut, "l1\nl2\n");
    assert.contains(cut, "… (1 more lines, truncated)")
}
