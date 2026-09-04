// bi/baml_src/settings.baml — user settings policy (bi#29).
// BAML owns the schema, validation, and flag > settings > builtin
// precedence; the host owns ~/.bi/settings.json FS. Three scalar backend
// defaults plus the bi#28 scoped-models enablement list (null = all
// enabled, pi's EnabledIds). Generic /settings get/set/unset stays
// scalar; /scoped-models owns the list verbs.

class UserSettings {
    default_provider: string?,
    default_model: string?,
    default_thinking: string?,
    enabled_models: string[]?,
}

function builtin_default_provider() -> string {
    "anthropic"
}

function builtin_default_model() -> string {
    "claude-haiku-4-5"
}

function setting_keys() -> string[] {
    ["default_provider", "default_model", "default_thinking"]
}

function is_setting_key(key: string) -> bool {
    key == "default_provider" || key == "default_model" || key == "default_thinking"
}

// Whole-record validation: unknown provider/model/thinking each name
// the fix, and a provider/model mismatch fails instead of misrouting
// (SendTurn routes on the provider tag, so a cross-provider pair would
// send the wrong model id to the wrong endpoint).
function validate_settings(s: UserSettings) -> string[] {
    let errors: string[] = [];
    match (s.default_provider) {
        null => {},
        let p: string => {
            if (!ProviderExists(p)) {
                errors.push(`unknown provider "${p}" — see ListProviders`)
            }
        },
    }
    match (s.default_model) {
        null => {},
        let m: string => {
            match (GetModel(m)) {
                null => {
                    errors.push(`unknown model "${m}" — bare /model lists the catalog`)
                },
                let rec: Model => {
                    match (s.default_provider) {
                        null => {},
                        let p: string => {
                            if (ProviderExists(p) && rec.provider != p) {
                                errors.push(
                                    `model "${m}" belongs to provider "${rec.provider}", not "${p}"`,
                                )
                            }
                        },
                    }
                },
            }
        },
    }
    match (s.default_thinking) {
        null => {},
        let t: string => {
            if (!is_valid_thinking_level(t)) {
                errors.push(`unknown thinking level "${t}" — bare /thinking lists the levels`)
            }
        },
    }
    match (s.enabled_models) {
        null => {},
        let ids: string[] => {
            for (let id in ids) {
                if (GetModel(id) is null) {
                    errors.push(
                        `unknown model "${id}" in enabled_models — /scoped-models all to reset`,
                    )
                }
            }
        },
    }
    errors
}

class ResolvedBackend {
    provider: string,
    model: string,
    thinking: string?,
}

// Precedence per key: explicit flag > stored setting > builtin. Throws
// InvalidArgument naming the bad value (host turns it into exit 1 /
// stays-in-session). Same resolver for REPL init and `bi run`.
function resolve_backend(
    flag_provider: string?,
    flag_model: string?,
    flag_thinking: string?,
    s: UserSettings,
) -> ResolvedBackend throws baml.errors.InvalidArgument {
    let provider = flag_provider ?? s.default_provider ?? builtin_default_provider();
    let model = flag_model ?? s.default_model ?? builtin_default_model();
    let thinking = flag_thinking ?? s.default_thinking ?? null;
    if (!ProviderExists(provider)) {
        throw baml.errors.InvalidArgument { message: `unknown provider "${provider}"` }
    }
    let rec = GetModel(model);
    match (rec) {
        null => {
            throw baml.errors.InvalidArgument { message: `unknown model "${model}"` }
        },
        let m: Model => {
            if (m.provider != provider) {
                throw baml.errors.InvalidArgument { message: `model "${model}" belongs to provider "${m.provider}", not "${provider}"` }
            }
        },
    }
    match (thinking) {
        null => {},
        let t: string => {
            if (!is_valid_thinking_level(t)) {
                throw baml.errors.InvalidArgument { message: `unknown thinking level "${t}"` }
            }
        },
    }
    ResolvedBackend { provider: provider, model: model, thinking: thinking }
}

function format_settings_list(s: UserSettings) -> string {
    let out = "";
    for (let key in setting_keys()) {
        let value = if (key == "default_provider") {
            s.default_provider ?? "(unset)"
        } else if (key == "default_model") {
            s.default_model ?? "(unset)"
        } else {
            s.default_thinking ?? "(unset)"
        };
        out = `${out}${key} = ${value}\n`;
    }
    let scoped = match (s.enabled_models) {
        null => "all",
        let ids: string[] => {
            if (ids.length() == 0) {
                "(none)"
            } else {
                let joined = "";
                for (let id in ids) {
                    if (joined == "") {
                        joined = id
                    } else {
                        joined = `${joined}, ${id}`
                    }
                }
                joined
            }
        },
    };
    out = `${out}enabled_models = ${scoped}\n`;
    out
}

function empty_settings() -> UserSettings {
    UserSettings {
        default_provider: null,
        default_model: null,
        default_thinking: null,
        enabled_models: null,
    }
}

test "empty settings resolve to builtins" {
    let r = resolve_backend(null, null, null, empty_settings());
    assert.equal(r.provider, "anthropic");
    assert.equal(r.model, "claude-haiku-4-5");
    assert.is_true(r.thinking is null)
}

test "flags beat stored settings beat builtins" {
    let s = UserSettings {
        default_provider: "xai",
        default_model: "grok-4.6",
        default_thinking: "high",
        enabled_models: null,
    };
    let stored = resolve_backend(null, null, null, s);
    assert.equal(stored.provider, "xai");
    assert.equal(stored.model, "grok-4.6");
    assert.equal(stored.thinking, "high");
    let flagged = resolve_backend("meta", "muse-spark-1.3", "low", s);
    assert.equal(flagged.provider, "meta");
    assert.equal(flagged.model, "muse-spark-1.3");
    assert.equal(flagged.thinking, "low")
}

test "mismatched provider/model fails instead of misrouting" {
    let s = UserSettings {
        default_provider: "xai",
        default_model: "muse-spark-1.3",
        default_thinking: null,
        enabled_models: null,
    };
    assert.equal(validate_settings(s).length(), 1);
    let threw = false;
    let _ = resolve_backend(null, null, null, s) catch (e) {
        baml.errors.InvalidArgument => {
            threw = true;
        }
    };
    assert.is_true(threw);
    let badFlag = false;
    let _ = resolve_backend("meta", "grok-4.6", null, empty_settings()) catch (e) {
        baml.errors.InvalidArgument => {
            badFlag = true;
        }
    };
    assert.is_true(badFlag)
}

test "unknown values name the fix" {
    let s = UserSettings {
        default_provider: "bogus",
        default_model: "nope",
        default_thinking: "ultra",
        enabled_models: null,
    };
    let errors = validate_settings(s);
    assert.equal(errors.length(), 3)
}

test "settings list shows unsets" {
    let out = format_settings_list(empty_settings());
    assert.contains(out, "default_provider = (unset)");
    assert.contains(out, "default_thinking = (unset)");
    assert.contains(out, "enabled_models = all");
    let s = UserSettings {
        default_provider: "meta",
        default_model: null,
        default_thinking: null,
        enabled_models: null,
    };
    assert.contains(format_settings_list(s), "default_provider = meta")
}

test "enabled_models validates ids and lists the set" {
    let good = UserSettings {
        default_provider: null,
        default_model: null,
        default_thinking: null,
        enabled_models: ["grok-4.6", "muse-spark-1.3"],
    };
    assert.equal(validate_settings(good).length(), 0);
    assert.contains(format_settings_list(good), "enabled_models = grok-4.6, muse-spark-1.3");
    let bad = UserSettings {
        default_provider: null,
        default_model: null,
        default_thinking: null,
        enabled_models: ["grok-4.6", "nope"],
    };
    let errors = validate_settings(bad);
    assert.equal(errors.length(), 1);
    assert.contains(errors.at(0) ?? "", "/scoped-models all to reset");
    let none = UserSettings {
        default_provider: null,
        default_model: null,
        default_thinking: null,
        enabled_models: [],
    };
    assert.contains(format_settings_list(none), "enabled_models = (none)")
}
