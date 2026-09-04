// bi-coding-agent Phase 2 — session header + trust, ported from
// pi/packages/coding-agent/src/core/session-manager.ts (1716 lines, pi 0.84.3)
// + pi/core/project-trust.ts (96 lines) + pi/config.ts APP_NAME.
// Vendor specs: bi/vendor/pi-session-manager.ts, pi-project-trust.ts, pi-config.ts.
// Namespace pi -> bi: .pi -> .bi, APP_NAME pi -> bi, trust prompts use bi.
// Pure header/validation logic lives in BAML (no FS), maximal static analysis.

function current_session_version() -> int {
    3
}

// Session header — mirrors pi's SessionHeader (type session, version, id, timestamp, cwd, parentSession?)
class SessionHeader {
    type: string, // always "session"
    version: int,
    id: string,
    timestamp: string,
    cwd: string,
    parent_session: string?,
}

class NewSessionOptions {
    id: string?,
    parent_session: string?,
}

// Validation — same regex as pi: ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$
function is_valid_session_id_char(c: string) -> bool {
    c.is_ascii_alphanumeric() || c == "-" || c == "_" || c == "."
}

function is_valid_session_id(id: string) -> bool {
    if (id.length() == 0) {
        false
    } else {
        let first = id.slice(0, 1);
        let last = id.slice(id.length() - 1, id.length());
        if (!first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric()) {
            false
        } else {
            let ok = true;
            for (let ch in id.chars()) {
                if (!is_valid_session_id_char(ch)) {
                    ok = false;
                    break;
                }
            }
            ok
        }
    }
}

function validate_session_id(id: string) -> void throws baml.errors.InvalidArgument {
    if (!is_valid_session_id(id)) {
        throw baml.errors.InvalidArgument {
            message: "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
        }
    }
}

// Header creation — BAML owns the header shape, host owns FS/timestamp.
// Timestamp is passed in as string (host generates ISO-8601), cwd as string.
function create_session_header(
    id: string,
    cwd: string,
    timestamp: string,
    parent_session: string? = null,
) -> SessionHeader throws baml.errors.InvalidArgument {
    validate_session_id(id);
    if (cwd.length() == 0) {
        throw baml.errors.InvalidArgument { message: "cwd must be non-empty" }
    }
    if (timestamp.length() == 0) {
        throw baml.errors.InvalidArgument { message: "timestamp must be non-empty" }
    }
    SessionHeader {
        type: "session",
        version: current_session_version(),
        id: id,
        timestamp: timestamp,
        cwd: cwd,
        parent_session: parent_session,
    }
}

// Project trust — mirrors pi/core/project-trust.ts AppMode + helpers.
// BAML owns the enum + prompt formatting; host owns FS/trust store.
enum AppMode {
    Interactive,
    Print,
    Json,
    Rpc,
}

function format_project_trust_prompt(cwd: string) -> string {
    let app = app_name();
    let cfg = config_dir_name();
    "Trust project folder?\n"
        + cwd
        + "\n\nThis allows "
        + app
        + " to load "
        + cfg
        + " settings and resources, install missing project packages, and execute project extensions."
}

function trust_prompt_contains_bi(prompt: string) -> bool {
    prompt.includes("bi") && prompt.includes(".bi")
}

// Transcript persistence (bi#30) — session files are JSONL: one header
// line, then one history line per message. BAML owns the entry schema +
// validation + all shaped text; the host owns JSON encode/decode + FS.
// A resumed entry replays as {role, text}; provider/model/thinking ride
// along as provenance for future cost attribution (bi#52).
class HistoryEntry {
    type: string, // always "history"
    role: string, // "user" | "assistant"
    text: string,
    provider: string?,
    model: string?,
    thinking: string?,
}

function validate_history_entry(role: string, text: string) -> string[] {
    let errors: string[] = [];
    if (role != "user" && role != "assistant") {
        errors.push(`role must be "user" or "assistant", got "${role}"`);
    }
    if (text.length() == 0) {
        errors.push("text must be non-empty");
    }
    errors
}

// One BAML round-trip per resume: host parses JSONL into entries, BAML
// keeps the structurally valid history lines (bad lines dropped, never
// fatal — a corrupt line must not lose the whole session).
function select_valid_history(entries: HistoryEntry[]) -> HistoryEntry[] {
    let out: HistoryEntry[] = [];
    for (let e in entries) {
        if (e.type == "history" && validate_history_entry(e.role, e.text).length() == 0) {
            out.push(e)
        }
    }
    out
}

class ResumeEntry {
    id: string,
    timestamp: string,
    cwd: string,
    turns: int,
}

function format_resume_list(sessions: ResumeEntry[], current_id: string?) -> string {
    if (sessions.length() == 0) {
        "no saved sessions"
    } else {
        let out = "";
        for (let s in sessions) {
            let cur = current_id ?? "";
            let mark = if (cur != "" && cur == s.id) {
                "*"
            } else {
                " "
            };
            let tm = if (s.turns == 1) {
                "1 turn"
            } else {
                `${s.turns} turns`
            };
            out = `${out}  ${mark} ${s.id} — ${tm} — ${s.cwd} — ${s.timestamp}\n`;
        }
        out
    }
}

function format_session_info(
    id: string,
    file: string,
    cwd: string,
    parent_session: string?,
    provider: string,
    model: string,
    thinking: string?,
    turns: int,
    messages: int,
) -> string {
    let parent = match (parent_session) {
        null => "none",
        let p: string => p,
    };
    let th = match (thinking) {
        null => "default",
        let t: string => t,
    };
    `session ${id}\n  file: ${file}\n  cwd: ${cwd}\n  forked from: ${parent}\n  backend: ${provider}/${model} · thinking ${th}\n  turns: ${turns} · messages: ${messages}`
}
