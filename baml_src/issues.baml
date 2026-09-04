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
