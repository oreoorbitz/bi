// hub#209 tier 1: bounded curated memory blocks (hermes-style MEMORY.md +
// USER.md) owned by BAML policy functions. Tier 2 (session search) is
// hub#214 — NOT here.
//
// Port of hermes' MemoryStore (hermes-agent/tools/memory_tool_store.py) write
// policy and tools/threat_patterns.py deterministic scan into pure BAML:
//
//     memory_add / memory_replace / memory_remove / memory_apply_batch
//         (state, ...) -> MemoryWriteResult
//     freeze_snapshot(state, session) -> FrozenMemorySnapshot   (injected
//         FROZEN at session start by the host; mid-session writes return a new
//         MemoryState but never touch an already-frozen snapshot — prefix
//         cache intact, the write appears next session)
//     scan_for_threats(content) -> string[]                     (pattern ids)
//
// OVERFLOW IS AN ERROR, never silent compaction: an add/replace/batch that
// would exceed the block's char limit returns MemoryOverflow carrying the
// current entries and consolidation guidance, forcing an in-turn
// consolidate-and-retry (the batch path is the consolidation vehicle —
// remove/shorten stale entries AND add the new one in one atomic call,
// budget-checked against the FINAL state only, all-or-nothing).
//
// Staging (hub#203): these functions are pure state -> result. The host
// stages ReviewTurn's MemoryAdd proposals into its pending/ dir and only
// calls memory_apply_batch at approve time — nothing here touches disk.
//
// Named divergences from the hermes original:
//
// 1. NO REGEX / NO NFKC. BAML stdlib has neither, so the threat scan is a
//    deterministic port: whitespace-token ordered-sequence matching with a
//    bounded word gap (standing in for hermes' _FILLER regex) plus substring
//    arms. Full-width/compatibility homograph folding (NFKC) is NOT ported —
//    case folding via to_lower_case only. Regex gaps measured in characters
//    become word gaps; each arm's gap is annotated.
// 2. EXACT-DUPLICATE REJECTION. hermes' single add returns success "Entry
//    already exists (no duplicate added)" and its batch silently skips a
//    duplicate add (idempotent). hub#209's acceptance demands rejection:
//    both paths return MemoryDuplicate and change NOTHING — a repeated
//    lesson must be strengthened via 'replace', not re-added or silently
//    dropped.
// 3. NO SCOPE LEVELS. hermes scans memory writes at scope="strict", which is
//    cumulative (all ⊂ context ⊂ strict) — i.e. every pattern fires. bi's
//    scan_for_threats is that single full set with no scope parameter;
//    memory is the only consumer.
// 4. FIXED LIMITS. hermes reads memory_char_limit/user_char_limit from
//    config; bi pins the hermes defaults (2200 / 1375) until the host grows
//    a config surface.
// 5. bi NAMESPACE ARM. threat_patterns.py guards .hermes/config.yaml and
//    SOUL.md (hermes_config_mod); bi adds the equivalent bi_config_mod arm
//    for .bi/config.
// 6. NOT PORTED (host concerns): file locking, atomic write, drift guard,
//    load-time [BLOCKED:] sanitization, per-turn consolidation-failure cap
//    (#42405 — that caps the model's retry loop, a tool-loop concern), and
//    thousands-separator formatting in usage strings.
//
// hub#208 rail 2: PROVENANCE-AS-POLICY. Port of hermes' skill_provenance.py
// + skill_manager_guards.py _background_review_write_guard (#67140):
// created_by is a POLICY FLAG, not a provenance claim — autonomous/curator
// passes may only touch owner="agent" artifacts, a MISSING owner and an
// explicit owner="user" resolve IDENTICALLY (fail closed; keying on record
// presence made the policy race the guard's own bookkeeping), and adoption
// (memory_adopt) is the explicit ownership transfer, user-origin only. Each
// block carries an owner (MemoryState.memory_owner/user_owner, null = user,
// fail closed). The plain memory_add/replace/remove/apply_batch functions
// stay the FOREGROUND path (user-origin, never fenced — hermes fences only
// the autonomous fork); the *_as variants take an explicit origin and fence
// on it, so the host's autonomous passes (review-fork approval, curator)
// route through them.
//
// Plain-data FFI idiom (turn.baml limitations 2/4): every type here is
// field-only classes and literal-string unions; the result union crosses the
// bridge as a returned value, the direction that decodes cleanly.

// --- hermes defaults (memory_tool.py:56) -------------------------------------
function memory_char_limit() -> int {
    2200
}

function user_char_limit() -> int {
    1375
}

// Entries are joined by this delimiter on disk and for budget accounting
// (hermes ENTRY_DELIMITER, memory_tool_store.py:22).
function entry_delimiter() -> string {
    "\n§\n"
}

// Hard cap on scanned text (hermes MAX_SCAN_CHARS) — the scanner is advisory,
// so bound worst-case runtime.
function max_scan_chars() -> int {
    65536
}

// --- Types -------------------------------------------------------------------

// Live memory state: the two bounded blocks. MEMORY.md is the agent's own
// notes; USER.md is who the user is. Both are plain entry lists; the host
// persists them as delimiter-joined text (serialize_entries below).
//
// hub#208: each block carries an owner. Optional so pre-hub#208 persisted
// states (and every existing literal) load unchanged — null resolves to
// "user" (fail closed, hermes #67140), never to agent-owned.
class MemoryState {
    memory_entries: string[],
    user_entries: string[],
    memory_owner: MemoryOwner?,
    user_owner: MemoryOwner?,
}

// Provenance-as-policy (hub#208): "agent" blocks are curator-managed (the
// self-improvement loop may patch them autonomously); "user" blocks are
// user-authored or user-blessed and refuse agent-origin patches. User-origin
// writes are always allowed (foreground is sovereign).
type MemoryOwner = "user" | "agent";

// One batch operation — hermes' operations[] item shape. Literal-string
// union field, same idiom as review.baml's MemoryAdd.op.
class MemoryOp {
    action: "add" | "replace" | "remove",
    content: string?, // required for add/replace
    old_text: string?, // required for replace/remove (unique substring of the target entry)
}

class MemoryWriteOk {
    target: string, // "memory" | "user"
    message: string,
    usage_chars: int,
    char_limit: int,
    entry_count: int,
    // The NEW live state. A FrozenMemorySnapshot taken earlier is untouched —
    // this state is what the NEXT session freezes.
    state: MemoryState,
    note: string, // hermes: "Write saved. This update is complete — do not repeat it."
}

// Overflow is an ERROR: consolidate in this turn, never silent compaction.
class MemoryOverflow {
    target: string,
    usage_chars: int, // current block size
    char_limit: int,
    would_be_chars: int, // size if the write were applied
    current_entries: string[], // so the model can pick what to merge/remove
    guidance: string, // the consolidate-and-retry instruction
}

// Exact-duplicate rejection (divergence 2): nothing changed.
class MemoryDuplicate {
    target: string,
    content: string,
    message: string,
}

// Threat-scan rejection: the entry never enters the block.
class MemoryThreatBlocked {
    target: string,
    findings: string[], // pattern ids from scan_for_threats
    message: string,
}

// replace/remove found no unique entry (or the match was ambiguous).
class MemoryNoMatch {
    target: string,
    old_text: string,
    ambiguous: bool,
    current_entries: string[],
    message: string,
}

// Malformed write (empty content/old_text, empty batch, refused wipe).
class MemoryInvalid {
    target: string,
    message: string,
}

// Provenance fence refusal (hub#208): an agent-origin (autonomous) write hit
// a block it does not own. Nothing changed; the message names the adopt fix.
class MemoryOwnerRefused {
    target: string,
    owner: MemoryOwner, // resolved owner (null resolves to "user" first)
    origin: MemoryOwner, // who attempted the write
    message: string,
}

type MemoryWriteResult = MemoryWriteOk
    | MemoryOverflow
    | MemoryDuplicate
    | MemoryThreatBlocked
    | MemoryNoMatch
    | MemoryInvalid
    | MemoryOwnerRefused;

// Frozen load-time snapshot (hermes _system_prompt_snapshot): rendered once
// at session start and injected verbatim; mid-session writes persist to the
// live state but never mutate this — the prefix cache survives the session.
class FrozenMemorySnapshot {
    session: string, // label for traceability/tests
    memory_block: string, // "" when no entries
    user_block: string,
}

// --- Target plumbing ---------------------------------------------------------

function memory_target_limit(target: string) -> int {
    match (target) {
        "memory" => memory_char_limit(),
        "user" => user_char_limit(),
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown memory target: ${other} (want "memory" or "user")`,
            }
        },
    }
}

function memory_entries_for(state: MemoryState, target: string) -> string[] {
    match (target) {
        "memory" => state.memory_entries,
        "user" => state.user_entries,
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown memory target: ${other} (want "memory" or "user")`,
            }
        },
    }
}

function memory_with_entries(state: MemoryState, target: string, entries: string[]) -> MemoryState {
    match (target) {
        "memory" => {
            MemoryState {
                memory_entries: entries,
                user_entries: state.user_entries,
                memory_owner: state.memory_owner,
                user_owner: state.user_owner,
            }
        },
        "user" => {
            MemoryState {
                memory_entries: state.memory_entries,
                user_entries: entries,
                memory_owner: state.memory_owner,
                user_owner: state.user_owner,
            }
        },
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown memory target: ${other} (want "memory" or "user")`,
            }
        },
    }
}

// --- Provenance fence (hub#208 rail 2) ----------------------------------------

// Resolve a block's owner, FAIL CLOSED (hermes #67140): a missing owner and
// an explicit "user" resolve identically — NOT agent-owned. "Allowed exactly
// once" is not a policy; null is user soil until memory_adopt says otherwise.
function memory_block_owner(state: MemoryState, target: string) -> MemoryOwner {
    let raw = match (target) {
        "memory" => state.memory_owner,
        "user" => state.user_owner,
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown memory target: ${other} (want "memory" or "user")`,
            }
        },
    };
    raw ?? "user"
}

// The fence: user-origin writes are sovereign (foreground is never fenced —
// hermes fences only the autonomous fork); agent-origin writes may only
// touch agent-owned blocks.
function memory_fence_allows(owner: MemoryOwner, origin: MemoryOwner) -> bool {
    if (origin == "user") {
        true
    } else {
        owner == "agent"
    }
}

// Preflight for an origin-tagged write: null when allowed, else the named
// refusal (bi#55) carrying the adopt fix — hermes: "Run `hermes curator
// adopt <name>` to opt it in."
function memory_check_owner(
    state: MemoryState,
    target: string,
    origin: MemoryOwner,
) -> MemoryOwnerRefused? {
    let owner = memory_block_owner(state, target);
    if (memory_fence_allows(owner, origin)) {
        null
    } else {
        MemoryOwnerRefused {
            target: target,
            owner: owner,
            origin: origin,
            message: `Refusing autonomous memory write to the ${target} block: the block is not agent-owned (owner=${owner}). User-owned memory is off-limits to autonomous curation. Adopt it first (memory_adopt — the explicit, user-approved ownership transfer), or leave it to the user.`,
        }
    }
}

// Adoption: the explicit ownership transfer (hub#208). Deliberately a
// separate, host-invoked command — never a side effect of a write, so the
// fence can never opt itself in. Entries are untouched; only the flag moves.
function memory_adopt(state: MemoryState, target: string) -> MemoryState {
    match (target) {
        "memory" => {
            MemoryState {
                memory_entries: state.memory_entries,
                user_entries: state.user_entries,
                memory_owner: "agent",
                user_owner: state.user_owner,
            }
        },
        "user" => {
            MemoryState {
                memory_entries: state.memory_entries,
                user_entries: state.user_entries,
                memory_owner: state.memory_owner,
                user_owner: "agent",
            }
        },
        let other => {
            throw baml.errors.InvalidArgument {
                message: `unknown memory target: ${other} (want "memory" or "user")`,
            }
        },
    }
}

// Budget accounting is over the delimiter-joined block, exactly like hermes
// (len(ENTRY_DELIMITER.join(entries))).
function memory_char_count(entries: string[]) -> int {
    entries.join(entry_delimiter()).length()
}

// hermes _usage_pct: "NN% — C/L chars" (no thousands separators — divergence 6).
function memory_usage(limit: int, current: int) -> string {
    let pct = if (limit > 0) {
        current * 100 / limit
    } else {
        0
    };
    let capped = if (pct > 100) {
        100
    } else {
        pct
    };
    `${capped}% — ${current}/${limit} chars`
}

// --- Threat scan (deterministic port of tools/threat_patterns.py) ------------

// Strip punctuation from token edges. Leading "." is kept so ".env"-style
// tokens survive; trailing "." is stripped so sentence ends don't poison
// sequence matching. "$" is never stripped (secret-var arm needs it).
function threat_trim_token(tok: string) -> string {
    let cs = tok.chars();
    let start = 0;
    let end = cs.length();
    let lead = ",;:!?()[]{}\"'`<>*";
    let trail = ",.;:!?()[]{}\"'`<>*";
    while (start < end && lead.includes(cs.at(start) ?? "")) {
        start += 1;
    }
    while (end > start && trail.includes(cs.at(end - 1) ?? "")) {
        end -= 1;
    }
    cs.slice(start, end).join("")
}

// Lowercase whitespace-split tokens, punctuation-trimmed. Stands in for
// hermes' regex \w+ tokenization.
function threat_tokens(lower: string) -> string[] {
    let flat = lower.replace_all("\n", " ").replace_all("\t", " ").replace_all("\r", " ");
    let out: string[] = [];
    for (let raw in flat.split(" ")) {
        let tok = threat_trim_token(raw);
        if (tok.length() > 0) {
            out.push(tok);
        }
    }
    out
}

// Ordered-sequence match with a bounded word gap — the deterministic stand-in
// for hermes' `_FILLER = (?:\w+\s+){0,8}` between key attack words. Each step
// is a set of alternatives; every next step must match a token within `gap`
// words after the previous step's match.
function threat_match_steps(tokens: string[], steps: string[][], gap: int) -> bool {
    let n = tokens.length();
    let first = steps.at(0) ?? [];
    let i = 0;
    while (i < n) {
        if (first.includes(tokens.at(i) ?? "")) {
            let prev = i;
            let si = 1;
            let ok = true;
            while (si < steps.length() && ok) {
                let alts = steps.at(si) ?? [];
                let found = false;
                let j = prev + 1;
                while (j <= prev + gap && j < n && !found) {
                    if (alts.includes(tokens.at(j) ?? "")) {
                        found = true;
                        prev = j;
                    }
                    j += 1;
                }
                if (!found) {
                    ok = false;
                }
                si += 1;
            }
            if (ok) {
                return true;
            }
        }
        i += 1;
    }
    false
}

// hermes _SECRET_VAR: a $-prefixed word ending in KEY/TOKEN/SECRET/PASSWORD/
// CREDENTIAL (optional plural S).
function threat_is_secret_var(tok: string) -> bool {
    if (!tok.starts_with("$")) {
        return false;
    }
    let t = tok.to_upper_case().replace_all("${", "").replace_all("}", "");
    t.ends_with("KEY")
        || t.ends_with("KEYS")
        || t.ends_with("TOKEN")
        || t.ends_with("TOKENS")
        || t.ends_with("SECRET")
        || t.ends_with("SECRETS")
        || t.ends_with("PASSWORD")
        || t.ends_with("PASSWORDS")
        || t.ends_with("CREDENTIAL")
        || t.ends_with("CREDENTIALS")
}

// exfil_curl / exfil_wget: the tool name as a bare token, then a secret-ish
// env var later on the line (hermes bounds to one line; tokens are
// whitespace-split so "later" approximates it — divergence 1).
function threat_exfil_tool(tokens: string[], tool: string) -> bool {
    let i = 0;
    let n = tokens.length();
    while (i < n) {
        if (tokens.at(i) == tool) {
            let j = i + 1;
            while (j < n) {
                if (threat_is_secret_var(tokens.at(j) ?? "")) {
                    return true;
                }
                j += 1;
            }
        }
        i += 1;
    }
    false
}

// env_var_unset_agent: `unset` then a token naming an agent-runtime env var
// (pure attack behavior — Brainworm sub-session bypass).
function threat_unset_agent_var(tokens: string[]) -> bool {
    let markers = ["CLAUDE", "CODEX", "HERMES", "AGENT", "OPENAI", "ANTHROPIC"];
    let i = 0;
    let n = tokens.length();
    while (i < n) {
        if (tokens.at(i) == "unset") {
            let j = i + 1;
            while (j <= i + 3 && j < n) {
                let t = (tokens.at(j) ?? "").to_upper_case();
                let hit = false;
                for (let m in markers) {
                    if (t.includes(m)) {
                        hit = true;
                    }
                }
                if (hit) {
                    return true;
                }
                j += 1;
            }
        }
        i += 1;
    }
    false
}

// hardcoded_secret: key/token/secret/password word, then `=` or `:`, then a
// 20+-char run of the secret charset. Word-boundary check on the needle so
// "monkey" doesn't trip "key". (hermes: (?:api[_-]?key|token|secret|password)
// \s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}; the opening quote is optional here —
// divergence 1.)
function threat_hardcoded_secret(lower: string) -> bool {
    let needles = ["api_key", "apikey", "api-key", "token", "secret", "password"];
    let charset = "abcdefghijklmnopqrstuvwxyz0123456789+/=_-";
    let n = lower.length();
    for (let needle in needles) {
        let from = 0;
        let searching = true;
        while (searching) {
            let off = lower.slice(from, n).index_of(needle);
            if (off == null) {
                searching = false;
            } else {
                let pos = from + (off ?? 0);
                let before_ok = pos == 0 || !(lower.at(pos - 1) ?? " ").is_ascii_alphanumeric();
                if (before_ok) {
                    let i = pos + needle.length();
                    while (i < n && lower.at(i) == " ") {
                        i += 1;
                    }
                    let sep = lower.at(i) ?? "";
                    if (sep == "=" || sep == ":") {
                        i += 1;
                        while (i < n && (lower.at(i) == " " || lower.at(i) == "\"" || lower.at(i) == "'")) {
                            i += 1;
                        }
                        let run = 0;
                        while (i < n && charset.includes(lower.at(i) ?? "")) {
                            i += 1;
                            run += 1;
                        }
                        if (run >= 20) {
                            return true;
                        }
                    }
                }
                from = pos + needle.length();
            }
        }
    }
    false
}

// Invisible / bidirectional codepoints used in injection attacks — hermes
// INVISIBLE_CHARS: ZWSP, ZWNJ, ZWJ, word joiner, invisible times/separator/
// plus, BOM, LTR/RTL embedding + pop + overrides, isolates + pop.
function threat_invisible_codepoints() -> int[] {
    [
        8203,
        8204,
        8205,
        8288,
        8290,
        8291,
        8292,
        65279,
        8234,
        8235,
        8236,
        8237,
        8238,
        8294,
        8295,
        8296,
        8297,
    ]
}

function threat_hex4(cp: int) -> string {
    let digits = "0123456789ABCDEF";
    let d0 = digits.at(cp / 4096 % 16) ?? "0";
    let d1 = digits.at(cp / 256 % 16) ?? "0";
    let d2 = digits.at(cp / 16 % 16) ?? "0";
    let d3 = digits.at(cp % 16) ?? "0";
    `${d0}${d1}${d2}${d3}`
}

// Matched pattern ids in `content`. hermes scans memory writes at
// scope="strict" (cumulative — every pattern fires); this is that full set
// (divergence 3). Invisible codepoints are reported as
// "invisible_unicode_U+XXXX" on the RAW content, before any normalization.
function scan_for_threats(content: string) -> string[] {
    let findings: string[] = [];
    if (content.length() == 0) {
        return findings;
    }
    let capped = if (content.length() > max_scan_chars()) {
        content.slice(0, max_scan_chars())
    } else {
        content
    };
    let invis = threat_invisible_codepoints();
    for (let ch in capped.chars()) {
        let cp = ch.code_point_at(0) ?? 0;
        if (invis.includes(cp)) {
            findings.push(`invisible_unicode_U+${threat_hex4(cp)}`);
        }
    }
    let lower = capped.to_lower_case();
    let tokens = threat_tokens(lower);

    // ── Classic prompt injection ─────────────────────────────────────
    if (
        threat_match_steps(tokens, [["ignore"], ["previous", "all", "above", "prior"], ["instructions"]], 16)
    ) {
        findings.push("prompt_injection");
    }
    if (lower.includes("system prompt override")) {
        findings.push("sys_prompt_override");
    }
    if (
        threat_match_steps(
            tokens,
            [["disregard"], ["your", "all", "any", "the"], ["instructions", "rules", "guidelines"]],
            16,
        )
    ) {
        findings.push("disregard_rules");
    }
    if (
        threat_match_steps(
            tokens,
            [["act"], ["as"], ["if", "though"], ["you"], ["restrictions", "limits", "rules"]],
            16,
        )
    ) {
        findings.push("bypass_restrictions");
    }
    let comment_open = lower.index_of("<!--");
    let comment_close = lower.index_of("-->");
    if (comment_open != null && comment_close != null && (comment_open ?? 0) < (comment_close ?? 0)) {
        let inner = lower.slice(comment_open ?? 0, comment_close ?? 0);
        if (
            inner.includes("ignore")
                || inner.includes("override")
                || inner.includes("system")
                || inner.includes("secret")
                || inner.includes("hidden")
        ) {
            findings.push("html_comment_injection");
        }
    }
    if (lower.includes("<div") && (lower.includes("display:none") || lower.includes("display: none"))) {
        findings.push("hidden_div");
    }
    if (threat_match_steps(tokens, [["translate"], ["into"], ["execute", "run", "eval"]], 24)) {
        findings.push("translate_execute");
    }
    if (threat_match_steps(tokens, [["do"], ["not"], ["tell"], ["the"], ["user"]], 16)) {
        findings.push("deception_hide");
    }

    // ── Role-play / identity hijack ──────────────────────────────────
    if (threat_match_steps(tokens, [["you"], ["are"], ["now"], ["a", "an", "the"]], 16)) {
        findings.push("role_hijack");
    }
    if (threat_match_steps(tokens, [["pretend"], ["you", "to"], ["are", "be"]], 16)) {
        findings.push("role_pretend");
    }
    if (threat_match_steps(tokens, [["output"], ["system", "initial"], ["prompt"]], 16)) {
        findings.push("leak_system_prompt");
    }
    if (
        threat_match_steps(
            tokens,
            [
                ["respond", "answer", "reply"],
                ["without"],
                ["restrictions", "limitations", "filters", "safety"],
            ],
            16,
        )
    ) {
        findings.push("remove_filters");
    }
    if (
        threat_match_steps(tokens, [["you"], ["have"], ["been"], ["updated", "upgraded", "patched"]], 12)
    ) {
        findings.push("fake_update");
    }
    if (threat_match_steps(tokens, [["name"], ["yourself"]], 2)) {
        findings.push("identity_override");
    }

    // ── C2 / promptware ──────────────────────────────────────────────
    if (threat_match_steps(tokens, [["register"], ["node"]], 4)) {
        findings.push("c2_node_registration");
    }
    if (threat_match_steps(tokens, [["heartbeat", "beacon", "check"], ["to", "with", "in"]], 3)) {
        findings.push("c2_heartbeat");
    }
    if (threat_match_steps(tokens, [["pull"], ["task", "tasks", "tasking"]], 4)) {
        findings.push("c2_task_pull");
    }
    if (lower.includes("connect to the network")) {
        findings.push("c2_network_connect");
    }
    if (
        threat_match_steps(tokens, [["you"], ["must"], ["register", "connect", "report", "beacon"]], 6)
    ) {
        findings.push("forced_action");
    }
    if (
        threat_match_steps(tokens, [["only"], ["use"], ["one-liner", "one-liners", "oneliner", "oneliners"]], 4)
    ) {
        findings.push("anti_forensic_oneliner");
    }
    if (threat_match_steps(tokens, [["never"], ["create", "write"], ["script", "file"], ["disk"]], 16)) {
        findings.push("anti_forensic_disk");
    }
    if (threat_unset_agent_var(tokens)) {
        findings.push("env_var_unset_agent");
    }
    if (
        threat_match_steps(tokens, [["cobalt"], ["strike"]], 1)
            || tokens.includes("sliver")
            || tokens.includes("havoc")
            || tokens.includes("mythic")
            || tokens.includes("metasploit")
            || tokens.includes("brainworm")
    ) {
        findings.push("known_c2_framework");
    }
    if (threat_match_steps(tokens, [["c2"], ["server", "channel", "infrastructure", "beacon"]], 2)) {
        findings.push("c2_explicit");
    }
    if (lower.includes("command and control")) {
        findings.push("c2_explicit_long");
    }

    // ── Exfiltration ─────────────────────────────────────────────────
    if (threat_exfil_tool(tokens, "curl")) {
        findings.push("exfil_curl");
    }
    if (threat_exfil_tool(tokens, "wget")) {
        findings.push("exfil_wget");
    }
    if (
        tokens.includes("cat")
            && (
                lower.includes(".env")
                    || lower.includes("credentials")
                    || lower.includes(".netrc")
                    || lower.includes(".pgpass")
                    || lower.includes(".npmrc")
                    || lower.includes(".pypirc")
            )
    ) {
        findings.push("read_secrets");
    }
    let has_url = false;
    for (let t in tokens) {
        if (t.includes("http://") || t.includes("https://")) {
            has_url = true;
        }
    }
    if (
        has_url
            && threat_match_steps(tokens, [["send", "post", "upload", "transmit"], ["to", "at"]], 16)
    ) {
        findings.push("send_to_url");
    }
    if (
        threat_match_steps(
            tokens,
            [["include", "output", "print", "share"], ["conversation", "history", "messages"]],
            16,
        )
            || threat_match_steps(
                tokens,
                [["include", "output", "print", "share"], ["full", "entire"], ["context"]],
                16,
            )
    ) {
        findings.push("context_exfil");
    }

    // ── Persistence / SSH backdoor / agent-config tampering ──────────
    if (lower.includes("authorized_keys")) {
        findings.push("ssh_backdoor");
    }
    if (lower.includes("$home/.ssh") || lower.includes("~/.ssh")) {
        findings.push("ssh_access");
    }
    if (lower.includes("$home/.hermes/.env") || lower.includes("~/.hermes/.env")) {
        findings.push("hermes_env");
    }
    let modify_verbs = ["update", "modify", "edit", "write", "change", "append", "add"];
    if (
        threat_match_steps(tokens, [modify_verbs, ["agents.md", "claude.md", ".cursorrules", ".clinerules"]], 24)
    ) {
        findings.push("agent_config_mod");
    }
    if (threat_match_steps(tokens, [modify_verbs, [".hermes/config.yaml", "soul.md"]], 24)) {
        findings.push("hermes_config_mod");
    }
    // bi namespace arm (divergence 5) — .bi/config is bi's hermes_config_mod.
    if (threat_match_steps(tokens, [modify_verbs, [".bi/config", ".bi/config.toml"]], 24)) {
        findings.push("bi_config_mod");
    }

    // ── Hardcoded secrets ────────────────────────────────────────────
    if (threat_hardcoded_secret(lower)) {
        findings.push("hardcoded_secret");
    }
    findings
}

// hermes first_threat_message: user-facing error for the first threat, null
// when clean.
function first_threat_message(content: string) -> string? {
    let findings = scan_for_threats(content);
    if (findings.length() == 0) {
        return null;
    }
    let pid = findings.at(0) ?? "";
    if (pid.starts_with("invisible_unicode_")) {
        return `Blocked: content contains invisible unicode character ${pid.replace_all("invisible_unicode_", "")} (possible injection).`;
    }
    `Blocked: content matches threat pattern '${pid}'. Content is injected into the system prompt and must not contain injection or exfiltration payloads.`
}

// --- Write policy ------------------------------------------------------------

// hermes _find_unique_match: >=0 is the unique match index, -1 no match,
// -2 ambiguous (distinct entries match; exact-duplicate matches are safe,
// first wins).
function memory_find_unique(entries: string[], old_text: string) -> int {
    let found = -1;
    let found_text = "";
    let ambiguous = false;
    let i = 0;
    while (i < entries.length()) {
        let e = entries.at(i) ?? "";
        if (e.includes(old_text)) {
            if (found == -1) {
                found = i;
                found_text = e;
            } else if (e != found_text) {
                ambiguous = true;
            }
        }
        i += 1;
    }
    if (ambiguous) {
        -2
    } else {
        found
    }
}

function memory_note() -> string {
    "Write saved. This update is complete — do not repeat it."
}

function memory_ok(
    target: string,
    message: string,
    entries: string[],
    limit: int,
    state: MemoryState,
) -> MemoryWriteOk {
    MemoryWriteOk {
        target: target,
        message: message,
        usage_chars: memory_char_count(entries),
        char_limit: limit,
        entry_count: entries.length(),
        state: state,
        note: memory_note(),
    }
}

// Add one entry. Order: validate → threat scan → duplicate → budget. The
// input state is never mutated; the Ok carries a fresh MemoryState.
function memory_add(state: MemoryState, target: string, content: string) -> MemoryWriteResult {
    let entries = memory_entries_for(state, target);
    let limit = memory_target_limit(target);
    let trimmed = content.trim();
    if (trimmed.length() == 0) {
        return MemoryInvalid { target: target, message: "Content cannot be empty." };
    }
    let findings = scan_for_threats(trimmed);
    if (findings.length() > 0) {
        return MemoryThreatBlocked {
            target: target,
            findings: findings,
            message: first_threat_message(trimmed) ?? "Blocked: threat scan failed.",
        };
    }
    if (entries.includes(trimmed)) {
        return MemoryDuplicate {
            target: target,
            content: trimmed,
            message: "Entry already exists — exact duplicates are rejected. Use 'replace' to strengthen the existing entry instead.",
        };
    }
    let next = entries.concat([trimmed]);
    let total = memory_char_count(next);
    if (total > limit) {
        return MemoryOverflow {
            target: target,
            usage_chars: memory_char_count(entries),
            char_limit: limit,
            would_be_chars: total,
            current_entries: entries,
            guidance: `Adding this entry (${trimmed.length()} chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries), then retry this add — all in this turn. Never silently drop content to fit.`,
        };
    }
    memory_ok(target, "Entry added.", next, limit, memory_with_entries(state, target, next))
}

// Replace the unique entry containing old_text with new_content.
function memory_replace(
    state: MemoryState,
    target: string,
    old_text: string,
    new_content: string,
) -> MemoryWriteResult {
    let entries = memory_entries_for(state, target);
    let limit = memory_target_limit(target);
    let old = old_text.trim();
    let content = new_content.trim();
    if (old.length() == 0) {
        return MemoryInvalid { target: target, message: "old_text cannot be empty." };
    }
    if (content.length() == 0) {
        return MemoryInvalid {
            target: target,
            message: "new_content cannot be empty. Use 'remove' to delete entries.",
        };
    }
    let findings = scan_for_threats(content);
    if (findings.length() > 0) {
        return MemoryThreatBlocked {
            target: target,
            findings: findings,
            message: first_threat_message(content) ?? "Blocked: threat scan failed.",
        };
    }
    let idx = memory_find_unique(entries, old);
    if (idx == -2) {
        return MemoryNoMatch {
            target: target,
            old_text: old,
            ambiguous: true,
            current_entries: entries,
            message: `Multiple entries matched '${old}'. Be more specific.`,
        };
    }
    if (idx == -1) {
        return MemoryNoMatch {
            target: target,
            old_text: old,
            ambiguous: false,
            current_entries: entries,
            message: `No entry matched '${old}'. Check current_entries and retry with the exact text of the entry you want to replace.`,
        };
    }
    let next = entries.slice(0, idx).concat([content]).concat(entries.slice(idx + 1, entries.length()));
    let total = memory_char_count(next);
    if (total > limit) {
        return MemoryOverflow {
            target: target,
            usage_chars: memory_char_count(entries),
            char_limit: limit,
            would_be_chars: total,
            current_entries: entries,
            guidance: "Replacement would exceed the limit. Shorten the new content, or 'remove' other stale or less important entries to make room (see current_entries), then retry — all in this turn.",
        };
    }
    memory_ok(target, "Entry replaced.", next, limit, memory_with_entries(state, target, next))
}

// Remove the unique entry containing old_text.
function memory_remove(state: MemoryState, target: string, old_text: string) -> MemoryWriteResult {
    let entries = memory_entries_for(state, target);
    let limit = memory_target_limit(target);
    let old = old_text.trim();
    if (old.length() == 0) {
        return MemoryInvalid { target: target, message: "old_text cannot be empty." };
    }
    let idx = memory_find_unique(entries, old);
    if (idx == -2) {
        return MemoryNoMatch {
            target: target,
            old_text: old,
            ambiguous: true,
            current_entries: entries,
            message: `Multiple entries matched '${old}'. Be more specific.`,
        };
    }
    if (idx == -1) {
        return MemoryNoMatch {
            target: target,
            old_text: old,
            ambiguous: false,
            current_entries: entries,
            message: `No entry matched '${old}'. Check current_entries and retry with the exact text of the entry you want to remove.`,
        };
    }
    let next = entries.slice(0, idx).concat(entries.slice(idx + 1, entries.length()));
    memory_ok(target, "Entry removed.", next, limit, memory_with_entries(state, target, next))
}

// Apply add/replace/remove ops atomically against the FINAL budget — the
// consolidation vehicle: one call frees room AND adds the new entry.
// All-or-nothing: any poisoned, malformed, or unmatched op, or an over-limit
// result, writes NOTHING (the returned failure carries no state).
function memory_apply_batch(
    state: MemoryState,
    target: string,
    ops: MemoryOp[],
) -> MemoryWriteResult {
    let entries = memory_entries_for(state, target);
    let limit = memory_target_limit(target);
    if (ops.length() == 0) {
        return MemoryInvalid { target: target, message: "operations list is empty." };
    }
    // Scan every add/replace content BEFORE touching state — one poisoned op
    // rejects the whole batch (hermes apply_batch).
    let si = 0;
    while (si < ops.length()) {
        if let op: MemoryOp = ops.at(si) {
            if (op.action == "add" || op.action == "replace") {
                let c = (op.content ?? "").trim();
                if (c.length() > 0) {
                    let findings = scan_for_threats(c);
                    if (findings.length() > 0) {
                        return MemoryThreatBlocked {
                            target: target,
                            findings: findings,
                            message: `Operation ${si + 1}: ${first_threat_message(c) ?? "Blocked: threat scan failed."} No operations were applied (batch is all-or-nothing).`,
                        };
                    }
                }
            }
        }
        si += 1;
    }
    let working = entries.concat([]);
    let wi = 0;
    while (wi < ops.length()) {
        if let op: MemoryOp = ops.at(wi) {
            let pos = `Operation ${wi + 1} (${op.action})`;
            let content = (op.content ?? "").trim();
            let old = (op.old_text ?? "").trim();
            if (op.action == "add") {
                if (content.length() == 0) {
                    return MemoryInvalid {
                        target: target,
                        message: `${pos}: content is required. No operations were applied (batch is all-or-nothing).`,
                    };
                }
                if (working.includes(content)) {
                    return MemoryDuplicate {
                        target: target,
                        content: content,
                        message: `${pos}: entry already exists — exact duplicates are rejected. No operations were applied (batch is all-or-nothing).`,
                    };
                }
                working = working.concat([content]);
            } else {
                if (old.length() == 0) {
                    return MemoryInvalid {
                        target: target,
                        message: `${pos}: old_text is required. No operations were applied (batch is all-or-nothing).`,
                    };
                }
                if (op.action == "replace" && content.length() == 0) {
                    return MemoryInvalid {
                        target: target,
                        message: `${pos}: content is required (use action='remove' to delete). No operations were applied (batch is all-or-nothing).`,
                    };
                }
                let idx = memory_find_unique(working, old);
                if (idx == -2) {
                    return MemoryNoMatch {
                        target: target,
                        old_text: old,
                        ambiguous: true,
                        current_entries: entries,
                        message: `${pos}: '${old}' matched multiple distinct entries — be more specific. No operations were applied (batch is all-or-nothing).`,
                    };
                }
                if (idx == -1) {
                    return MemoryNoMatch {
                        target: target,
                        old_text: old,
                        ambiguous: false,
                        current_entries: entries,
                        message: `${pos}: no entry matched '${old}'. No operations were applied (batch is all-or-nothing).`,
                    };
                }
                if (op.action == "replace") {
                    working
                        = working.slice(0, idx).concat([content]).concat(
                            working.slice(idx + 1, working.length()),
                        );
                } else {
                    working = working.slice(0, idx).concat(working.slice(idx + 1, working.length()));
                }
            }
        }
        wi += 1;
    }
    // hermes #103419: a consolidation batch that removes the last entry would
    // commit an empty block as a normal write. Refuse; single remove() is the
    // deliberate-wipe path.
    if (entries.length() > 0 && working.length() == 0) {
        return MemoryInvalid {
            target: target,
            message: "Refusing to empty the block: this batch would remove every entry from a previously non-empty store. Nothing was applied (batch is all-or-nothing). Keep at least one entry — merge overlapping entries into a shorter one instead of removing the last one. To delete the final entry deliberately, use single remove calls.",
        };
    }
    let total = memory_char_count(working);
    if (total > limit) {
        return MemoryOverflow {
            target: target,
            usage_chars: memory_char_count(entries),
            char_limit: limit,
            would_be_chars: total,
            current_entries: entries,
            guidance: `After applying all operations the block would be over the limit. Remove or shorten more entries in the same batch (see current_entries), then retry. Nothing was applied (batch is all-or-nothing).`,
        };
    }
    memory_ok(
        target,
        `Applied ${ops.length()} operation(s).`,
        working,
        limit,
        memory_with_entries(state, target, working),
    )
}

// --- Origin-tagged entry points (hub#208) --------------------------------------
//
// The four functions above are the FOREGROUND path: user-origin, never
// fenced (hermes fences only the autonomous fork — foreground/user-requested
// artifacts are sovereign). Autonomous passes (review-fork approval,
// curator consolidation) route through these *_as variants, which fence on
// the declared origin BEFORE any validation, scan, or budget work — a
// fenced-out write changes nothing and runs nothing.

function memory_add_as(
    state: MemoryState,
    target: string,
    content: string,
    origin: MemoryOwner,
) -> MemoryWriteResult {
    if let refused: MemoryOwnerRefused = memory_check_owner(state, target, origin) {
        return refused;
    }
    memory_add(state, target, content)
}

function memory_replace_as(
    state: MemoryState,
    target: string,
    old_text: string,
    new_content: string,
    origin: MemoryOwner,
) -> MemoryWriteResult {
    if let refused: MemoryOwnerRefused = memory_check_owner(state, target, origin) {
        return refused;
    }
    memory_replace(state, target, old_text, new_content)
}

function memory_remove_as(
    state: MemoryState,
    target: string,
    old_text: string,
    origin: MemoryOwner,
) -> MemoryWriteResult {
    if let refused: MemoryOwnerRefused = memory_check_owner(state, target, origin) {
        return refused;
    }
    memory_remove(state, target, old_text)
}

function memory_apply_batch_as(
    state: MemoryState,
    target: string,
    ops: MemoryOp[],
    origin: MemoryOwner,
) -> MemoryWriteResult {
    if let refused: MemoryOwnerRefused = memory_check_owner(state, target, origin) {
        return refused;
    }
    memory_apply_batch(state, target, ops)
}

// --- Persistence + frozen snapshot -------------------------------------------

// On-disk shape: entries joined by the delimiter (hermes flushes the same).
function serialize_entries(entries: string[]) -> string {
    entries.join(entry_delimiter())
}

// Parse a delimiter-joined block back into entries (trim, drop empties).
function parse_entries(raw: string) -> string[] {
    let out: string[] = [];
    for (let piece in raw.split(entry_delimiter())) {
        let e = piece.trim();
        if (e.length() > 0) {
            out.push(e);
        }
    }
    out
}

// hermes _render_block: header + usage indicator + delimiter-joined entries
// ("" when empty).
function render_memory_block(target: string, entries: string[]) -> string {
    if (entries.length() == 0) {
        return "";
    }
    let sep = "═".repeat(46);
    let title = if (target == "user") {
        "USER PROFILE (who the user is)"
    } else {
        "MEMORY (your personal notes)"
    };
    let content = entries.join(entry_delimiter());
    let usage = memory_usage(memory_target_limit(target), content.length());
    `${sep}\n${title} [${usage}]\n${sep}\n${content}`
}

// Capture the frozen snapshot at session start. This — not live state — is
// what the host injects into the system prompt, so mid-session writes never
// perturb the prefix cache; they appear in NEXT session's snapshot.
function freeze_snapshot(state: MemoryState, session: string) -> FrozenMemorySnapshot {
    FrozenMemorySnapshot {
        session: session,
        memory_block: render_memory_block("memory", state.memory_entries),
        user_block: render_memory_block("user", state.user_entries),
    }
}

// The exact text the host splices into the session-start prompt ("" when
// both blocks are empty — hermes injects nothing in that case).
function snapshot_prompt_block(snap: FrozenMemorySnapshot) -> string {
    let parts: string[] = [];
    if (snap.memory_block.length() > 0) {
        parts.push(snap.memory_block);
    }
    if (snap.user_block.length() > 0) {
        parts.push(snap.user_block);
    }
    parts.join("\n\n")
}
