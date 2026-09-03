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
        description: "Create or overwrite a file with content.",
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
        description: "Edit a file by replacing text. Use for surgical edits.",
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
        description: "List BAIS issues from .bais/issues/*.toml (BAML-validated via bais parser). Returns {issues, unparseable}: files the parser rejected are reported in `unparseable`, never guessed at — treat a non-empty `unparseable` as a gap in the list, not as zero issues.",
        input_schema: {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Filter by status (Open/Doing/Blocked/Done/Dropped) — optional",
                },
            },
            "additionalProperties": false,
        },
    }
}

function _tool_bais_ready() -> ToolSpec {
    ToolSpec {
        name: "bais_ready",
        description: "List ready BAIS issues (Open where not blocked by Blocks edge via bais ready_issues).",
        input_schema: { "type": "object", "properties": {}, "additionalProperties": false },
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
        description: "Validate every .bais/issues/*.toml via bais BAML parser. Returns {ok, bad, dangling, cycles}: `bad` is per-file parse failures, `dangling` is edge ends naming an id that does not exist — status Missing (this project: a defect, it parks the target issue because an unresolvable blocker blocks) or External (another project's id, not resolvable from here) — `cycles` is ids in a Blocks/DependsOn dependency cycle (or downstream of one), which ready_issues reports only as silence.",
        input_schema: { "type": "object", "properties": {}, "additionalProperties": false },
    }
}

function _tool_bais_graph() -> ToolSpec {
    ToolSpec {
        name: "bais_graph",
        description: "Graph traversal from a BAIS issue via Blocks/DependsOn/etc edges (BFS).",
        input_schema: {
            "type": "object",
            "properties": { "from": { "type": "string", "description": "Starting issue id e.g. bi#04" } },
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
