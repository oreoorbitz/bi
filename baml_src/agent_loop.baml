// bi/baml_src/agent_loop.baml — minimal agent-loop state, ported from pi/packages/agent
// vendor specs: bi/vendor/pi-agent-loop.ts (796), packages/agent/src/types.ts
// BAML owns pure loop state + Event types; host owns streamFn/ai.Client and tool execution.
// Mirrors pi's AgentLoopConfig/AgentContext/loop validation, but as BAML types for static analysis.

enum LoopState {
    Idle,
    Thinking,
    ToolUse,
    Waiting,
    Done,
}

enum AgentEventKind {
    TurnStart,
    TurnEnd,
    ToolCall,
    ToolResult,
    Error,
}

class AgentEvent {
    kind: AgentEventKind,
    turn: int,
    tool_name: string?,
    message: string,
}

class LoopContext {
    messages: string[],
    turn: int,
    state: LoopState,
    max_turns: int,
    loop_id: string,
}

function loop_context_new(max_turns: int, loop_id: string) -> LoopContext {
    LoopContext {
        messages: [],
        turn: 0,
        state: LoopState.Idle,
        max_turns: max_turns,
        loop_id: loop_id,
    }
}

function can_continue(context: LoopContext) -> bool {
    context.messages.length() > 0 && context.state != LoopState.Done
}

function last_message_role(context: LoopContext) -> string? {
    if (context.messages.length() == 0) {
        null
    } else {
        // pi's rule: cannot continue from assistant; we store last message role as prefix
        // For BAML test, last message string starting with "assistant:" means role assistant
        let last = context.messages[context.messages.length() - 1];
        if (last.starts_with("assistant:")) {
            "assistant"
        } else if (last.starts_with("user:")) {
            "user"
        } else if (last.starts_with("tool_result:")) {
            "tool_result"
        } else {
            null
        }
    }
}

function validate_continue(context: LoopContext) -> void throws baml.errors.InvalidArgument {
    if (context.messages.length() == 0) {
        throw baml.errors.InvalidArgument { message: "Cannot continue: no messages in context" }
    }
    let role = last_message_role(context);
    if (role == "assistant") {
        throw baml.errors.InvalidArgument { message: "Cannot continue from message role: assistant" }
    }
}

function next_loop_state(current: LoopState, has_tool_use: bool, is_done: bool) -> LoopState {
    if (is_done) {
        LoopState.Done
    } else if (has_tool_use) {
        LoopState.ToolUse
    } else if (current == LoopState.Idle) {
        LoopState.Thinking
    } else {
        LoopState.Waiting
    }
}

function agent_event_new(kind: AgentEventKind, turn: int, message: string) -> AgentEvent {
    AgentEvent { kind: kind, turn: turn, tool_name: null, message: message }
}
