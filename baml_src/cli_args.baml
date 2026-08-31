// bi-coding-agent Phase 1 — CLI args ported from pi/packages/coding-agent/src/cli/args.ts
// Vendor spec: bi/vendor/pi-cli-args.ts (447 lines, pi 0.84.3). Namespace pi -> bi:
// APP_NAME pi -> bi, CONFIG_DIR_NAME .pi -> .bi, env PI_* -> BI_*.
// This is a pure string[] -> Args parser — maximal static analysis (no LLM).
// BAML owns the arg grammar, TS host (bi/src/cli.ts) will call parse_args and
// dispatch. See bi/.bais/issues/bi#08.toml.

//# bi namespace constants (replaces pi's APP_NAME/CONFIG_DIR_NAME/ENV_*)
function app_name() -> string {
    "bi"
}

function config_dir_name() -> string {
    ".bi"
}

function env_agent_dir() -> string {
    "BI_AGENT_DIR"
}

function env_session_dir() -> string {
    "BI_SESSION_DIR"
}

enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

enum Mode {
    Text,
    Json,
    Rpc,
}

enum TuiMode {
    Regular,
    Fullscreen,
}

class Diagnostic {
    type: string, // "warning" | "error"
    message: string,
}

class Args {
    provider: string?,
    model: string?,
    api_key: string?,
    system_prompt: string?,
    append_system_prompt: string[]?,
    thinking: ThinkingLevel?,
    cont: bool?, // `continue` is keyword in BAML, use cont
    resume: bool?,
    help: bool?,
    version: bool?,
    mode: Mode?,
    name: string?,
    no_session: bool?,
    session: string?,
    session_id: string?,
    fork: string?,
    session_dir: string?,
    models: string[]?,
    tools: string[]?,
    exclude_tools: string[]?,
    no_tools: bool?,
    no_builtin_tools: bool?,
    extensions: string[]?,
    no_extensions: bool?,
    print: bool?,
    export_file: string?, // `export` is keyword, use export_file
    no_skills: bool?,
    skills: string[]?,
    prompt_templates: string[]?,
    no_prompt_templates: bool?,
    themes: string[]?,
    use_theme: string?,
    no_themes: bool?,
    no_context_files: bool?,
    list_models: string?, // "true" sentinel or search string; null = not requested
    offline: bool?,
    tui_mode: TuiMode?,
    verbose: bool?,
    project_trust_override: bool?, // Some(bool) = override, None = no override
    messages: string[],
    file_args: string[],
    unknown_flags: map<string, string>,
    diagnostics: Diagnostic[],
}

function is_valid_thinking_level(level: string) -> bool {
    level == "off"
        || level == "minimal"
        || level == "low"
        || level == "medium"
        || level == "high"
        || level == "xhigh"
        || level == "max"
}

function thinking_level_from_string(level: string) -> ThinkingLevel? {
    if (level == "off") {
        ThinkingLevel.Off
    } else if (level == "minimal") {
        ThinkingLevel.Minimal
    } else if (level == "low") {
        ThinkingLevel.Low
    } else if (level == "medium") {
        ThinkingLevel.Medium
    } else if (level == "high") {
        ThinkingLevel.High
    } else if (level == "xhigh") {
        ThinkingLevel.Xhigh
    } else if (level == "max") {
        ThinkingLevel.Max
    } else {
        null
    }
}

function args_new() -> Args {
    Args {
        provider: null,
        model: null,
        api_key: null,
        system_prompt: null,
        append_system_prompt: null,
        thinking: null,
        cont: null,
        resume: null,
        help: null,
        version: null,
        mode: null,
        name: null,
        no_session: null,
        session: null,
        session_id: null,
        fork: null,
        session_dir: null,
        models: null,
        tools: null,
        exclude_tools: null,
        no_tools: null,
        no_builtin_tools: null,
        extensions: null,
        no_extensions: null,
        print: null,
        export_file: null,
        no_skills: null,
        skills: null,
        prompt_templates: null,
        no_prompt_templates: null,
        themes: null,
        use_theme: null,
        no_themes: null,
        no_context_files: null,
        list_models: null,
        offline: null,
        tui_mode: null,
        verbose: null,
        project_trust_override: null,
        messages: [],
        file_args: [],
        unknown_flags: {},
        diagnostics: [],
    }
}

//# Parse string[] -> Args — line-for-line port of pi's parseArgs, bi namespace.
// One-test→one-impl tracer: each flag has its own test in cli_args_test.baml.
function parse_args(args: string[]) -> Args {
    let result = args_new();
    let i = 0;
    while (i < args.length()) {
        let arg = args[i];
        if (arg == "--") {
            let j = i + 1;
            while (j < args.length()) {
                let rest = args[j];
                if (rest.starts_with("@")) {
                    result.file_args.push(rest.slice(1, rest.length()));
                } else {
                    result.messages.push(rest);
                }
                j = j + 1;
            }
            break;
        } else if (arg == "--help" || arg == "-h") {
            result.help = true;
        } else if (arg == "--version" || arg == "-v") {
            result.version = true;
        } else if (arg == "--mode" && i + 1 < args.length()) {
            let mode = args[i + 1];
            if (mode == "text") {
                result.mode = Mode.Text;
                i = i + 1;
            } else if (mode == "json") {
                result.mode = Mode.Json;
                i = i + 1;
            } else if (mode == "rpc") {
                result.mode = Mode.Rpc;
                i = i + 1;
            }
        } else if (arg == "--continue" || arg == "-c") {
            result.cont = true;
        } else if (arg == "--resume" || arg == "-r") {
            result.resume = true;
        } else if (arg == "--provider" && i + 1 < args.length()) {
            result.provider = args[i + 1];
            i = i + 1;
        } else if (arg == "--model" && i + 1 < args.length()) {
            result.model = args[i + 1];
            i = i + 1;
        } else if (arg == "--api-key" && i + 1 < args.length()) {
            result.api_key = args[i + 1];
            i = i + 1;
        } else if (arg == "--system-prompt" && i + 1 < args.length()) {
            result.system_prompt = args[i + 1];
            i = i + 1;
        } else if (arg == "--append-system-prompt" && i + 1 < args.length()) {
            let cur = result.append_system_prompt ?? [];
            cur.push(args[i + 1]);
            result.append_system_prompt = cur;
            i = i + 1;
        } else if ((arg == "--name" || arg == "-n") && i + 1 < args.length()) {
            if (i + 1 < args.length()) {
                result.name = args[i + 1];
                i = i + 1;
            } else {
                result.diagnostics.push(
                    Diagnostic { type: "error", message: "--name requires a value" },
                );
            }
        } else if (arg == "--no-session") {
            result.no_session = true;
        } else if (arg == "--session" && i + 1 < args.length()) {
            result.session = args[i + 1];
            i = i + 1;
        } else if (arg == "--session-id" && i + 1 < args.length()) {
            result.session_id = args[i + 1];
            i = i + 1;
        } else if (arg == "--fork" && i + 1 < args.length()) {
            result.fork = args[i + 1];
            i = i + 1;
        } else if (arg == "--session-dir" && i + 1 < args.length()) {
            result.session_dir = args[i + 1];
            i = i + 1;
        } else if (arg == "--models" && i + 1 < args.length()) {
            let raw = args[i + 1];
            result.models
                = raw.split(",").map((s) -> {
                    s.trim()
                });
            i = i + 1;
        } else if (arg == "--no-tools" || arg == "-nt") {
            result.no_tools = true;
        } else if (arg == "--no-builtin-tools" || arg == "-nbt") {
            result.no_builtin_tools = true;
        } else if ((arg == "--tools" || arg == "-t") && i + 1 < args.length()) {
            let raw = args[i + 1];
            let parts = raw.split(",")
                .map((s) -> {
                    s.trim()
                })
                .filter((s) -> {
                    s.length() > 0
                });
            result.tools = parts;
            i = i + 1;
        } else if ((arg == "--exclude-tools" || arg == "-xt") && i + 1 < args.length()) {
            let raw = args[i + 1];
            let parts = raw.split(",")
                .map((s) -> {
                    s.trim()
                })
                .filter((s) -> {
                    s.length() > 0
                });
            result.exclude_tools = parts;
            i = i + 1;
        } else if (arg == "--thinking" && i + 1 < args.length()) {
            let level = args[i + 1];
            let tl = thinking_level_from_string(level);
            if (tl != null) {
                result.thinking = tl;
            } else {
                result.diagnostics.push(
                    Diagnostic {
                        type: "warning",
                        message: "Invalid thinking level \""
                            + level
                            + "\". Valid values: off, minimal, low, medium, high, xhigh, max",
                    },
                );
            }
            i = i + 1;
        } else if (arg == "--print" || arg == "-p") {
            result.print = true;
            let nxt_opt = args.at(i + 1);
            let nxt_s2: string = nxt_opt ?? "";
            if (
                nxt_opt != null
                    && !nxt_s2.starts_with("@")
                    && (!nxt_s2.starts_with("-") || nxt_s2.starts_with("---"))
            ) {
                result.messages.push(nxt_s2);
                i = i + 1;
            }
        } else if (arg == "--export" && i + 1 < args.length()) {
            result.export_file = args[i + 1];
            i = i + 1;
        } else if ((arg == "--extension" || arg == "-e") && i + 1 < args.length()) {
            let cur = result.extensions ?? [];
            cur.push(args[i + 1]);
            result.extensions = cur;
            i = i + 1;
        } else if (arg == "--no-extensions" || arg == "-ne") {
            result.no_extensions = true;
        } else if (arg == "--skill" && i + 1 < args.length()) {
            let cur = result.skills ?? [];
            cur.push(args[i + 1]);
            result.skills = cur;
            i = i + 1;
        } else if (arg == "--prompt-template" && i + 1 < args.length()) {
            let cur = result.prompt_templates ?? [];
            cur.push(args[i + 1]);
            result.prompt_templates = cur;
            i = i + 1;
        } else if (arg == "--theme" && i + 1 < args.length()) {
            let cur = result.themes ?? [];
            cur.push(args[i + 1]);
            result.themes = cur;
            i = i + 1;
        } else if (arg == "--use-theme" && i + 1 < args.length()) {
            let nxt = args[i + 1];
            if (nxt.starts_with("-")) {
                result.diagnostics.push(
                    Diagnostic { type: "error", message: "--use-theme requires a theme name" },
                );
            } else {
                result.use_theme = nxt;
                i = i + 1;
            }
        } else if (arg == "--no-skills" || arg == "-ns") {
            result.no_skills = true;
        } else if (arg == "--no-prompt-templates" || arg == "-np") {
            result.no_prompt_templates = true;
        } else if (arg == "--no-themes") {
            result.no_themes = true;
        } else if (arg == "--no-context-files" || arg == "-nc") {
            result.no_context_files = true;
        } else if (arg == "--list-models") {
            if (i + 1 < args.length()) {
                let nxt = args[i + 1];
                if (!nxt.starts_with("-") && !nxt.starts_with("@")) {
                    result.list_models = nxt;
                    i = i + 1;
                } else {
                    result.list_models = "true";
                }
            } else {
                result.list_models = "true";
            }
        } else if (arg == "--tui-mode" && i + 1 < args.length()) {
            let mode = args[i + 1];
            if (mode == "regular") {
                result.tui_mode = TuiMode.Regular;
                i = i + 1;
            } else if (mode == "fullscreen") {
                result.tui_mode = TuiMode.Fullscreen;
                i = i + 1;
            } else if (mode.starts_with("-")) {
                result.diagnostics.push(
                    Diagnostic {
                        type: "error",
                        message: "--tui-mode requires regular or fullscreen",
                    },
                );
            } else {
                result.diagnostics.push(
                    Diagnostic {
                        type: "error",
                        message: "Invalid TUI mode \"" + mode + "\". Valid values: regular, fullscreen",
                    },
                );
                i = i + 1;
            }
        } else if (arg == "--verbose") {
            result.verbose = true;
        } else if (arg == "--approve" || arg == "-a") {
            result.project_trust_override = true;
        } else if (arg == "--no-approve" || arg == "-na") {
            result.project_trust_override = false;
        } else if (arg == "--offline") {
            result.offline = true;
        } else if (arg.starts_with("@")) {
            result.file_args.push(arg.slice(1, arg.length()));
        } else if (arg.starts_with("--")) {
            let eq = arg.index_of("=");
            if (eq != null) {
                let k = arg.slice(2, eq);
                let v = arg.slice(eq + 1, arg.length());
                let _ = result.unknown_flags.set(k, v);
            } else {
                let flag = arg.slice(2, arg.length());
                let nxt = args.at(i + 1);
                let nxt_s: string = nxt ?? "";
                if (nxt != null && !nxt_s.starts_with("-") && !nxt_s.starts_with("@")) {
                    let _ = result.unknown_flags.set(flag, nxt);
                    i = i + 1;
                } else {
                    let _ = result.unknown_flags.set(flag, "true");
                }
            }
        } else if (arg.starts_with("-") && !arg.starts_with("--")) {
            result.diagnostics.push(Diagnostic { type: "error", message: "Unknown option: " + arg });
        } else if (!arg.starts_with("-")) {
            result.messages.push(arg);
        }
        i = i + 1;
    }
    result
}

function normalize_session_name(value: string) -> string? {
    let t = value.trim();
    if (t.length() > 0) {
        t
    } else {
        null
    }
}

//# Help — bi renames pi -> bi (APP_NAME, .pi -> .bi, PI_* -> BI_*)
function format_help() -> string {
    "bi - AI coding assistant with read, bash, edit, write tools\n\n"
        + "Usage:\n  bi [options] [--] [@files...] [messages...]\n\n"
        + "Options:\n"
        + "  --provider <name>              Provider name (default: google)\n"
        + "  --model <pattern>              Model pattern or ID\n"
        + "  --api-key <key>                API key (defaults to env vars)\n"
        + "  --thinking <level>             off, minimal, low, medium, high, xhigh, max\n"
        + "  --mode <mode>                  text, json, or rpc\n"
        + "  --print, -p                    Non-interactive mode\n"
        + "  --continue, -c                 Continue previous session\n"
        + "  --resume, -r                   Select a session to resume\n"
        + "  --session <path|id>            Use specific session\n"
        + "  --fork <path|id>               Fork session\n"
        + "  --no-session                   Don't save session\n"
        + "  --tools, -t <tools>            Comma-separated allowlist\n"
        + "  --exclude-tools, -xt <tools>   Denylist\n"
        + "  --no-tools, -nt                Disable all tools\n"
        + "  --list-models [search]         List models\n"
        + "  --tui-mode <mode>              regular or fullscreen\n"
        + "  --verbose                      Force verbose startup\n"
        + "  --offline                      Disable network\n"
        + "  --help, -h                     Show help\n"
        + "  --version, -v                  Show version\n"
}
