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
// plus bi's display label (/name). Old files read label as null.
class SessionHeader {
    type: string, // always "session"
    version: int,
    id: string,
    timestamp: string,
    cwd: string,
    parent_session: string?,
    label: string?,
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
    label: string? = null,
) -> SessionHeader throws baml.errors.InvalidArgument {
    validate_session_id(id);
    if (cwd.length() == 0) {
        throw baml.errors.InvalidArgument { message: "cwd must be non-empty" }
    }
    if (timestamp.length() == 0) {
        throw baml.errors.InvalidArgument { message: "timestamp must be non-empty" }
    }
    match (label) {
        null => {},
        let l: string => {
            let problems = validate_session_label(l);
            if (problems.length() > 0) {
                throw baml.errors.InvalidArgument { message: problems.at(0) ?? "bad label" }
            }
        },
    }
    SessionHeader {
        type: "session",
        version: current_session_version(),
        id: id,
        timestamp: timestamp,
        cwd: cwd,
        parent_session: parent_session,
        label: label,
    }
}

// /name policy: short human labels for the resume list. The host trims;
// empty and over-long labels fail here instead of persisting junk.
function validate_session_label(label: string) -> string[] {
    if (label.length() == 0) {
        ["label must be non-empty — /name <text>"]
    } else if (label.length() > 80) {
        ["label must be 80 chars or fewer"]
    } else {
        []
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

// Project trust decisions (bi#29): allow persists, deny persists,
// session-only lives in memory. The store maps absolute dirs to
// allow/deny; anything absent is undecided. Headless (no TTY) defaults
// deny — same fail-closed as pi without a UI.
function parse_trust_answer(word: string) -> string? {
    let w = word.trim();
    if (w == "y" || w == "Y" || w == "yes" || w == "YES" || w == "allow" || w == "Allow") {
        "allow"
    } else if (w == "n" || w == "N" || w == "no" || w == "NO" || w == "deny" || w == "Deny") {
        "deny"
    } else if (w == "s" || w == "S" || w == "session" || w == "Session") {
        "session"
    } else {
        null
    }
}

class TrustOption {
    label: string,
    description: string,
    decision: string,
}

// Trust selector rows (slice 6): the TTY modal lists these, the host
// maps the picked `decision` (never the position) onto the same
// allow/session/deny that parse_trust_answer returns. Order: Yes,
// Session only, No; the host preselects the safe middle.
function trust_options() -> TrustOption[] {
    [
        TrustOption {
            label: "Yes",
            description: "always trust, persist the decision",
            decision: "allow",
        },
        TrustOption {
            label: "Session only",
            description: "trust until this session ends",
            decision: "session",
        },
        TrustOption { label: "No", description: "stay untrusted, persist deny", decision: "deny" },
    ]
}

function format_trust_status(cwd: string, decision: string?) -> string {
    match (decision) {
        null => `trust ${cwd}: undecided — /trust allow|deny|session to decide`,
        let d: string => `trust ${cwd}: ${d}`,
    }
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
    label: string?,
}

function format_resume_list(sessions: ResumeEntry[], current_id: string?) -> string {
    if (sessions.length() == 0) {
        "no saved sessions"
    } else {
        let out = "";
        let n = 1;
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
            let name = match (s.label) {
                null => "",
                let l: string => ` — "${l}"`,
            };
            out = `${out}  ${mark} ${n} ${s.id}${name} — ${tm} — ${s.cwd} — ${s.timestamp}\n`;
            n = n + 1
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
    label: string? = null,
) -> string {
    let parent = match (parent_session) {
        null => "none",
        let p: string => p,
    };
    let th = match (thinking) {
        null => "default",
        let t: string => t,
    };
    let name = match (label) {
        null => "none",
        let l: string => `"${l}"`,
    };
    `session ${id}\n  name: ${name}\n  file: ${file}\n  cwd: ${cwd}\n  forked from: ${parent}\n  backend: ${provider}/${model} · thinking ${th}\n  turns: ${turns} · messages: ${messages}`
}

// /share policy: pi posts HTML to a secret gist (after a Radius attempt
// bi skips — no Radius here). The gist filename comes from the tmp file
// basename, so BAML owns the name; the description rides --desc.
function gist_filename(id: string) -> string {
    `bi-session-${id}.md`
}

function gist_description(id: string, label: string?) -> string {
    match (label) {
        null => `bi session ${id}`,
        let l: string => `bi session ${id} — ${l}`,
    }
}

// First-run setup (bi#93, via bi#30) — BAML owns the prompt copy +
// choice schema; the host owns detection (env heuristic), live preview
// (theme_preview), and persistence (~/.bi/settings.json + theme.json).
// bi collects no telemetry, so the analytics answer persists as consent
// state only, shown back by /settings. Esc at any step skips the rest
// and still writes setup_done, so bi never asks twice.
class SetupOption {
    value: string,
    label: string,
    description: string,
}

// Theme choices mirror list_themes; the host preselects the detected
// row, BAML only shapes the copy.
function setup_theme_options() -> SetupOption[] {
    [
        SetupOption {
            value: "default",
            label: "Default",
            description: "dark-background ANSI palette",
        },
        SetupOption { value: "light", label: "Light", description: "light-background ANSI palette" },
        SetupOption { value: "none", label: "None", description: "plain text, no styling" },
    ]
}

function setup_analytics_options() -> SetupOption[] {
    [
        SetupOption {
            value: "share",
            label: "Share anonymous usage data",
            description: "record consent for future telemetry",
        },
        SetupOption {
            value: "keep",
            label: "Don't share",
            description: "record decline, never re-prompt",
        },
    ]
}

function format_first_run_theme_step(detected: string) -> string {
    `Welcome to bi, the minimal coding agent.\n\nPick a theme. Detected system appearance: ${detected}\n(Esc skips setup — bi won't ask again; /settings and /theme to change later)`
}

function format_first_run_analytics_step() -> string {
    "Opt-in to anonymous usage data sharing?\nbi collects no telemetry today — this records consent only, changeable anytime in settings.json."
}

// "y/yes/share" shares; "n/no/keep/don't" declines; anything else is
// null (the caller keeps the safe default — never guess consent).
function parse_analytics_answer(word: string) -> bool? {
    let w = word.trim();
    if (w == "y" || w == "Y" || w == "yes" || w == "YES" || w == "share" || w == "Share") {
        true
    } else if (
        w == "n"
            || w == "N"
            || w == "no"
            || w == "NO"
            || w == "keep"
            || w == "Keep"
            || w == "don't"
            || w == "dont"
    ) {
        false
    } else {
        null
    }
}

function format_first_run_done(theme: string, share_analytics: bool) -> string {
    let a = if (share_analytics) {
        "share anonymous usage data"
    } else {
        "don't share"
    };
    `Setup done — theme ${theme}, analytics: ${a}. (/settings shows these anytime)`
}

function format_setup_skipped() -> string {
    "Setup skipped — defaults kept, bi won't ask again. (/settings and /theme to change later)"
}

// /settings shows the recorded first-run choices next to the backend
// defaults. share null = never answered (bi collects nothing either
// way); done false = the install predates the marker.
function format_setup_status(theme: string, share_analytics: bool?, setup_done: bool) -> string {
    let a = match (share_analytics) {
        null => "(undecided — bi collects no telemetry)",
        let s: bool => {
            if (s) {
                "share"
            } else {
                "don't share"
            }
        },
    };
    let d = if (setup_done) {
        "done"
    } else {
        "pending"
    };
    `theme = ${theme}\nshare_analytics = ${a}\nsetup = ${d}\n`
}

// Branch tree (bi#87, via bi#30) — the host walks parent_session links
// into display order (roots first, children by timestamp, orphans as
// roots, cycle-safe) and BAML renders the gutters + rows. /tree stays
// the directory browser; this list is the session-branch switcher.
class BranchEntry {
    id: string,
    timestamp: string,
    cwd: string,
    turns: int,
    label: string?,
    parent: string?,
}

// One gutter cell per ancestor level below the root (empty for roots
// and their children): true draws the continuing │, false draws blank
// space. Each cell says whether that ancestor has a following sibling.
// The connector names the node's own sibling position.
function branch_row_prefix(depth: int, is_last: bool, guides: bool[]) -> string {
    let out = "";
    for (let g in guides) {
        if (g) {
            out = `${out}│  `
        } else {
            out = `${out}   `
        }
    }
    if (depth > 0) {
        if (is_last) {
            out = `${out}└─ `
        } else {
            out = `${out}├─ `
        }
    }
    out
}

function format_branch_row(
    id: string,
    label: string?,
    turns: int,
    current: bool,
    prefix: string,
) -> string {
    let mark = if (current) {
        "*"
    } else {
        " "
    };
    let tm = if (turns == 1) {
        "1 turn"
    } else {
        `${turns} turns`
    };
    let name = match (label) {
        null => "",
        let l: string => ` — "${l}"`,
    };
    `${mark} ${prefix}${id}${name} — ${tm}`
}

function format_branches_list(rows: string[]) -> string {
    if (rows.length() == 0) {
        "no saved sessions — /fork or /clone to grow branches"
    } else {
        let out = "";
        for (let r in rows) {
            out = `${out}${r}\n`
        }
        out
    }
}

// Branch summary (bi#88, via bi#30) — the transcript block after a
// fork, clone, or branch switch. Names where from, what was kept, and
// the new id; the host prints it right after its one-line notice.
function format_branch_summary(
    verb: string,
    from_id: string,
    kept_messages: int,
    new_id: string,
) -> string {
    let what = if (kept_messages == 1) {
        "1 message"
    } else {
        `${kept_messages} messages`
    };
    `[branch] ${verb} ${from_id} → ${new_id} — ${what} kept`
}

// Fork message picker (bi#86) — pi's user-message-selector rows ported
// to BAML. The host passes the session's user-message texts oldest-first
// and keeps the same array: the leading number is the `/fork <n>` pick
// (bi#68 contract — numbers agree with the listed rows). Multi-line
// texts flatten to one line; overlong rows truncate with an ellipsis.
// Esc keeps today's transcript (the host never forks on cancel).
function format_fork_row(index: int, total: int, text: string) -> string {
    let one_line = text.split("\n")
        .map((l) -> {
            l.trim()
        })
        .filter((l) -> {
            l.length() > 0
        })
        .join(" ")
        .trim();
    let short = if (one_line.length() > 80) {
        `${one_line.slice(0, 79)}…`
    } else {
        one_line
    };
    `  ${index} Message ${index} of ${total} — ${short}`
}

function format_fork_list(texts: string[]) -> string {
    if (texts.length() == 0) {
        "no messages to fork from"
    } else {
        let out = "";
        let n = 1;
        for (let m in texts) {
            out = `${out}${format_fork_row(n, texts.length(), m)}\n`;
            n = n + 1
        }
        out
    }
}

// /export body: whole transcript as one markdown doc.
function format_session_markdown(
    id: string,
    label: string?,
    timestamp: string,
    cwd: string,
    entries: HistoryEntry[],
) -> string {
    let title = match (label) {
        null => `# Session ${id}`,
        let l: string => `# ${l} (${id})`,
    };
    let out = `${title}\n\n_${timestamp} · ${cwd}_\n`;
    for (let e in entries) {
        let who = if (e.role == "user") {
            "user"
        } else {
            "assistant"
        };
        out = `${out}\n## ${who}\n\n${e.text}\n`
    }
    out
}
