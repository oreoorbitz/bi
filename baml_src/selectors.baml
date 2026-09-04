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

function format_thinking_list(current: string, theme: string? = null) -> string {
    let out = "";
    for (let level in thinking_levels()) {
        let row = if (level == current) {
            style_segment(`* ${level} — ${thinking_level_description(level)}`, "accent", theme)
        } else {
            `  ${level} — ${thinking_level_description(level)}`
        };
        out = `${out}${row}\n`;
    }
    out
}

// pi's scoped-models EnabledIds: null = all enabled (no filter), a list
// = the explicit enabled set. The host persists the list in settings.
function is_model_enabled(enabled: string[]?, id: string) -> bool {
    match (enabled) {
        null => true,
        let ids: string[] => {
            let hit = false;
            for (let e in ids) {
                if (e == id) {
                    hit = true
                }
            }
            hit
        },
    }
}

// Catalog-wide model list grouped by provider; current backend marked,
// disabled rows flagged, every row numbered for `/model <n>` picks.
// Numbers run across provider groups in catalog order (same order
// pick_model walks), so a fresh listing and a pick always agree.
function format_model_list(current_id: string, theme: string? = null, enabled: string[]? = null) -> string {
    let out = "";
    let n = 0;
    for (let p in ListProviders()) {
        out = `${out}${style_segment(`${p.id}:`, "dim", theme)}\n`;
        for (let m in ListModels(p.id)) {
            n = n + 1;
            let mark = if (is_model_enabled(enabled, m.id)) {
                ""
            } else {
                " (disabled)"
            };
            let row = if (m.id == current_id) {
                style_segment(`* ${m.id} — ${m.context_window} ctx ${m.cost.input}/${m.cost.output} per 1M${mark}`, "accent", theme)
            } else {
                `  ${m.id} — ${m.context_window} ctx ${m.cost.input}/${m.cost.output} per 1M${mark}`
            };
            out = `${out}${n}  ${row}\n`;
        }
    }
    out
}

// Numbered pick over the same walk: 1-based, null when out of range.
// The host applies the enabled-guard and backend switch.
function pick_model(n: int) -> Model? {
    if (n < 1) {
        null
    } else {
        let i = 0;
        let found: Model? = null;
        for (let p in ListProviders()) {
            for (let m in ListModels(p.id)) {
                i = i + 1;
                if (i == n) {
                    found = m
                }
            }
        }
        found
    }
}

// 0-based cursor line for the select frame (bi#68): the same provider
// walk as format_model_list — including its per-provider header lines —
// so the highlight lands on the current backend's numbered row, not a
// header. 0 when the id is unknown (the frame clamps anyway).
// Display-only — picks stay numeric against pick_model.
function model_list_cursor(current_id: string) -> int {
    let i = 0;
    let at = 0;
    for (let p in ListProviders()) {
        i = i + 1;
        for (let m in ListModels(p.id)) {
            if (m.id == current_id) {
                at = i
            }
            i = i + 1
        }
    }
    at
}

// Flat id list for host set transitions (disable-from-all needs the
// full catalog to subtract from).
function all_model_ids() -> string[] {
    let out: string[] = [];
    for (let m in ListAllModels()) {
        out.push(m.id)
    }
    out
}

// /scoped-models board: the deviation from the default, not the whole
// catalog. Null reads as all-enabled with the catalog size for context.
function format_scoped_models(enabled: string[]?) -> string {
    let total = ListAllModels().length();
    match (enabled) {
        null => `all ${total} models enabled (/scoped-models disable <ref> to narrow)`,
        let ids: string[] => {
            if (ids.length() == 0) {
                "(none enabled — /scoped-models all to reset)"
            } else {
                let out = `${ids.length()} of ${total} enabled:\n`;
                for (let id in ids) {
                    out = `${out}  ${id}\n`
                };
                out
            }
        },
    }
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
function footer_text(
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

function format_repl_footer(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
    theme: string? = null,
) -> string {
    style_segment(footer_text(provider, model, thinking, turns, messages), "dim", theme)
}

// Pinned-footer frame (bi#67): the readout width-capped to one terminal
// row so the bottom region row never wraps (a wrapped footer misaligns
// the scroll region). Truncation runs on the PLAIN text, styling wraps
// after — visible width is exact. Wide terminals are byte-identical to
// format_repl_footer with the same theme.
function render_footer_frame(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
    width: int,
    theme: string? = null,
) -> string {
    style_segment(truncate_chars(footer_text(provider, model, thinking, turns, messages), width), "dim", theme)
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

test "model cursor lands on the current backend's numbered row" {
    // First model: one header line above it, number 1, pick 1.
    let rows = format_model_list("claude-haiku-4-5", theme = null).split("\n");
    let at = model_list_cursor("claude-haiku-4-5");
    assert.contains(rows.at(at) ?? "", "1  * claude-haiku-4-5");
    match (pick_model(1)) {
        null => assert.is_true(false),
        let m: Model => assert.equal(m.id, "claude-haiku-4-5"),
    }
    // Mid-catalog model: the highlighted line names it with its number.
    let mid = format_model_list("nope", theme = null).split("\n");
    let crow = model_list_cursor("grok-4.6");
    assert.contains(mid.at(crow) ?? "", "grok-4.6");
    assert.is_true((mid.at(crow) ?? "").starts_with("37  "));
    assert.is_true(model_list_cursor("bogus-model") == 0)
}

test "numbered picks walk the catalog in list order" {
    match (pick_model(1)) {
        null => assert.is_true(false),
        let m: Model => assert.equal(m.id, "claude-haiku-4-5"),
    }
    assert.is_true(pick_model(0) is null);
    assert.is_true(pick_model(99999) is null);
    // List row 1 and pick 1 agree on the same model.
    assert.contains(format_model_list("nope"), "1  ")
}

test "scoped models narrow the list, null means all" {
    assert.is_true(is_model_enabled(null, "grok-4.6"));
    assert.is_true(is_model_enabled(["grok-4.6"], "grok-4.6"));
    assert.is_true(!is_model_enabled(["grok-4.6"], "claude-haiku-4-5"));
    assert.is_true(!is_model_enabled([], "grok-4.6"));
    let marked = format_model_list("grok-4.6", enabled = ["grok-4.6"]);
    assert.contains(marked, "claude-haiku-4-5 — ");
    assert.contains(marked, "(disabled)");
    let unmarked = format_model_list("grok-4.6");
    assert.is_true(unmarked.index_of("(disabled)") == null);
    let board = format_scoped_models(["grok-4.6"]);
    assert.contains(board, "1 of ");
    assert.contains(board, "  grok-4.6");
    assert.contains(format_scoped_models(null), "models enabled");
    assert.contains(format_scoped_models([]), "/scoped-models all to reset")
}

test "themed lists style current rows only" {
    let models = format_model_list("grok-4.6", theme = "default");
    assert.contains(models, "grok-4.6");
    assert.is_true(models.length() > format_model_list("grok-4.6", theme = null).length());
    assert.contains(format_model_list("grok-4.6", theme = null), "* grok-4.6");
    let footer = format_repl_footer("xai", "grok-4.6", "high", 2, 5, theme = "default");
    assert.contains(footer, "xai/grok-4.6");
    assert.is_true(footer.length() > format_repl_footer("xai", "grok-4.6", "high", 2, 5, theme = null).length())
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

test "footer frame caps to one row" {
    // Wide: byte-identical to the printed footer (same theme).
    assert.equal(
        render_footer_frame("xai", "grok-4.6", "high", 2, 5, 80),
        format_repl_footer("xai", "grok-4.6", "high", 2, 5),
    );
    // Narrow: hard cap with truncation mark.
    assert.equal(render_footer_frame("xai", "grok-4.6", "high", 2, 5, 12), "xai/grok-4.6…");
    // Styled frame keeps the visible text capped (style wraps outside).
    let styled = render_footer_frame("xai", "grok-4.6", "high", 2, 5, 12, theme = "default");
    assert.contains(styled, "xai/grok-4.6…");
    assert.is_true(styled.length() > "xai/grok-4.6…".length());
    // Singular counters flow through the frame.
    assert.equal(
        render_footer_frame("anthropic", "claude-haiku-4-5", "medium", 1, 1, 80),
        "anthropic/claude-haiku-4-5 · thinking medium · 1 turn · 1 message",
    )
}
