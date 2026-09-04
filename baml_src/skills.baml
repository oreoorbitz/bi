// Skills + slash commands — ported from pi (coding-agent core skills.ts +
// slash-commands.ts), reduced to the smallest BAML surface.
//
// Split: BAML owns the REGISTRY rules — name/description validation per the
// Agent Skills spec, prompt formatting (XML per agentskills.io), slash lookup.
// The host owns DISCOVERY (SKILL.md scan, frontmatter parse) and EXECUTION
// (slash dispatch in cli.ts). Divergence from pi, documented: no .gitignore
// honoring (host skips dotfiles/node_modules only — no `ignore` dep), and
// bi's builtin slash set is the intersection of pi's 23 with what bi's loop
// implements (help/compact/reload/quit).

class Skill {
    name: string,
    description: string,
    file_path: string,
    disable_model_invocation: bool,
}

class BuiltinSlashCommand {
    name: string,
    description: string,
    argument_hint: string?,
    // Wiring policy (bi#31): null = live in the REPL today; otherwise the
    // owning issue that will wire it (bi#28 selectors, bi#29 settings,
    // bi#30 sessions, bi#32 input chrome). The host prints the scope
    // instead of failing silent or claiming the command works.
    scope: string?,
}

// pi's Agent Skills name rules exactly: <=64 chars, lowercase a-z/0-9/hyphens,
// no leading/trailing hyphen, no consecutive hyphens.
function validate_skill_name(name: string) -> string[] {
    let errors: string[] = [];
    if (name.length() > 64) {
        errors.push(`name exceeds 64 characters (${name.length()})`);
    }
    let ok = true;
    for (let ch in name.chars()) {
        if (!ch.is_ascii_alphanumeric() && ch != "-") {
            ok = false;
        }
        if (ch >= "A" && ch <= "Z") {
            ok = false;
        }
    }
    if (!ok) {
        errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
    }
    if (name.length() > 0) {
        let first = name.chars().at(0);
        let last = name.chars().at(name.length() - 1);
        if (first == "-" || last == "-") {
            errors.push("name must not start or end with a hyphen");
        }
    }
    let prev_hyphen = false;
    let doubled = false;
    for (let ch in name.chars()) {
        if (ch == "-" && prev_hyphen) {
            doubled = true;
        }
        prev_hyphen = ch == "-";
    }
    if (doubled) {
        errors.push("name must not contain consecutive hyphens");
    }
    errors
}

function validate_skill_description(description: string) -> string[] {
    if (description.length() == 0) {
        ["description is required"]
    } else if (description.length() > 1024) {
        [`description exceeds 1024 characters (${description.length()})`]
    } else {
        []
    }
}

// XML prompt format per agentskills.io; disable-model-invocation skills stay
// out (explicit /slash only). Empty registry formats to "" (no section).
function format_skills_for_prompt(skills: Skill[]) -> string {
    let out = "";
    for (let s in skills) {
        if (!s.disable_model_invocation) {
            out = `${out}<skill name="${s.name}">\n${s.description}\n</skill>\n`;
        }
    }
    if (out == "") {
        ""
    } else {
        `<available_skills>\n${out}</available_skills>`
    }
}

// Full registry (bi#31): pi's 23 builtins transcribed verbatim
// (pi/packages/coding-agent/src/core/slash-commands.ts) plus bi's
// /help. scope null = live; otherwise the issue that wires it.
function builtin_slash_commands() -> BuiltinSlashCommand[] {
    [
        BuiltinSlashCommand {
            name: "help",
            description: "List slash commands and skills",
            argument_hint: null,
            scope: null,
        },
        BuiltinSlashCommand {
            name: "settings",
            description: "Open settings menu",
            argument_hint: null,
            scope: "bi#29",
        },
        BuiltinSlashCommand {
            name: "model",
            description: "Select model (opens selector UI)",
            argument_hint: "<provider/model>",
            scope: "bi#28",
        },
        BuiltinSlashCommand {
            name: "tree",
            description: "Navigate session tree (switch branches)",
            argument_hint: null,
            scope: "bi#32",
        },
        BuiltinSlashCommand {
            name: "thinking",
            description: "Set thinking level",
            argument_hint: "<level>",
            scope: "bi#28",
        },
        BuiltinSlashCommand {
            name: "scoped-models",
            description: "Enable/disable models for Ctrl+P cycling",
            argument_hint: null,
            scope: "bi#28",
        },
        BuiltinSlashCommand {
            name: "export",
            description: "Export session (HTML default, or specify path: .html/.jsonl)",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "import",
            description: "Import and resume a session from a JSONL file",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "share",
            description: "Share session as a secret GitHub gist",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "copy",
            description: "Copy last agent message to clipboard",
            argument_hint: null,
            scope: "bi#32",
        },
        BuiltinSlashCommand {
            name: "name",
            description: "Set session display name",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "session",
            description: "Show session info and stats",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "changelog",
            description: "Show changelog entries",
            argument_hint: null,
            scope: "bi#31",
        },
        BuiltinSlashCommand {
            name: "hotkeys",
            description: "Show all keyboard shortcuts",
            argument_hint: null,
            scope: null,
        },
        BuiltinSlashCommand {
            name: "fork",
            description: "Create a new fork from a previous user message",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "clone",
            description: "Duplicate the current session at the current position",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "trust",
            description: "Save project trust decision for future sessions",
            argument_hint: null,
            scope: "bi#29",
        },
        BuiltinSlashCommand {
            name: "login",
            description: "Configure provider authentication",
            argument_hint: "<provider>",
            scope: null,
        },
        BuiltinSlashCommand {
            name: "logout",
            description: "Remove provider authentication",
            argument_hint: null,
            scope: null,
        },
        BuiltinSlashCommand {
            name: "new",
            description: "Start a new session",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "compact",
            description: "Manually compact the session context",
            argument_hint: null,
            scope: null,
        },
        BuiltinSlashCommand {
            name: "resume",
            description: "Resume a different session",
            argument_hint: null,
            scope: "bi#30",
        },
        BuiltinSlashCommand {
            name: "reload",
            description: "Reload keybindings, extensions, skills, prompts, themes, and context files",
            argument_hint: null,
            scope: null,
        },
        BuiltinSlashCommand {
            name: "quit",
            description: "Quit bi",
            argument_hint: null,
            scope: null,
        },
    ]
}

// /hotkeys body: what bi's line-based readline REPL actually supports
// (not pi's widget keybindings — those land with bi#32). Host prints.
function hotkeys_text() -> string {
    "/              Slash commands (this list: /help)\n↑ / ↓         Browse input history\nEnter          Send message\n\\ (trailing)   Continue input onto the next line\nCtrl-C          Abort the running turn (transcript survives)\nCtrl-D          Quit (when input is empty)"
}

// Dispatch lookup: builtins first, then skill names ("/<name>"). Returns the
// slash name without "/" when registered, null when unknown.
function lookup_slash(word: string, skills: Skill[]) -> string? {
    let name = word;
    if (name.length() > 0 && name.chars().at(0) == "/") {
        name = name.slice(1, name.length());
    }
    let found: string? = null;
    for (let b in builtin_slash_commands()) {
        if (b.name == name) {
            found = name;
        }
    }
    for (let s in skills) {
        if (s.name == name) {
            found = name;
        }
    }
    found
}

test "valid names pass, pi rules reject" {
    assert.equal(validate_skill_name("my-skill").length(), 0);
    assert.equal(validate_skill_name("a1").length(), 0);
    assert.equal(validate_skill_name("My-Skill").length(), 1);
    assert.equal(validate_skill_name("-lead").length(), 1);
    assert.equal(validate_skill_name("trail-").length(), 1);
    assert.equal(validate_skill_name("dou--ble").length(), 1);
    assert.equal(validate_skill_name("under_score").length(), 1)
}

test "long names and descriptions rejected" {
    let long_name = "a-really-long-skill-name-that-keeps-going-past-the-limit-xxxxxxxxxxxx";
    assert.equal(validate_skill_name(long_name).length(), 1);
    assert.equal(validate_skill_description("").length(), 1);
    assert.equal(validate_skill_description("fine").length(), 0)
}

test "prompt format is XML, disabled excluded, empty is empty" {
    let skills = [
        Skill {
            name: "review",
            description: "Review code",
            file_path: "r/SKILL.md",
            disable_model_invocation: false,
        },
        Skill {
            name: "secret",
            description: "Hidden",
            file_path: "s/SKILL.md",
            disable_model_invocation: true,
        },
    ];
    let p = format_skills_for_prompt(skills);
    assert.is_true(p.index_of("<available_skills>") != null);
    assert.is_true(p.index_of("<skill name=\"review\">") != null);
    assert.is_true(p.index_of("secret") == null);
    assert.equal(format_skills_for_prompt([]), "")
}

test "slash dispatch finds builtins then skills" {
    let skills = [
        Skill {
            name: "review",
            description: "Review code",
            file_path: "r/SKILL.md",
            disable_model_invocation: false,
        },
    ];
    assert.equal(lookup_slash("/compact", skills), "compact");
    assert.equal(lookup_slash("/login", skills), "login");
    assert.equal(lookup_slash("/review", skills), "review");
    assert.equal(lookup_slash("review", skills), "review");
    assert.equal(lookup_slash("/nope", skills), null);
    assert.equal(builtin_slash_commands().length(), 24)
}

test "registry is pi's 23 plus bi help" {
    for (let want in ["help", "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit"]) {
        let found = false;
        for (let b in builtin_slash_commands()) {
            if (b.name == want) {
                found = true
            }
        }
        assert.is_true(found)
    }
}

test "scope marks live vs owning issue" {
    for (let b in builtin_slash_commands()) {
        match (b.name) {
            "help" => assert.is_true(b.scope is null),
            "compact" => assert.is_true(b.scope is null),
            "reload" => assert.is_true(b.scope is null),
            "login" => assert.is_true(b.scope is null),
            "logout" => assert.is_true(b.scope is null),
            "hotkeys" => assert.is_true(b.scope is null),
            "quit" => assert.is_true(b.scope is null),
            "model" => assert.equal(b.scope, "bi#28"),
            "thinking" => assert.equal(b.scope, "bi#28"),
            "scoped-models" => assert.equal(b.scope, "bi#28"),
            "settings" => assert.equal(b.scope, "bi#29"),
            "trust" => assert.equal(b.scope, "bi#29"),
            "session" => assert.equal(b.scope, "bi#30"),
            "resume" => assert.equal(b.scope, "bi#30"),
            "new" => assert.equal(b.scope, "bi#30"),
            "fork" => assert.equal(b.scope, "bi#30"),
            "clone" => assert.equal(b.scope, "bi#30"),
            "export" => assert.equal(b.scope, "bi#30"),
            "share" => assert.equal(b.scope, "bi#30"),
            "name" => assert.equal(b.scope, "bi#30"),
            "import" => assert.equal(b.scope, "bi#30"),
            "tree" => assert.equal(b.scope, "bi#32"),
            "copy" => assert.equal(b.scope, "bi#32"),
            "changelog" => assert.equal(b.scope, "bi#31"),
            _ => assert.is_true(false),
        }
    }
}

test "hotkeys text describes bi REPL keys" {
    let t = hotkeys_text();
    assert.contains(t, "/help");
    assert.contains(t, "Ctrl-C");
    assert.contains(t, "Ctrl-D")
}
