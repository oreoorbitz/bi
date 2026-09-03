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
