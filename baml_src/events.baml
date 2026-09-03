// bi/baml_src/events.baml — agent event schema for bi#14 run modes.
//
// pi's print/json-event modes ride its AgentSessionEvent bus (streaming
// deltas, usage, partial tool calls). bi has no such bus — runAgent returns
// a complete AgentResult — so bi's event vocabulary is coarser: one event
// per finished turn-piece, dumped single-shot after the run. The wire shape
// stays NDJSON `{"type": ...}` like pi's so consumers can share parsers.
//
// Split: BAML owns the SCHEMA (RunEvent layout, make_* constructors,
// validate_event rules). The TS host owns BYTES (JSON.stringify on stdout).
// Every event the CLI emits is built by a make_* constructor and checked by
// validate_event before printing — BAML is validator, same as everywhere.

class RunEvent {
    type: string @description("run_start | assistant_text | tool_call | tool_result | run_end | run_failed"),
    turn_index: int?,
    provider: string?,
    model: string?,
    text: string?,
    tool_call_id: string?,
    tool_name: string?,
    tool_args_json: string?,
    tool_output: string?,
    failure_kind: string?,
    failure_message: string?,
}

function make_run_start(provider: string, model: string) -> RunEvent {
    RunEvent {
        type: "run_start",
        turn_index: null,
        provider: provider,
        model: model,
        text: null,
        tool_call_id: null,
        tool_name: null,
        tool_args_json: null,
        tool_output: null,
        failure_kind: null,
        failure_message: null,
    }
}

function make_assistant_text(text: string, turn_index: int) -> RunEvent {
    RunEvent {
        type: "assistant_text",
        turn_index: turn_index,
        provider: null,
        model: null,
        text: text,
        tool_call_id: null,
        tool_name: null,
        tool_args_json: null,
        tool_output: null,
        failure_kind: null,
        failure_message: null,
    }
}

function make_tool_call(tool_call_id: string, tool_name: string, tool_args_json: string, turn_index: int) -> RunEvent {
    RunEvent {
        type: "tool_call",
        turn_index: turn_index,
        provider: null,
        model: null,
        text: null,
        tool_call_id: tool_call_id,
        tool_name: tool_name,
        tool_args_json: tool_args_json,
        tool_output: null,
        failure_kind: null,
        failure_message: null,
    }
}

function make_tool_result(tool_call_id: string, tool_name: string, tool_output: string, turn_index: int) -> RunEvent {
    RunEvent {
        type: "tool_result",
        turn_index: turn_index,
        provider: null,
        model: null,
        text: null,
        tool_call_id: tool_call_id,
        tool_name: tool_name,
        tool_args_json: null,
        tool_output: tool_output,
        failure_kind: null,
        failure_message: null,
    }
}

function make_run_end(final_text: string) -> RunEvent {
    RunEvent {
        type: "run_end",
        turn_index: null,
        provider: null,
        model: null,
        text: final_text,
        tool_call_id: null,
        tool_name: null,
        tool_args_json: null,
        tool_output: null,
        failure_kind: null,
        failure_message: null,
    }
}

function make_run_failed(failure_kind: string, failure_message: string) -> RunEvent {
    RunEvent {
        type: "run_failed",
        turn_index: null,
        provider: null,
        model: null,
        text: null,
        tool_call_id: null,
        tool_name: null,
        tool_args_json: null,
        tool_output: null,
        failure_kind: failure_kind,
        failure_message: failure_message,
    }
}

function event_type(event: RunEvent) -> string {
    event.type
}

// Per-type required-field rules. The host must pass every emitted event
// through here before serializing; unknown types and missing fields fail.
function validate_event(event: RunEvent) -> bool {
    match (event.type) {
        "run_start" => event.provider != null && event.model != null,
        "assistant_text" => event.text != null && event.turn_index != null,
        "tool_call" => event.tool_call_id != null && event.tool_name != null && event.tool_args_json != null && event.turn_index != null,
        "tool_result" => event.tool_call_id != null && event.tool_name != null && event.tool_output != null && event.turn_index != null,
        "run_end" => event.text != null,
        "run_failed" => event.failure_kind != null && event.failure_message != null,
        _ => false,
    }
}
