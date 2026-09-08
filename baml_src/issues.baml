// bi/baml_src/issues.baml — /issues REPL chrome over BAIS.
//
// BAML owns row + context shaping; the host owns the fast header scan
// (readdir + line scan, zero VM calls) and single-file validation.
// Listing never pays per-file BAML parses — that is the whole point of
// the file-per-issue layout: the list is O(bytes), the deep read is O(1).

// One select-frame row: `3  bi#79 [Open/Feat] Staged issue context…`.
// Blocked rows name their blockers so the pick is informed.
function format_issue_row(
    n: int,
    id: string,
    status: string,
    kind: string,
    title: string,
    blocked_by: string[],
) -> string {
    let head = `${n}  ${id} [${status}/${kind}] ${truncate_chars(title, 60)}`;
    if (blocked_by.length() == 0) {
        head
    } else {
        `${head} (blocked by ${blocked_by.join(", ")})`
    }
}

// Staged-issue context injected above the prompt each turn. Full body
// (capped), the issue's own edges, and one-line neighbor titles so the
// agent sees the graph position without a backlog-wide load.
function format_issue_context(
    id: string,
    title: string,
    status: string,
    kind: string,
    area: string?,
    body: string,
    max_body: int,
    edge_from: string[],
    edge_to: string[],
    edge_kind: string[],
    neighbor_ids: string[],
    neighbor_titles: string[],
    neighbor_statuses: string[],
) -> string {
    let where = match (area) {
        null => "",
        let a: string => ` (${a})`,
    };
    let cut = if (body.length() > max_body) {
        `${body.slice(0, max_body)}\n[… body capped at ${max_body} chars]`
    } else {
        body
    };
    let edges = "";
    for (let i = 0; i < edge_from.length(); i += 1) {
        let f = edge_from.at(i) ?? "";
        let t = edge_to.at(i) ?? "";
        let k = edge_kind.at(i) ?? "";
        edges = `${edges}\n- ${f} ${k} ${t}`
    }
    let neighbors = "";
    for (let i = 0; i < neighbor_ids.length(); i += 1) {
        let nid = neighbor_ids.at(i) ?? "";
        let nt = neighbor_titles.at(i) ?? "";
        let ns = neighbor_statuses.at(i) ?? "";
        neighbors = `${neighbors}\n- ${nid} [${ns}] ${nt}`
    }
    `## ${id} [${status}/${kind}]${where}: ${title}\n${cut}\n### edges${edges}\n### neighbors${neighbors}`
}

// --- Progressive disclosure (hub#206) -------------------------------------
// hermes' two-level pattern (hermes-agent/agent/prompt_builder.py:1191-1219
// + skill_utils.py:716,728): the prompt carries a compact INDEX — one
// bounded line per entry — and full bodies load on demand as tool results,
// never by rebuilding the prompt mid-conversation. BAML owns the index
// render (same precedent as format_issue_context above) so the block shape
// is byte-stable: a pure function of the entry list, sorted so host
// enumeration order can never leak into the prompt.

// One skills-index line: name + trigger description, truncated on render.
class SkillIndexEntry {
    name: string,
    description: string,
}

// One BAIS-index line: id + status/kind + title, truncated on render.
class IssueIndexEntry {
    id: string,
    status: string,
    kind: string,
    title: string,
}

// hermes SKILL_PROMPT_DESC_LIMIT=60 exactly: a description longer than 60
// chars renders as its first 57 chars + "..." (total exactly 60); anything
// at or under 60 passes through untouched.
function truncate_index_description(description: string) -> string {
    if (description.length() > 60) {
        `${description.slice(0, 57)}...`
    } else {
        description
    }
}

// Compact skills index for the system prompt. Empty registry → "" (the host
// omits the block entirely, never injects an empty section). Lines are
// sorted by name, and each line is bounded (name ≤64 per the Agent Skills
// spec + description ≤60) so index cost scales linearly with entry count.
// Bodies load via the skill_view tool result — never by prompt mutation.
function format_skill_index(entries: SkillIndexEntry[]) -> string {
    if (entries.length() == 0) {
        ""
    } else {
        entries.sort_by_key((e) -> {
            e.name
        });
        let lines = "";
        for (let e in entries) {
            lines = `${lines}\n- ${e.name}: ${truncate_index_description(e.description)}`
        }
        `## Skills index\nLoad a skill's full body with the skill_view tool before following it — bodies arrive as tool results, never as prompt rebuilds.${lines}`
    }
}

// Compact BAIS index (the session-stable inventory). Empty → "" for the
// same reason. One bounded line per issue (id + status/kind + title ≤60);
// bodies stay behind the bais tools as tool results, so the injected block
// never grows with body size and never needs mid-session mutation.
function format_issue_index(entries: IssueIndexEntry[]) -> string {
    if (entries.length() == 0) {
        ""
    } else {
        entries.sort_by_key((e) -> {
            e.id
        });
        let lines = "";
        for (let e in entries) {
            lines
                = `${lines}\n- ${e.id} [${e.status}/${e.kind}] ${truncate_index_description(e.title)}`
        }
        `## BAIS index\nLoad an issue's full body with the bais tools before acting on it — bodies arrive as tool results, never as prompt rebuilds.${lines}`
    }
}
