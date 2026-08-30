// Minimal agent loop helpers — BAML side provides ModelTurn factories for
// testing the TS host agent loop without network. The loop itself stays in
// TS host per limitation 4 (tool dispatch in pi/packages/agent).

function CreateTextTurn(text: string) -> ai.ModelTurn {
    ai.ModelTurn {
        content: [ai.content.Text { text: text }],
        stop_reason: ai.content.StopReason.Complete,
        usage: null,
    }
}

function CreateToolUseTurn(
    tool_name: string,
    tool_id: string,
    args: map<string, unknown>,
) -> ai.ModelTurn {
    ai.ModelTurn {
        content: [ai.content.ToolUse { id: tool_id, name: tool_name, args: args }],
        stop_reason: ai.content.StopReason.ToolUse,
        usage: null,
    }
}

function CreateMixedTurn(
    text: string,
    tool_name: string,
    tool_id: string,
    args: map<string, unknown>,
) -> ai.ModelTurn {
    ai.ModelTurn {
        content: [
            ai.content.Text { text: text },
            ai.content.ToolUse { id: tool_id, name: tool_name, args: args },
        ],
        stop_reason: ai.content.StopReason.ToolUse,
        usage: null,
    }
}
