// bi/baml_src/login_dialog.baml — in-REPL login dialog text shaping (bi#94).
//
// Port of pi's LoginDialogComponent content
// (packages/coding-agent/src/modes/interactive/components/login-dialog.ts):
// browser-open hint, device-code block, waiting/progress lines, cancel and
// success terminal messages. Bi's line REPL has no persistent widget tree,
// so the "dialog" is a printed frame (host-owned chrome via prompt.ts
// DynamicBorder) with BAML-shaped rows inside — same split as the /oauth
// board (auth.baml format_oauth_status) and the countdown labels
// (countdown.baml). The host (src/login_dialog.ts) owns effects: printing,
// CountdownTimer expiry, askText/readline prompting, abort.
//
// Neighbor links: title shape mirrors pi's `Login to ${providerName}`;
// the row hint reuses the /oauth board's 1-based numbering (bi#102) so the
// dialog names the exact deep-link that reopens its provider's flow.

function login_dialog_title(provider_name: string) -> string {
    `Login to ${provider_name}`
}

// Browser-open block for authorize-URL flows (pi showAuth): the URL on
// its own line plus the platform click hint the host fills in.
function login_auth_url_block(url: string, click_hint: string) -> string {
    `Complete login in your browser:\n${url}\n${click_hint} to open`
}

// Device-code block (pi showDeviceCode): verification URI plus the code
// the user types at it. Expiry itself renders through the shared
// countdown primitive (countdown_title over "Waiting for authentication").
function login_device_block(verification_uri: string, user_code: string) -> string {
    `Enter this code at ${verification_uri}:\n  ${user_code}`
}

function login_waiting_line() -> string {
    "Waiting for authentication..."
}

// Deep-link back to the /oauth board row this dialog-space login belongs
// to (bi#102 numbering, 1-based). Shown in the dialog frame so an
// interrupted login names its own resume path.
function login_row_hint(provider_id: string, row_n: int) -> string {
    `/oauth ${row_n} — ${provider_id}`
}

// Pre-flight notice when the stored OAuth credential is already past the
// turn loop's refresh window (same OAuthNeedsRefresh policy as the board's
// stale flag): the dialog is refreshing, not first-logging-in.
function login_expired_notice(provider_id: string, row_n: int) -> string {
    `Stored credential for ${provider_id} expired — refreshing (see ${login_row_hint(provider_id, row_n)})`
}

function login_progress_line(message: string) -> string {
    message
}

function login_cancelled_line(provider_name: string) -> string {
    `Login to ${provider_name} cancelled — nothing stored, session unchanged.`
}

function login_success_line(provider_name: string) -> string {
    `Logged in to ${provider_name}.`
}
