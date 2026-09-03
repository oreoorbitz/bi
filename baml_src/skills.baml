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

function builtin_slash_commands() -> BuiltinSlashCommand[] {
    [
        BuiltinSlashCommand {
            name: "help",
            description: "List slash commands and skills",
            argument_hint: null,
        },
        BuiltinSlashCommand {
            name: "compact",
            description: "Compact the session context now",
            argument_hint: null,
        },
        BuiltinSlashCommand {
            name: "reload",
            description: "Rescan skill directories",
            argument_hint: null,
        },
        BuiltinSlashCommand { name: "quit", description: "Quit bi", argument_hint: null },
    ]
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
    assert.equal(lookup_slash("/review", skills), "review");
    assert.equal(lookup_slash("review", skills), "review");
    assert.equal(lookup_slash("/nope", skills), null);
    assert.equal(builtin_slash_commands().length(), 4)
}
