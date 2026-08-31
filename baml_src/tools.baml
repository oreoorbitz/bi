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

function _tool_bais_list() -> ToolSpec {
    ToolSpec {
        name: "bais_list",
        description: "List BAIS issues from .bais/issues/*.toml (BAML-validated via bais parser).",
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
        description: "Create a new BAIS issue .bais/issues/<id>.toml (BAML-serialized via bais parser).",
        input_schema: {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Issue title" },
                "kind": {
                    "type": "string",
                    "description": "Kind: Bug/Feat/Proposal/Debt/Flake/Spike (default Feat)",
                },
                "area": { "type": "string", "description": "Area e.g. cli/bi, bridge/ffi (optional)" },
                "body": { "type": "string", "description": "Markdown body (optional)" },
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
        description: "Validate every .bais/issues/*.toml via bais BAML parser (reports ok/bad).",
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
