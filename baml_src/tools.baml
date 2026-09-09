// Bucket A — pi core/tools ToolDefinition -> BAML ToolSpec.
// Host executors (fs, bash) stay in TS (bi/src/tools/*.ts), BAML only owns
// the plain-data spec (name/description/input_schema) so the prompt can be
// validated and the LLM can call it. This mirrors bi's existing ToolSpec
// handling (limitation 4) where build_toolbox builds ai.tools.Tool inside
// the VM from plain data.

function _tool_read() -> ToolSpec {
    ToolSpec {
        name: "read",
        description: "Read file contents. Use to examine files instead of cat.",
        input_schema: {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read (relative or absolute)",
                },
                "offset": { "type": "number", "description": "Line number to start reading from (1-indexed)" },
                "limit": { "type": "number", "description": "Maximum number of lines to read" },
            },
            "required": ["path"],
            "additionalProperties": false,
        },
    }
}

function _tool_write() -> ToolSpec {
    ToolSpec {
        name: "write",
        description: "Create or overwrite a file with content. Paths stay inside the project directory (escapes refuse); writes need project trust — a refusal names the fix, do not retry blindly.",
        input_schema: {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to write (relative or absolute)",
                },
                "content": { "type": "string", "description": "Content to write to the file" },
            },
            "required": ["path", "content"],
            "additionalProperties": false,
        },
    }
}

function _tool_edit() -> ToolSpec {
    ToolSpec {
        name: "edit",
        description: "Edit a file by replacing text. Use for surgical edits. All oldText values must match or nothing applies; same trust and path rules as write.",
        input_schema: {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to edit" },
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "oldText": { "type": "string" }, "newText": { "type": "string" } },
                        "required": ["oldText", "newText"],
                    },
                },
            },
            "required": ["path", "edits"],
            "additionalProperties": false,
        },
    }
}

function _tool_bash() -> ToolSpec {
    ToolSpec {
        name: "bash",
        description: "Execute a shell command (bash).",
        input_schema: {
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute" },
                "timeout": { "type": "number", "description": "Timeout in seconds (optional)" },
            },
            "required": ["command"],
            "additionalProperties": false,
        },
    }
}

function _tool_ls() -> ToolSpec {
    ToolSpec {
        name: "ls",
        description: "List directory contents.",
        input_schema: {
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Path to the directory to list" } },
            "required": ["path"],
            "additionalProperties": false,
        },
    }
}

function _tool_grep() -> ToolSpec {
    ToolSpec {
        name: "grep",
        description: "Search for a pattern in files.",
        input_schema: {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for" },
                "path": { "type": "string", "description": "Path to search in (optional)" },
                "glob": { "type": "string", "description": "Glob filter (optional)" },
            },
            "required": ["pattern"],
            "additionalProperties": false,
        },
    }
}

function _tool_find() -> ToolSpec {
    ToolSpec {
        name: "find",
        description: "Find files by name or pattern.",
        input_schema: {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "File name pattern to find" },
                "path": { "type": "string", "description": "Path to search in (optional)" },
            },
            "required": ["pattern"],
            "additionalProperties": false,
        },
    }
}

// BAIS tool specs — VENDORED from bais/baml_src/tools.baml (the source of
// truth). The 0.17.0 toolchain ignores `baml.toml [dependencies]`, so the
// `bais.*` cross-package refs do not resolve here; these copies keep bi's
// registry compiling with identical name/description/input_schema. When adding
// or changing a bais_* tool, change it in bais first, then re-vendor here and
// keep the bodies byte-identical. (Revert to `bais.BaisXTool()` delegation once
// cross-package imports land.)

function _tool_bais_list() -> ToolSpec {
    ToolSpec {
        name: "bais_list",
        description: "List BAIS issues from .bais/issues/*.toml (BAML-validated via bais parser). Returns {issues, unparseable}: files the parser rejected are reported in `unparseable`, never guessed at — treat a non-empty `unparseable` as a gap in the list, not as zero issues. Returns ROWS by default (id/status/kind/title/area per issue) — full bodies ride `bais show` or a result narrowed to one issue; pass include_bodies:true for full records. Structured filters mirror the schema keys (all optional, ANDed, rows by default so a search costs rows, never bodies): exact status/kind/area/severity, query (case-insensitive substring over id + title), title_regex/body_regex (invalid patterns refuse loud naming the pattern, never silent empty), id_min/id_max (numeric-part bounds per namespace, e.g. 100..199). An empty result is explicit ({issues: []}), not an error. Results are compact JSON capped near 60k bytes, with a truncation notice naming the refinement (status filter / bais show), never silent.",
        input_schema: {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Filter by status (Open/Doing/Blocked/Done/Dropped) — optional",
                },
                "kind": {
                    "type": "string",
                    "description": "Exact kind filter (Bug/Feat/Proposal/Debt/Flake/Spike) — optional",
                },
                "area": {
                    "type": "string",
                    "description": "Exact area filter e.g. cli/bi — optional",
                },
                "severity": {
                    "type": "number",
                    "description": "Exact severity filter — optional",
                },
                "query": {
                    "type": "string",
                    "description": "Case-insensitive substring over id + title — optional",
                },
                "title_regex": {
                    "type": "string",
                    "description": "Pattern over the title (invalid patterns refuse loud) — optional",
                },
                "body_regex": {
                    "type": "string",
                    "description": "Pattern over the body, covers Problem:/Proposal: section searches (invalid patterns refuse loud) — optional",
                },
                "id_min": {
                    "type": "number",
                    "description": "Numeric-part lower bound per namespace (bi#100 -> 100) — optional",
                },
                "id_max": {
                    "type": "number",
                    "description": "Numeric-part upper bound per namespace — optional",
                },
                "include_bodies": {
                    "type": "boolean",
                    "description": "Return full issue records (body + edges) instead of rows — optional, default false",
                },
            },
            "additionalProperties": false,
        },
    }
}

function _tool_bais_ready() -> ToolSpec {
    ToolSpec {
        name: "bais_ready",
        description: "List ready BAIS issues (Open where not blocked by Blocks edge via bais ready_issues). Returns ROWS by default (id/status/kind/title/area per issue) — full bodies ride `bais show` or a result narrowed to one issue; pass include_bodies:true for full records. Results are compact JSON capped near 60k bytes, with a truncation notice naming the refinement (bais show), never silent.",
        input_schema: {
            "type": "object",
            "properties": {
                "include_bodies": {
                    "type": "boolean",
                    "description": "Return full issue records (body + edges) instead of rows — optional, default false",
                },
            },
            "additionalProperties": false,
        },
    }
}

function _tool_bais_new() -> ToolSpec {
    ToolSpec {
        name: "bais_new",
        description: "Create a new BAIS issue .bais/issues/<id>.toml (BAML-serialized via bais parser). Self-adjust: call when you discover a pattern (e.g. sub-agent timeout too short, reconcile conflicts, flaky tool) — title/body should capture repro + acceptance.",
        input_schema: {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Issue title" },
                "kind": {
                    "type": "string",
                    "description": "Kind: Bug/Feat/Proposal/Debt/Flake/Spike (default Feat)",
                },
                "area": {
                    "type": "string",
                    "description": "Area e.g. cli/bi, bridge/ffi, agent/reconcile (optional)",
                },
                "body": {
                    "type": "string",
                    "description": "Markdown body with repro + acceptance (optional)",
                },
                "status": {
                    "type": "string",
                    "description": "Status: Open/Doing/Blocked/Done/Dropped (default Open)",
                },
            },
            "required": ["title"],
            "additionalProperties": false,
        },
    }
}

function _tool_bais_move() -> ToolSpec {
    ToolSpec {
        name: "bais_move",
        description: "Move a BAIS issue to a new Status (re-serializes via bais BAML parser).",
        input_schema: {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Issue id e.g. bi#09" },
                "status": { "type": "string", "description": "New status: Open/Doing/Blocked/Done/Dropped" },
            },
            "required": ["id", "status"],
            "additionalProperties": false,
        },
    }
}

function _tool_bais_check() -> ToolSpec {
    ToolSpec {
        name: "bais_check",
        description: "Validate every .bais/issues/*.toml via bais BAML parser (compact JSON result capped near 60k bytes, truncation notice names bais show — the check itself is unchanged). Returns per-file verdict rows {ok, bad, dangling, cycles, evidence}, never bodies: `ok` is passing ids only, `bad` is per-file parse failures — failures serialize first and `ok` last so a cap truncation cuts ok ids, never a failure (verdict rows complete by construction). `dangling` is edge ends naming an id that does not exist — status Missing (this project: a defect, it parks the target issue because an unresolvable blocker blocks) or External (another project's id, not resolvable from here) — `cycles` is ids in a Blocks/DependsOn dependency cycle (or downstream of one), which ready_issues reports only as silence.",
        input_schema: { "type": "object", "properties": {}, "additionalProperties": false },
    }
}

function _tool_bais_graph() -> ToolSpec {
    ToolSpec {
        name: "bais_graph",
        description: "Graph traversal from a BAIS issue via Blocks/DependsOn/etc edges (bounded BFS, both directions). Returns ROWS by default (id/status/kind/title/area per issue) — full bodies ride `bais show` or a result narrowed to one issue; pass include_bodies:true for full records. Traversal is depth-capped (default 3, pass depth for shallower/deeper) and node-capped near 200 rows: over-cap results carry truncated:true plus a notice naming the refinement (narrower --from, shallower depth), never silent. Results are compact JSON capped near 60k bytes.",
        input_schema: {
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "Starting issue id e.g. bi#04" },
                "depth": {
                    "type": "number",
                    "description": "Max BFS hops from `from` (default 3, 0 is just `from` itself) — optional",
                },
                "include_bodies": {
                    "type": "boolean",
                    "description": "Return full issue records (body + edges) instead of rows — optional, default false",
                },
            },
            "required": ["from"],
            "additionalProperties": false,
        },
    }
}

function _tool_report_subagent_timeout() -> ToolSpec {
    ToolSpec {
        name: "report_subagent_timeout",
        description: "Report sub-agent timeout pattern (directive, duration_ms, timeout_ms) → creates BAIS issue for self-adjust. Call when a sub-agent times out or you notice consistently short timeouts.",
        input_schema: {
            "type": "object",
            "properties": {
                "directive": { "type": "string", "description": "Sub-agent directive/task that timed out" },
                "duration_ms": { "type": "number", "description": "Actual duration before timeout" },
                "timeout_ms": { "type": "number", "description": "Configured timeout" },
                "area": {
                    "type": "string",
                    "description": "Area e.g. agent/subagent (default agent/subagent)",
                },
            },
            "required": ["directive", "duration_ms", "timeout_ms"],
            "additionalProperties": false,
        },
    }
}

function _tool_report_reconcile_conflict() -> ToolSpec {
    ToolSpec {
        name: "report_reconcile_conflict",
        description: "Report reconcile conflict pattern (conflict_count, files) → creates BAIS issue. Call when merging sub-agent results shows repeated conflicts.",
        input_schema: {
            "type": "object",
            "properties": {
                "conflict_count": { "type": "number", "description": "Number of conflicts" },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Files with conflicts",
                },
                "area": {
                    "type": "string",
                    "description": "Area e.g. agent/reconcile (default agent/reconcile)",
                },
            },
            "required": ["conflict_count"],
            "additionalProperties": false,
        },
    }
}

// bi#77 write/edit execution policy. The host enforces; BAML owns every
// refusal string and the envelope contract (path + before/after, after
// null never — a write always produces content). Trust jail: cwd jail +
// affirmative project trust (allow, or session for this run); deny and
// undecided refuse with the fix named. Edits are atomic: all oldTexts
// must match before any write lands.
function refuse_write_outside_root(path: string) -> string {
    `refusing to write outside the project root: "${path}" — paths resolve inside the working directory (symlink escapes included)`
}

function refuse_write_untrusted() -> string {
    `refusing to write: project trust is not allow — run interactively and answer the trust prompt, or /trust allow|session first`
}

function refuse_write_too_large(path: string, limit: int) -> string {
    `refusing to write "${path}": content exceeds the ${limit} byte tool cap`
}

function edit_missing_text(path: string, index: int) -> string {
    `edit ${index} does not match "${path}": oldText not found — no edits applied`
}

// bi#150 bash execution policy. The host enforces; BAML owns every
// refusal string. Only allowlisted commands run (first token of the
// command line); everything else refuses with the policy reason named.
// Runs die at their timeout (killed, never orphaned) and secret-looking
// output is redacted from the transcript before the model sees it.
function refuse_bash_blocked(command: string, allowed: string) -> string {
    `refusing to run "${command}": command not on the bash allowlist (${allowed}) — run an allowlisted command instead`
}

function refuse_bash_timeout(command: string, timeout_secs: int) -> string {
    `bash timed out and was killed after ${timeout_secs}s: "${command}" — retry with a larger timeout or a narrower command`
}

// bi#151 read-only execution policy. The host enforces; BAML owns every
// refusal string. read/ls/grep/find reuse the write jail (cwd jail +
// symlink escapes refuse), serve text only (NUL refuses), and cap output
// (oversize single reads refuse with the cap named; search tools truncate
// instead and say so in the payload).
function refuse_read_outside_root(tool: string, path: string) -> string {
    `refusing ${tool} outside the project root: "${path}" — paths resolve inside the working directory (symlink escapes included)`
}

function refuse_read_too_large(tool: string, path: string, limit: int) -> string {
    `refusing ${tool} "${path}": content exceeds the ${limit} byte tool cap — narrow the read (offset/limit) or pick a smaller file`
}

function refuse_read_binary(tool: string, path: string) -> string {
    `refusing ${tool} "${path}": binary content looks present (NUL byte) — read tools serve text only`
}

// bi#170 per-call approval. The host prompts (TTY REPL only) when stored
// or session trust does not cover a write/edit/bash call; BAML owns the
// words — choice labels, per-tool headers, and both refusal results.
function approval_choices() -> string[] {
    [
        "Approve once",
        "Approve for this session",
        "Reject",
        "Reject with feedback",
    ]
}

function approval_header(tool: string) -> string {
    if (tool == "bash") {
        "Run this command?"
    } else if (tool == "write" || tool == "edit") {
        "Apply these edits?"
    } else {
        "Allow this call?"
    }
}

function refuse_approval_rejected(tool: string) -> string {
    `operator rejected this ${tool} call with no feedback — do not retry the same call; offer an alternative or ask what changed`
}

function approval_feedback_result(tool: string, feedback: string) -> string {
    `operator rejected this ${tool} call with feedback: "${feedback}" — address the feedback before retrying`
}

test "per-call approval words are BAML-shaped (bi#170)" {
    assert.equal(
        approval_choices(),
        ["Approve once", "Approve for this session", "Reject", "Reject with feedback"],
    );
    assert.equal(approval_header("bash"), "Run this command?");
    assert.equal(approval_header("write"), "Apply these edits?");
    assert.equal(approval_header("edit"), "Apply these edits?");
    assert.equal(approval_header("grep"), "Allow this call?");
    assert.equal(
        refuse_approval_rejected("write"),
        "operator rejected this write call with no feedback — do not retry the same call; offer an alternative or ask what changed",
    );
    assert.equal(
        approval_feedback_result("bash", "use rg instead"),
        "operator rejected this bash call with feedback: \"use rg instead\" — address the feedback before retrying",
    )
}

// Advertise/execute parity: ListTools names ONLY tools with a host
// executor in src/tools.ts handleTool (bi#150 bash, bi#151 read/ls/grep/find,
// bi#77 write/edit, plus bais_*/report_*). Delisting was the incident fix;
// the host-side gate (bi#152 tool-parity.mjs) pins it there too.
function ListTools() -> ToolSpec[] {
    [
        _tool_read(),
        _tool_write(),
        _tool_edit(),
        _tool_bash(),
        _tool_ls(),
        _tool_grep(),
        _tool_find(),
        _tool_bais_list(),
        _tool_bais_ready(),
        _tool_bais_new(),
        _tool_bais_move(),
        _tool_bais_check(),
        _tool_bais_graph(),
        _tool_report_subagent_timeout(),
        _tool_report_reconcile_conflict(),
    ]
}

function GetTool(name: string) -> ToolSpec? {
    for (let t in ListTools()) {
        if (t.name == name) {
            return t;
        }
    }
    null
}
