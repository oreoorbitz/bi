// Bucket A, Stage 1: a single provider-agnostic "send a turn" surface.
//
// pi/packages/ai's api/*.ts files are generic wire-format adapters — they
// take an arbitrary, TS-owned conversation history and toolset and send it
// to whichever provider, they don't own a fixed prompt template. So instead
// of the usual `function { client: prompt: tools: }` sugar (built for a
// fixed template + typed args), this calls the lower-level `ai.Client`
// interface directly.
//
// Five toolchain limitations discovered by direct testing (installed
// baml-bridge 0.17.0) shaped this file — all worth re-checking against a
// later toolchain release. 1, 4, and 5 are the same underlying pattern: a BAML
// value that carries an opaque heap handle (a client, a tool's closure, or
// a TurnStream's cursor/text state) must be built AND consumed inside a
// single BAML call — round-tripping it out to the TS host and back in as an
// argument breaks it.
//
// 1. A client value built by a BAML function, returned to TS, and passed
//    into a second BAML call whose parameter is typed as the `ai.Client`
//    interface fails at the FFI boundary with `baml.errors.TypeMismatch:
//    host value type anthropic.AnthropicClient is not assignable to
//    declared type ai.Client` — a round-tripped host value's recorded
//    concrete type doesn't carry its interface-implementation info through
//    the boundary the way an in-VM value does. Fix: build_client /
//    build_streaming_client construct AND SendTurn/StreamTurn consume the
//    client in the same call.
//
// 2. `provider` is a plain string, not a BAML `enum`. The installed
//    baml-bridge TS package (`proto.js::setInboundValue`) has no encode-side
//    handling for a BAML enum passed as a function ARGUMENT from the host —
//    only the decode side (an enum value coming back) is implemented. A
//    plain JS string enum member gets sent as `stringValue` on the wire,
//    and the VM rejects it with `VM internal error: type error: expected
//    variant, got string`. A validated string tag sidesteps this and keeps
//    the same "one function, not one per provider" shape.
//
// 3. A thrown error only decodes back to TS cleanly when it satisfies its
//    function's declared throws-union via a CONCRETE class arm. Verified
//    directly: `baml.errors.InvalidArgument` (concrete) decodes fine as a
//    real `BamlInvalidArgumentError`; `ai.errors.NetworkFailure` (which only
//    satisfies the union via the `ai.errors.Failure` INTERFACE arm) fails to
//    decode at all, with `baml.errors.TypeMismatch: Value of type 'instance'
//    does not match any member of union [...]`. Since ai.errors.Failure /
//    RetrySafety is the actual mechanism pi's retry logic needs, SendTurn /
//    StreamTurn catch it internally and return a concrete `TurnFailure`
//    value instead of letting it propagate as an exception — a returned
//    union member decodes fine; a thrown interface-satisfying value doesn't.
//
// 4. `ai.tools.Tool` (built via `ai.tools.raw_tool`, which carries a
//    closure) fails the same way as (1) when built in one call and passed
//    into another: `baml.errors.TypeMismatch: Missing field raw_handler in
//    external Instance for class ai.tools.Tool`. Fix: SendTurn/StreamTurn
//    take plain-data `ToolSpec[]` (name/description/JSON schema only, no
//    handler) and build the actual `ai.tools.Tool[]` internally — the
//    handler is a stub either way (see ToolSpec's doc comment), so nothing
//    is lost by not exposing `ai.tools.Tool` itself to the host.
//
// 5. `ai.stream.TurnStream` instance mutation does not survive a host
//    round-trip: `CreateScriptedStream(["a","b"])` returned to the host and
//    driven via `stream.next_async()` returns `"a"` twice—the VM's `_cursor`
//    increment from the first `next()` is lost because the host's handle is a
//    snapshot. In-VM `s.next(); s.next()` works. Fix: keep TurnStream inside
//    the VM (in a closure) and expose incremental via the `BamlStream`-tagged
//    `ai.stream.Stream<string,string>` (see `CreateTypedStream` /
//    `StartIncrementalStream`), whose handle re-enters the closure in the VM
//    where mutations persist.
//
// Conversation history lives entirely in `history` (ai.events.Event[],
// built on the TS side from pi's own message log); `text` is only the new
// user turn being added on top of it.

// Concrete (non-interface) stand-in for a caught `ai.errors.Failure`, so it
// can cross the FFI boundary as a returned value. `kind` mirrors the
// ai.errors.* variant name; `retry_safe` mirrors retry_safety() == Safe.
class TurnFailure {
    kind: string,
    message: string,
    retry_safe: bool,
}

function classify_failure(e: ai.errors.Failure) -> TurnFailure {
    // `retry_safety` is part of ai.errors.Failure's own declared surface, so
    // virtual dispatch on the un-narrowed interface value works fine here —
    // unlike `.to_string()` below, which comes from a DIFFERENT interface
    // (baml.ToString) that Failure doesn't require, and which the VM cannot
    // virtually dispatch through an ai.errors.Failure-typed value (verified
    // directly: "VM internal error: virtual call could not resolve
    // interface method `to_string`"). Each match arm below calls
    // `.to_string()` on its narrowed CONCRETE binding instead, which works.
    let retry_safe = e.retry_safety() == ai.errors.RetrySafety.Safe;
    match (e) {
        let r: ai.errors.RateLimited => {
            TurnFailure { kind: "rate_limited", message: r.to_string(), retry_safe: retry_safe }
        },
        let n: ai.errors.NetworkFailure => {
            TurnFailure { kind: "network", message: n.to_string(), retry_safe: retry_safe }
        },
        let i: ai.errors.InvalidRequest => {
            TurnFailure { kind: "invalid_request", message: i.to_string(), retry_safe: retry_safe }
        },
        let f: ai.errors.Refused => {
            TurnFailure { kind: "refused", message: f.to_string(), retry_safe: retry_safe }
        },
        let p: ai.errors.ParseFailed => {
            TurnFailure { kind: "parse_failed", message: p.to_string(), retry_safe: retry_safe }
        },
        let s: ai.errors.StepBudgetExceeded => {
            TurnFailure {
                kind: "step_budget_exceeded",
                message: s.to_string(),
                retry_safe: retry_safe,
            }
        },
        let t: ai.errors.ToolFailedError => {
            TurnFailure { kind: "tool_failed", message: t.to_string(), retry_safe: retry_safe }
        },
        let u: ai.errors.StreamingUnsupported => {
            TurnFailure {
                kind: "streaming_unsupported",
                message: u.to_string(),
                retry_safe: retry_safe,
            }
        },
        _ => TurnFailure { kind: "other", message: "unclassified failure", retry_safe: retry_safe },
    }
}

// Provider-neutral spec: only used for its compiled prompt template +
// output type, never called directly. The declared client here is a
// nominal default only — the real client is constructed separately in
// `build_client` below.
function TurnPrompt(text: string) -> string {
    client: "anthropic/claude-haiku-4-5"
    prompt: `${role("user")}${text}`
}

// Plain-data tool definition — see limitation 4 above for why this, and not
// `ai.tools.Tool`, is what crosses the FFI boundary.
class ToolSpec {
    name: string,
    description: string,
    input_schema: map<string, unknown>,
}

// The handler is never invoked: SendTurn/StreamTurn call `invoke`/
// `invoke_stream` directly rather than `ai.Agent.run`, so BAML never
// executes a tool itself — tool dispatch stays in the TS host
// (pi/packages/agent), which is out of scope for this package.
function build_tool(spec: ToolSpec) -> ai.tools.Tool {
    ai.tools.raw_tool(name = spec.name, description = spec.description, input_schema = spec.input_schema, handler = (
        args: map<string, unknown>,
    ) -> {
        throw baml.errors.NotImplemented {
                message: "tool execution happens in the TS host (pi/packages/agent), not in bi's BAML layer",
            }
    })
}

function build_toolbox(specs: ToolSpec[]) -> ai.tools.Toolbox {
    ai.tools.Toolbox.new(
        specs.map((spec) -> {
            build_tool(spec)
        }),
    )
}

function build_client(
    provider: string,
    model: string,
    api_key: string?,
    base_url: string?,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.Client {
    match (provider) {
        "anthropic" => {
            anthropic.AnthropicClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
                thinking = thinking,
            )
        },
        "openai_responses" => {
            openai.ResponsesClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
            )
        },
        "google" => {
            google.GoogleClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
            )
        },
        let other => throw baml.errors.InvalidArgument { message: `unknown provider: ${other}` },
    }
}

function build_streaming_client(
    provider: string,
    model: string,
    api_key: string?,
    base_url: string?,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.stream.StreamingClient {
    match (provider) {
        "anthropic" => {
            anthropic.AnthropicClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
                thinking = thinking,
            )
        },
        "openai_responses" => {
            openai.ResponsesClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
            )
        },
        "google" => {
            google.GoogleClient.new(
                model = model,
                api_key = api_key,
                base_url = base_url,
                temperature = temperature,
            )
        },
        let other => throw baml.errors.InvalidArgument { message: `unknown provider: ${other}` },
    }
}

function SendTurn(
    provider: string,
    model: string,
    api_key: string?,
    text: string,
    history: ai.events.Event[],
    tools: ToolSpec[],
    base_url: string? = null,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.ModelTurn | TurnFailure {
    let cl = build_client(provider, model, api_key, base_url, temperature = temperature, thinking = thinking);
    let spec = TurnPrompt@spec(text);
    cl.invoke(
        ai.ModelTurnInput {
            prompt: spec.prompt_template,
            journal: ai.Journal { log: history },
            toolbox: build_toolbox(tools),
            output_type: spec.output_type(),
        },
    ) catch (e) {
        let f: ai.errors.Failure => classify_failure(f),
    }
}

// Incremental streaming: returns the live TurnStream handle so the TS host
// can drive `stream.next()` / `stream.final_turn()` incrementally.
// This is the FFI live-handle probe for Stage 2 (see Seam B). A TurnStream
// carries an SseStream handle; each `.next()` is one FFI round-trip that
// could hit the same interface-decode gap as limitations 1/4. Verified
// here via closed-port probe (Seam B red → green).
function StartTurnStream(
    provider: string,
    model: string,
    api_key: string?,
    text: string,
    history: ai.events.Event[],
    tools: ToolSpec[],
    base_url: string? = null,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.stream.TurnStream | TurnFailure {
    let cl = build_streaming_client(provider, model, api_key, base_url, temperature = temperature, thinking = thinking);
    let spec = TurnPrompt@spec(text);
    cl.invoke_stream(
        ai.ModelTurnInput {
            prompt: spec.prompt_template,
            journal: ai.Journal { log: history },
            toolbox: build_toolbox(tools),
            output_type: spec.output_type(),
        },
    ) catch (e) {
        let f: ai.errors.Failure => classify_failure(f),
    }
}

// Scripted TurnStream for testing the live-handle FFI without network.
// Each string in `chunks` becomes one delta; final_turn() accumulates them.
// Direct handle return — demonstrates the FFI handle round-trip gap (see
// proposal 09): second `next()` on the host returns stale data because VM
// mutations don't sync back to the host's handle copy.
function CreateScriptedStream(chunks: string[]) -> ai.stream.TurnStream {
    ai.stream.TurnStream.from_chunks(chunks)
}

// Typed host stream (BamlStream) wrapper for scripted deltas — the host-
// facing streaming primitive that IS designed for FFI round-trips. We build
// an ai.stream.Stream<string, string> whose _next_text closure pulls from a
// TurnStream held in the closure's environment. This is the incremental
// primitive that survives FFI (BamlStream handle), unlike raw TurnStream.
function CreateTypedStream(chunks: string[]) -> ai.stream.Stream<string, string> {
    let turns = ai.stream.TurnStream.from_chunks(chunks);
    ai.stream.Stream<string, string> {
        _next_text: () -> {
            match (turns.next()) {
                let d: ai.stream.Done => null,
                let s: string => s,
            } catch_all (e) {
                _ => throw baml.errors.UnknownError { data: e, message: [e.to_string()] }
            }
        },
        _cache: baml.sap.__new_parse_cache<string, string>(),
        _text: "",
        _finished: false,
    }
}

// Incremental streaming via BamlStream — the working primitive. The TurnStream
// stays in the closure's environment inside the VM, so its mutations persist
// across host nextAsync() calls (no handle round-trip). Closed-port probe
// returns TurnFailure at create time; a successful stream yields partials.
function StartIncrementalStream(
    provider: string,
    model: string,
    api_key: string?,
    text: string,
    history: ai.events.Event[],
    tools: ToolSpec[],
    base_url: string? = null,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.stream.Stream<string, string> | TurnFailure {
    let cl = build_streaming_client(provider, model, api_key, base_url, temperature = temperature, thinking = thinking);
    let spec = TurnPrompt@spec(text);
    let turns = cl.invoke_stream(
        ai.ModelTurnInput {
            prompt: spec.prompt_template,
            journal: ai.Journal { log: history },
            toolbox: build_toolbox(tools),
            output_type: spec.output_type(),
        },
    ) catch (e) {
        let f: ai.errors.Failure => {
            return classify_failure(f);
        },
    };
    ai.stream.Stream<string, string> {
        _next_text: () -> {
            match (turns.next()) {
                let d: ai.stream.Done => null,
                let s: string => s,
            } catch_all (e) {
                _ => throw baml.errors.UnknownError { data: e, message: [e.to_string()] }
            }
        },
        _cache: baml.sap.__new_parse_cache<string, string>(),
        _text: "",
        _finished: false,
    }
}

// Helper to create a Media block from base64 inside the VM — host Image
// handles created via BamlImage.fromBase64 lack JSON envelope for
// ai.content.Media.new (see conversation.ts). This runs in-VM where
// baml.media.Image.from_base64 -> image primitive -> Media envelope works.
function CreateMediaBlock(base64: string, mime_type: string) -> ai.content.Media {
    let img = baml.media.Image.from_base64(base64, mime_type);
    ai.content.Media.new(img)
}

function CreateMediaBlockFromUrl(url: string, mime_type: string?) -> ai.content.Media {
    let img = baml.media.Image.from_url(url, mime_type);
    ai.content.Media.new(img)
}

// Media history helper — keeps the Media block inside one BAML call so the
// ai.MediaPart union does not need to round-trip via the host (same pattern
// as client/tool handle gaps). Host passes base64, VM builds the
// AssistantMessage with Media block and invokes the model.
function SendTurnWithImage(
    provider: string,
    model: string,
    api_key: string?,
    text: string,
    image_base64: string,
    image_mime: string,
    client_id: string = "test-client",
    base_url: string? = null,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.ModelTurn | TurnFailure {
    let media = CreateMediaBlock(image_base64, image_mime);
    let history: ai.events.Event[] = [ai.events.AssistantMessage { content: [media], client_id: client_id }];
    let cl = build_client(provider, model, api_key, base_url, temperature = temperature, thinking = thinking);
    let spec = TurnPrompt@spec(text);
    cl.invoke(
        ai.ModelTurnInput {
            prompt: spec.prompt_template,
            journal: ai.Journal { log: history },
            toolbox: build_toolbox([]),
            output_type: spec.output_type(),
        },
    ) catch (e) {
        let f: ai.errors.Failure => classify_failure(f),
    }
}

// Stage 1 drained helper — still useful, but now StartTurnStream is the
// incremental primitive. StreamTurn drains internally via final_turn().
function StreamTurn(
    provider: string,
    model: string,
    api_key: string?,
    text: string,
    history: ai.events.Event[],
    tools: ToolSpec[],
    base_url: string? = null,
    temperature: float? = null,
    thinking: anthropic.ThinkingConfig? = null,
) -> ai.ModelTurn | TurnFailure {
    let cl = build_streaming_client(provider, model, api_key, base_url, temperature = temperature, thinking = thinking);
    let spec = TurnPrompt@spec(text);
    cl
        .invoke_stream(
            ai.ModelTurnInput {
                prompt: spec.prompt_template,
                journal: ai.Journal { log: history },
                toolbox: build_toolbox(tools),
                output_type: spec.output_type(),
            },
        )
        .final_turn() catch (e) {
        let f: ai.errors.Failure => classify_failure(f),
    }
}
