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
function format_model_list(
    current_id: string,
    theme: string? = null,
    enabled: string[]? = null,
) -> string {
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
                style_segment(
                    `* ${m.id} — ${m.context_window} ctx ${m.cost.input}/${m.cost.output} per 1M${mark}`,
                    "accent",
                    theme,
                )
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

// bi#90: Ctrl+P cycling over the scoped set (pi's
// AgentSession.cycleModel forward over _scopedModels, else the available
// snapshot). Pure stepping policy: the ordered walk is catalog order
// filtered by the enablement set (null = all), the step lands on the next
// id with wrap. Null means "refuse" — the host says why loudly (empty vs
// single sets need different hints and only the host knows the wording).
// DIVERGENCE from pi: an unknown/disabled current starts AT walk[0]; pi
// treats it as index 0 and advances to walk[1].
function cycle_model_forward(current_id: string, enabled: string[]?) -> string? {
    // The walk is id-based, but advisory rows duplicate bare ids across
    // providers (openai + azure-openai-responses both list gpt-4o): dedupe
    // first-wins, matching GetModel resolution, so a duplicated id still
    // counts as one step and a single-id set still refuses.
    let walk: string[] = [];
    for (let p in ListProviders()) {
        for (let m in ListModels(p.id)) {
            if (is_model_enabled(enabled, m.id) && !walk.includes(m.id)) {
                walk.push(m.id)
            }
        }
    }
    if (walk.length() <= 1) {
        null
    } else {
        let at = -1;
        let i = 0;
        for (let id in walk) {
            if (id == current_id) {
                at = i
            }
            i = i + 1
        }
        if (at == -1) {
            walk.at(0)
        } else if (at + 1 >= walk.length()) {
            walk.at(0)
        } else {
            walk.at(at + 1)
        }
    }
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
                }
                ;
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

// bi#85: fuzzy search in selectors, ported from pi's model-search.ts +
// session-selector-search.ts via the pi-tui fuzzy semantics (in-order
// subsequence, case-insensitive, lower score = better). BAML owns the
// search-text builders and the ranking; the host owns the filter row
// (prompt.ts FilterList) and passes per-row texts. Deliberate
// divergence: pi's alnum/digit swap fallback (gpt5 ~ 5gpt) is skipped —
// no regex in BAML, and the catalog has no such ids. Scores are pi's ×
// 10 in ints (BAML int/int truncates, so no float penalties).
function model_search_text(id: string, provider: string, name: string? = null) -> string {
    let suffix = if let n: string = name {
        ` ${n}`
    } else {
        ""
    };
    `${id} ${provider} ${provider}/${id} ${provider} ${id}${suffix}`
}

// The /model selector shape: provider leads, so an exact
// provider-prefixed query ranks the true row before proxy-provider ids
// like openrouter/openai/gpt-5 (pi's comment, verbatim intent).
function model_selector_search_text(id: string, provider: string, name: string? = null) -> string {
    let suffix = if let n: string = name {
        ` ${n}`
    } else {
        ""
    };
    `${provider} ${provider}/${id} ${provider} ${id}${suffix}`
}

function is_search_boundary(ch: string) -> bool {
    ch == " " || ch == "-" || ch == "_" || ch == "." || ch == "/" || ch == ":"
}

function split_query_tokens(query: string) -> string[] {
    let out: string[] = [];
    for (let w in query.to_lower_case().split(" ")) {
        for (let s in w.split("/")) {
            for (let t in s.split("\t")) {
                if (t.length() > 0) {
                    out.push(t)
                }
            }
        }
    }
    out
}

// Single-token subsequence score, null when the token cannot match.
// Exact equality takes the -1000 bonus; otherwise each matched char
// pays its position (late penalty), gaps pay ×20 per skipped char,
// consecutive runs earn back ×50 per char, word-boundary starts earn
// -100. Empty token vacuously matches at 0.
function fuzzy_score(query: string, text: string) -> int? {
    let q = query.to_lower_case();
    let t = text.to_lower_case();
    let qcs = q.chars();
    let tcs = t.chars();
    if (qcs.length() == 0) {
        0
    } else if (qcs.length() > tcs.length()) {
        null
    } else if (q == t) {
        -1000
    } else {
        let score = 0;
        let qi = 0;
        let ti = 0;
        let last = -1;
        let consec = 0;
        let miss = false;
        while (qi < qcs.length() && !miss) {
            let qc = qcs.at(qi) ?? "";
            let found = false;
            while (ti < tcs.length() && !found) {
                if ((tcs.at(ti) ?? "") == qc) {
                    if (last == ti - 1) {
                        consec = consec + 1;
                        score = score - consec * 50
                    } else {
                        consec = 0;
                        if (last >= 0) {
                            score = score + (ti - last - 1) * 20
                        }
                    }
                    if (ti == 0 || is_search_boundary(tcs.at(ti - 1) ?? "")) {
                        score = score - 100
                    }
                    score = score + ti;
                    last = ti;
                    found = true
                }
                ti = ti + 1
            }
            if (!found) {
                miss = true
            } else {
                qi = qi + 1
            }
        }
        if (miss) {
            null
        } else {
            score
        }
    }
}

function contains_index(xs: int[], v: int) -> bool {
    let hit = false;
    for (let x in xs) {
        if (x == v) {
            hit = true
        }
    }
    hit
}

// Ranked original indices for the query over per-row search texts:
// every whitespace/slash token must fuzzy-match (scores sum), misses
// drop out, ties keep catalog order. Blank queries list ALL indices in
// order (the empty-filter and pipe paths share this); zero texts rank
// to empty, never error.
function rank_selector_rows(query: string, texts: string[]) -> int[] {
    let tokens = split_query_tokens(query);
    let n = texts.length();
    if (tokens.length() == 0) {
        let all: int[] = [];
        let i = 0;
        while (i < n) {
            all.push(i);
            i = i + 1
        }
        all
    } else {
        let hits: bool[] = [];
        let totals: int[] = [];
        for (let text in texts) {
            let total = 0;
            let miss = false;
            for (let tok in tokens) {
                match (fuzzy_score(tok, text)) {
                    null => {
                        miss = true
                    },
                    let s: int => {
                        total = total + s
                    },
                }
            }
            hits.push(!miss);
            totals.push(total)
        }
        let matches = 0;
        for (let h in hits) {
            if (h) {
                matches = matches + 1
            }
        }
        let out: int[] = [];
        let emitted = 0;
        while (emitted < matches) {
            let best = -1;
            let best_score = 0;
            let i = 0;
            while (i < n) {
                if ((hits.at(i) ?? false) && !contains_index(out, i)) {
                    let s = totals.at(i) ?? 0;
                    if (best == -1 || s < best_score) {
                        best = i;
                        best_score = s
                    }
                }
                i = i + 1
            }
            out.push(best);
            emitted = emitted + 1
        }
        out
    }
}

test "model search texts mirror pi's builders" {
    assert.equal(
        model_search_text("grok-4.6", "xai", name = "Grok 4.6"),
        "grok-4.6 xai xai/grok-4.6 xai grok-4.6 Grok 4.6",
    );
    assert.equal(
        model_selector_search_text("grok-4.6", "xai", name = "Grok 4.6"),
        "xai xai/grok-4.6 xai grok-4.6 Grok 4.6",
    );
    // No name: no trailing space.
    assert.equal(model_search_text("gpt-5", "openai"), "gpt-5 openai openai/gpt-5 openai gpt-5");
    // Selector shape never leads with the bare id (the proxy ranking
    // property below depends on it).
    assert.is_true(model_selector_search_text("gpt-5", "openai").starts_with("openai "))
}

test "fuzzy score matches, misses, and folds case" {
    assert.is_true(fuzzy_score("zzz", "grok-4.6") is null);
    assert.is_true(fuzzy_score("kg", "grok") is null);
    assert.is_true(fuzzy_score("grok-4.6-extra", "grok") is null);
    assert.equal(fuzzy_score("", "grok-4.6"), 0);
    assert.equal(fuzzy_score("xai", "xai"), -1000);
    match (fuzzy_score("XAI", "xai xai/grok-4.6 xai grok-4.6")) {
        null => assert.is_true(false),
        let s: int => assert.is_true(s < 0),
    }
    // Consecutive + early beats gappy + late for the same token.
    match (fuzzy_score("gro", "grok-4.6")) {
        null => assert.is_true(false),
        let tight: int => {
            match (fuzzy_score("gro", "xxgxxrxxo")) {
                null => assert.is_true(false),
                let loose: int => assert.is_true(tight < loose),
            }
        },
    }
}

test "rank lists all on blank, drops misses, keeps order on ties" {
    let texts = [
        "xai xai/grok-4.6 xai grok-4.6",
        "anthropic anthropic/claude-haiku-4-5 anthropic claude-haiku-4-5",
    ];
    assert.equal(rank_selector_rows("", texts), [0, 1]);
    assert.equal(rank_selector_rows("   ", texts), [0, 1]);
    assert.equal(rank_selector_rows("grok", texts), [0]);
    assert.equal(rank_selector_rows("zzz", texts), []);
    assert.equal(rank_selector_rows("ab", ["ab", "ab"]), [0, 1]);
    assert.equal(rank_selector_rows("q", []), [])
}

test "provider-prefixed query ranks the true row before the proxy" {
    // pi's getModelSelectorSearchText comment: the /model selector must
    // rank exact provider-prefixed queries before proxy-provider ids
    // like openrouter/openai/gpt-5.
    let texts = [
        model_selector_search_text("gpt-5", "openai"),
        model_selector_search_text("openai/gpt-5", "openrouter"),
    ];
    assert.equal(rank_selector_rows("openai/gpt", texts), [0, 1]);
    assert.equal(rank_selector_rows("xai/grok", texts), [])
}

test "cycle advances and wraps within the full catalog" {
    assert.equal(cycle_model_forward("claude-haiku-4-5", null), "claude-sonnet-4-5");
    assert.equal(cycle_model_forward("gemini-2.0-flash", null), "gemini-2.5-pro");
    // Full walk returns to the head: step from the second id until
    // claude-haiku-4-5 recurs (cap 200 — the catalog holds ~80 unique
    // ids; advisory duplicates like gpt-4o/glm-5.3 count once). Order-free:
    // ListAllModels and the provider walk disagree at the tail, so no tail
    // id is pinned here.
    let cur = "claude-sonnet-4-5";
    let steps = 0;
    let done = false;
    while (steps < 200 && !done) {
        match (cycle_model_forward(cur, null)) {
            null => {
                cur = "REFUSED";
                done = true
            },
            let nx: string => {
                cur = nx;
                steps = steps + 1;
                if (nx == "claude-haiku-4-5") {
                    done = true
                }
            },
        }
    }
    assert.equal(cur, "claude-haiku-4-5");
    assert.is_true(steps > 50)
}

test "cycle honors the enabled set" {
    let enabled = ["gemini-2.0-flash", "claude-haiku-4-5"];
    assert.equal(cycle_model_forward("gemini-2.0-flash", enabled), "claude-haiku-4-5");
    assert.equal(cycle_model_forward("claude-haiku-4-5", enabled), "gemini-2.0-flash");
    // Unknown ids in the set are skipped, never stepped onto.
    assert.equal(
        cycle_model_forward("gemini-2.0-flash", ["gemini-2.0-flash", "bogus", "claude-haiku-4-5"]),
        "claude-haiku-4-5",
    )
}

test "cycle dedupes advisory ids first-wins" {
    // gpt-4o is listed under both openai and azure-openai-responses: one
    // step, not two, and the openai order leads.
    assert.equal(cycle_model_forward("gpt-4o-mini", ["gpt-4o", "gpt-4o-mini"]), "gpt-4o");
    assert.equal(cycle_model_forward("gpt-4o", ["gpt-4o", "gpt-4o-mini"]), "gpt-4o-mini")
}

test "cycle starts at the set head for unknown or disabled current" {
    assert.equal(cycle_model_forward("bogus", ["gpt-4o-mini", "gpt-4o"]), "gpt-4o-mini");
    assert.equal(cycle_model_forward("claude-haiku-4-5", ["gpt-4o-mini", "gpt-4o"]), "gpt-4o-mini")
}

test "cycle refuses empty and single sets" {
    assert.is_true(cycle_model_forward("gemini-2.0-flash", []) is null);
    assert.is_true(cycle_model_forward("gpt-4o", ["gpt-4o"]) is null);
    assert.is_true(cycle_model_forward("bogus", ["gpt-4o"]) is null)
}

function footer_text(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
    cwd: string? = null,
    branch: string? = null,
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
    let cs = if let c: string = cwd {
        ` · ${c}`
    } else {
        ""
    };
    let bs = if let b: string = branch {
        ` · ${b}`
    } else {
        ""
    };
    `${provider}/${model} · thinking ${thinking} · ${tm} · ${mm}${cs}${bs}`
}

function format_repl_footer(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
    theme: string? = null,
    cwd: string? = null,
    branch: string? = null,
) -> string {
    style_segment(
        footer_text(provider, model, thinking, turns, messages, cwd = cwd, branch = branch),
        "dim",
        theme,
    )
}

// Pinned-footer frame (bi#67): the readout width-capped to one terminal
// row so the bottom region row never wraps (a wrapped footer misaligns
// the scroll region). Truncation runs on the PLAIN text, styling wraps
// after — visible width is exact. Wide terminals are byte-identical to
// format_repl_footer with the same theme.
// Model line for the pinned second footer row (bi#184): row 2 carries
// ONLY the catalog ctx window — the provider/model · thinking prefix
// lives exclusively on row 1 (footer_text), so no fact prints twice.
// Args stay for call-site stability (cli.ts passes provider/thinking;
// the split is pinned, not the signature). Stale ids render an empty
// row rather than bricking; bi#169's live context:% lands here next.
// Width-capped like the footer frame; pipes get the plain text via
// theme null.
function model_line_text(provider: string, model: string, thinking: string, width: int) -> string {
    let ctx = match (GetModel(model)) {
        null => "",
        let m: Model => `ctx ${m.context_window / 1000}k`,
    };
    truncate_chars(ctx, width)
}

function render_model_line(
    provider: string,
    model: string,
    thinking: string,
    width: int,
    theme: string? = null,
) -> string {
    style_segment(model_line_text(provider, model, thinking, width), "brand", theme)
}

test "model line carries ctx only, no repeated prefix" {
    let line = model_line_text("anthropic", "claude-haiku-4-5", "medium", 200);
    assert.equal(line, "ctx 200k");
    // Stale id: empty row, never bricks.
    assert.equal(model_line_text("anthropic", "nope-xyz", "medium", 200), "");
    // Narrow caps to one row like the footer frame.
    assert.equal(model_line_text("anthropic", "claude-haiku-4-5", "medium", 6), "ctx 20…");
    // Brand wrap adds the 18-byte truecolor code + 4-byte reset.
    let styled = render_model_line("anthropic", "claude-haiku-4-5", "medium", 200, theme = "default");
    assert.equal(styled.length(), line.length() + 22);
    assert.equal(
        render_model_line("anthropic", "claude-haiku-4-5", "medium", 200, theme = null),
        line,
    );
    assert.equal(
        render_model_line("anthropic", "claude-haiku-4-5", "medium", 200, theme = "none"),
        line,
    )
}

function render_footer_frame(
    provider: string,
    model: string,
    thinking: string,
    turns: int,
    messages: int,
    width: int,
    theme: string? = null,
    cwd: string? = null,
    branch: string? = null,
) -> string {
    style_segment(
        truncate_chars(footer_text(provider, model, thinking, turns, messages, cwd = cwd, branch = branch), width),
        "dim",
        theme,
    )
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
    assert.is_true(
        footer.length() > format_repl_footer("xai", "grok-4.6", "high", 2, 5, theme = null).length(),
    )
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

test "footer appends cwd and branch when present" {
    assert.equal(
        footer_text("xai", "grok-4.6", "high", 2, 5, cwd = "~/bi", branch = "main"),
        "xai/grok-4.6 · thinking high · 2 turns · 5 messages · ~/bi · main",
    );
    assert.equal(
        footer_text("xai", "grok-4.6", "high", 2, 5, cwd = "~/bi"),
        "xai/grok-4.6 · thinking high · 2 turns · 5 messages · ~/bi",
    );
    assert.equal(
        footer_text("xai", "grok-4.6", "high", 2, 5),
        "xai/grok-4.6 · thinking high · 2 turns · 5 messages",
    )
}

// ---------------------------------------------------------------------------
// bi#186: rotating footer tips — BAML owns the corpus + rotation policy as
// literal data; the host (HostFooter) owns the 10s timer, right-alignment,
// and muted styling. The seed corpus teaches bi's actual surface
// (BAIS-first workflow included), mirroring kimi's constant/tips.ts.
function footer_tips() -> string[] {
    [
        "/issues to stage BAIS work",
        "/bais new to file an issue",
        "@ to complete paths",
        "shift+enter: newline",
        "/model to switch backends",
        "! to run a shell command",
    ]
}

// Rotation cadence as data (kimi TIP_ROTATE_INTERVAL_MS mirror).
function tip_rotate_interval_ms() -> int {
    10000
}

// Rotation index wraps over the corpus; tick n pairs tips[n] with
// tips[n+1] (both mod len), so a full cycle shows every tip in both
// slots. Negative ticks wrap too (host counters never go negative, but
// the policy stays total).
function tip_index(tick: int) -> int {
    let n = footer_tips().length();
    let t = tick % n;
    if (t < 0) {
        t + n
    } else {
        t
    }
}

// Slot text for one tick at a slot width: the pair when it fits, the
// single tip on narrow terminals (truncated past that), empty when the
// slot is gone. `width` is the SLOT width — the host measures the
// columns left after the row's left content, never the full row.
function tips_slot_text(tick: int, width: int) -> string {
    if (width <= 0) {
        ""
    } else {
        let tips = footer_tips();
        let i = tip_index(tick);
        let first = tips.at(i) ?? "";
        let second = tips.at((i + 1) % tips.length()) ?? "";
        let pair = `${first} | ${second}`;
        if (pair.length() <= width) {
            pair
        } else if (first.length() <= width) {
            first
        } else {
            truncate_chars(first, width)
        }
    }
}
