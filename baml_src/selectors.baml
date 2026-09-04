// bi/baml_src/selectors.baml — REPL selector policy (bi#28).
// BAML owns option shaping (model list, thinking levels, footer text);
// the host owns the widget loop (line-based pick by id/number today,
// arrow-key selectors with bi#32 input chrome). Thinking budgets are
// pi's DEFAULT_THINKING_BUDGETS (xhigh/max clamp to high); only the
// anthropic-messages arm consumes the config (turn.baml build_client).

function thinking_levels() -> string[] {
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
}

function thinking_level_description(level: string) -> string {
    match (level) {
        "off" => "No reasoning",
        "minimal" => "Very brief reasoning (~1k tokens)",
        "low" => "Light reasoning (~2k tokens)",
        "medium" => "Moderate reasoning (~8k tokens)",
        "high" => "Deep reasoning (~16k tokens)",
        "xhigh" => "Extra-high reasoning (~32k tokens)",
        "max" => "Maximum reasoning",
        _ => "Unknown thinking level",
    }
}

// pi's clampReasoning: xhigh/max ride the high budget.
function thinking_budget_tokens(level: string) -> int? {
    match (level) {
        "off" => null,
        "minimal" => 1024,
        "low" => 2048,
        "medium" => 8192,
        "high" => 16384,
        "xhigh" => 16384,
        "max" => 16384,
        _ => null,
    }
}

// Host passes the result straight into SendTurn/StreamTurn thinking.
// Caller validates with is_valid_thinking_level first; unknown maps to
// null (no thinking param) rather than a silent default budget.
function thinking_config_for_level(level: string) -> anthropic.ThinkingConfig? {
    match (thinking_budget_tokens(level)) {
        null => {
            if (level == "off") {
                anthropic.ThinkingConfig.disabled()
            } else {
                null
            }
        },
        let budget: int => anthropic.ThinkingConfig.enabled(budget),
    }
}

function format_thinking_list(current: string) -> string {
    let out = "";
    for (let level in thinking_levels()) {
        let mark = if (level == current) {
            "*"
        } else {
            " "
        };
        out = `${out}${mark} ${level} — ${thinking_level_description(level)}\n`;
    }
    out
}

// Catalog-wide model list grouped by provider; current backend marked.
// Costs are per-1M-tokens input/output like the catalog rows.
function format_model_list(current_id: string) -> string {
    let out = "";
    for (let p in ListProviders()) {
        out = `${out}${p.id}:\n`;
        for (let m in ListModels(p.id)) {
            let mark = if (m.id == current_id) {
                "*"
            } else {
                " "
            };
            out = `${out}  ${mark} ${m.id} — ${m.context_window} ctx ${m.cost.input}/${m.cost.output} per 1M\n`;
        }
    }
    out
}

// Resolve a /model argument: exact model id, "provider/id", or null.
// Host prints the not-found hint; BAML only decides the match.
function resolve_model_ref(ref: string) -> Model? {
    match (GetModel(ref)) {
        null => {
            let slash = ref.index_of("/");
            if (slash is null) {
                null
            } else {
                let provider = ref.slice(0, slash);
                let id = ref.slice(slash + 1, ref.length());
                match (GetProvider(provider)) {
                    null => null,
                    _ => {
                        let found: Model? = null;
                        for (let m in ListModels(provider)) {
                            if (m.id == id) {
                                found = m
                            }
                        }
                        found
                    },
                }
            }
        },
        let m: Model => m,
    }
}

// One-line REPL readout after every turn: backend identity + session
// counters. Token/context usage is pi-only: bi never captures usage
// (turn.baml returns text, not token counts), so counters stand in.
function format_repl_footer(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
) -> string {
    let tm = if (turns == 1) {
        "1 turn"
    } else {
        `${turns} turns`
    };
    let mm = if (messages == 1) {
        "1 message"
    } else {
        `${messages} messages`
    };
    `${provider}/${model} · thinking ${thinking} · ${tm} · ${mm}`
}

test "thinking levels are pi's seven in order" {
    let levels = thinking_levels();
    assert.equal(levels.length(), 7);
    assert.equal(levels[0], "off");
    assert.equal(levels[3], "medium");
    assert.equal(levels[6], "max")
}

test "thinking budgets follow pi defaults with xhigh/max clamp" {
    assert.is_true(thinking_budget_tokens("off") is null);
    assert.equal(thinking_budget_tokens("minimal"), 1024);
    assert.equal(thinking_budget_tokens("low"), 2048);
    assert.equal(thinking_budget_tokens("medium"), 8192);
    assert.equal(thinking_budget_tokens("high"), 16384);
    assert.equal(thinking_budget_tokens("xhigh"), 16384);
    assert.equal(thinking_budget_tokens("max"), 16384);
    assert.is_true(thinking_budget_tokens("bogus") is null)
}

test "thinking config maps levels to enabled/disabled" {
    match (thinking_config_for_level("off")) {
        null => assert.is_true(false),
        let c: anthropic.ThinkingConfig => assert.equal(c.type, "disabled"),
    }
    match (thinking_config_for_level("medium")) {
        null => assert.is_true(false),
        let c: anthropic.ThinkingConfig => {
            assert.equal(c.type, "enabled");
            assert.equal(c.budget_tokens, 8192)
        },
    }
    match (thinking_config_for_level("max")) {
        null => assert.is_true(false),
        let c: anthropic.ThinkingConfig => assert.equal(c.budget_tokens, 16384),
    }
    assert.is_true(thinking_config_for_level("bogus") is null)
}

test "model ref resolves exact id and provider/id" {
    match (resolve_model_ref("muse-spark-1.3")) {
        null => assert.is_true(false),
        let m: Model => assert.equal(m.provider, "meta"),
    }
    match (resolve_model_ref("xai/grok-4.6")) {
        null => assert.is_true(false),
        let m: Model => assert.equal(m.id, "grok-4.6"),
    }
    assert.is_true(resolve_model_ref("bogus-model") is null);
    assert.is_true(resolve_model_ref("bogus-provider/grok-4.6") is null)
}

test "lists mark the current backend" {
    let models = format_model_list("grok-4.6");
    assert.contains(models, "xai:");
    assert.contains(models, "* grok-4.6");
    assert.contains(models, "  claude-haiku-4-5");
    let levels = format_thinking_list("medium");
    assert.contains(levels, "* medium — Moderate reasoning (~8k tokens)");
    assert.contains(levels, "  high — Deep reasoning (~16k tokens)")
}

test "footer names backend and counters" {
    assert.equal(
        format_repl_footer("xai", "grok-4.6", "high", 2, 5),
        "xai/grok-4.6 · thinking high · 2 turns · 5 messages",
    );
    assert.equal(
        format_repl_footer("anthropic", "claude-haiku-4-5", "medium", 1, 1),
        "anthropic/claude-haiku-4-5 · thinking medium · 1 turn · 1 message",
    )
}
