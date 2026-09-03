// Auth credential store policy — pi `packages/ai/src/auth/types.ts` (store
// half) + `credential-store.ts` + coding-agent `AuthStorage`, minus file IO.
//
// Split: BAML owns the shapes and the pure policy (which credential is
// valid, how a key redacts, how a status line reads). The host
// (src/auth.ts) owns ~/.bi/auth.json persistence and the serialized
// read-modify-write. Secrets cross the VM boundary only as plain string
// fields on a CONCRETE class — no class unions (bi#03: union interface
// arms don't decode; concrete classes do).

class Credential {
    provider_id: string,
    type: string @description("\"api_key\" | \"oauth\""),
    key: string?,
    refresh: string?,
    access: string?,
    expires: int? @description("OAuth access-token expiry, epoch millis"),
}

// Non-secret metadata for account/status enumeration (bi#20 `bi auth
// status`). Never carries key material — the host builds these by
// dropping the secret fields.
class CredentialInfo {
    provider_id: string,
    type: string,
}

// A stored credential is usable when its provider is known, its type tag
// is one pi stores, and it carries the secret that type needs.
function ValidateCredential(c: Credential) -> bool {
    if (!ProviderExists(c.provider_id)) {
        false
    } else if (c.type == "api_key") {
        c.key is null == false
    } else if (c.type == "oauth") {
        c.refresh is null == false
    } else {
        false
    }
}

// Last-4 redaction for display. Short keys collapse to "***" so no
// length oracle leaks beyond "short".
function RedactKey(key: string) -> string {
    if (key.length() <= 8) {
        "***"
    } else {
        key.slice(0, 3) + "..." + key.slice(key.length() - 4, key.length())
    }
}

// One `bi auth status` row: identity + type + presence, never the secret.
function CredentialStatusLine(info: CredentialInfo, has_secret: bool) -> string {
    let state = if (has_secret) {
        "set"
    } else {
        "missing secret"
    };
    `${info.provider_id} (${info.type}): ${state}`
}

// bi#19: auth resolution (pi `auth/resolve.ts` precedence, minus refresh).
// A stored credential OWNS the provider: ambient/env is consulted only
// when nothing is stored, and there is no silent env fallback for a
// credential type without a matching handler. The host supplies the
// inputs (explicit flag, stored secret from ~/.bi/auth.json, canonical
// env-var PRESENCE only — never the value) and executes the decision by
// passing `key` as SendTurn's api_key slot; a null key with source "env"
// stays late-bound via baml.env.ref in resolve_credential (turn.baml).
class AuthDecision {
    source: string @description("\"override\" | \"stored\" | \"env\" | \"none\""),
    key: string?,
}

// bi#20: catalog providers whose pi counterpart also offers OAuth.
// `bi login --oauth` (bi#22 core) and per-provider flows (bi#23 for
// anthropic, bi#24 for xai/kimi-coding) build on this predicate; the
// API-key path stays valid for all three meanwhile.
function SupportsOAuth(provider: string) -> bool {
    provider == "anthropic" || provider == "xai" || provider == "kimi-coding"
}

function ResolveAuth(
    provider: string,
    override_key: string?,
    stored_key: string?,
    has_env: bool,
) -> AuthDecision {
    match (override_key) {
        let k: string => AuthDecision { source: "override", key: k },
        null => match (stored_key) {
            let k: string => AuthDecision { source: "stored", key: k },
            null => {
                if (has_env && ProviderAuthEnv(provider) is null == false) {
                    AuthDecision { source: "env", key: null }
                } else {
                    AuthDecision { source: "none", key: null }
                }
            },
        },
    }
}
