testset "auth credential policy (bi#18)" {
    test "valid api_key credential validates" {
        let c = Credential {
            provider_id: "groq",
            type: "api_key",
            key: "gsk-test",
            refresh: null,
            access: null,
            expires: null,
            account_id: null,
        };
        assert.is_true(ValidateCredential(c))
    }

    test "valid oauth credential validates" {
        let c = Credential {
            provider_id: "xai",
            type: "oauth",
            key: null,
            refresh: "r-test",
            access: "a-test",
            expires: 1780000000000,
            account_id: null,
        };
        assert.is_true(ValidateCredential(c))
    }

    test "unknown provider never validates" {
        let c = Credential {
            provider_id: "bogus",
            type: "api_key",
            key: "k",
            refresh: null,
            access: null,
            expires: null,
            account_id: null,
        };
        assert.is_true(!ValidateCredential(c))
    }

    test "wrong type tag never validates" {
        let c = Credential {
            provider_id: "groq",
            type: "bearer",
            key: "k",
            refresh: null,
            access: null,
            expires: null,
            account_id: null,
        };
        assert.is_true(!ValidateCredential(c))
    }

    test "api_key without key never validates" {
        let c = Credential {
            provider_id: "groq",
            type: "api_key",
            key: null,
            refresh: null,
            access: null,
            expires: null,
            account_id: null,
        };
        assert.is_true(!ValidateCredential(c))
    }

    test "oauth without refresh never validates" {
        let c = Credential {
            provider_id: "xai",
            type: "oauth",
            key: null,
            refresh: null,
            access: "a-test",
            expires: null,
            account_id: null,
        };
        assert.is_true(!ValidateCredential(c))
    }

    test "RedactKey keeps first-3 and last-4" {
        assert.equal(RedactKey("sk-ant-abcdef123456"), "sk-...3456")
    }

    test "RedactKey collapses short keys" {
        assert.equal(RedactKey("12345678"), "***");
        assert.equal(RedactKey(""), "***")
    }

    test "CredentialStatusLine never carries secrets" {
        let info = CredentialInfo { provider_id: "groq", type: "api_key" };
        assert.equal(CredentialStatusLine(info, true), "groq (api_key): set");
        assert.equal(CredentialStatusLine(info, false), "groq (api_key): missing secret")
    }

    test "ResolveAuth override beats stored beats env" {
        let d = ResolveAuth("groq", "flag-key", "stored-key", true);
        assert.equal(d.source, "override");
        assert.equal(d.key, "flag-key")
    }

    test "ResolveAuth stored owns the provider over env" {
        let d = ResolveAuth("groq", null, "stored-key", true);
        assert.equal(d.source, "stored");
        assert.equal(d.key, "stored-key")
    }

    test "ResolveAuth env only when nothing stored" {
        let d = ResolveAuth("groq", null, null, true);
        assert.equal(d.source, "env");
        assert.is_true(d.key is null)
    }

    test "ResolveAuth none when nothing anywhere" {
        let d = ResolveAuth("groq", null, null, false);
        assert.equal(d.source, "none");
        assert.is_true(d.key is null)
    }

    test "ResolveAuth none for unknown provider despite env presence" {
        // has_env is host-observed; the catalog recheck keeps an unknown
        // id from resolving to "env" (never a misleading source).
        let d = ResolveAuth("bogus", null, null, true);
        assert.equal(d.source, "none");
        assert.is_true(d.key is null)
    }

    test "SupportsOAuth names the bi#23/24 flow providers" {
        assert.is_true(SupportsOAuth("anthropic"));
        assert.is_true(SupportsOAuth("xai"));
        assert.is_true(SupportsOAuth("kimi-coding"));
        assert.is_true(!SupportsOAuth("groq"));
        assert.is_true(!SupportsOAuth("openai"));
        assert.is_true(!SupportsOAuth("bogus"))
    }

    test "GuidanceFor invalid_argument names var and login" {
        let g = GuidanceFor("invalid_argument", "groq");
        assert.is_true(g.includes("GROQ_API_KEY"));
        assert.is_true(g.includes("bi login groq"));
        // No OAuth note for key-only providers.
        assert.is_true(g.includes("OAuth") == false)
    }

    test "GuidanceFor invalid_argument adds OAuth note for flow providers" {
        let g = GuidanceFor("invalid_argument", "xai");
        assert.is_true(g.includes("XAI_API_KEY"));
        assert.is_true(g.includes("bi login xai"));
        assert.is_true(g.includes("bi#22"))
    }

    test "GuidanceFor invalid_argument points unknown providers at the catalog" {
        let g = GuidanceFor("invalid_argument", "bogus");
        assert.is_true(g.includes("unknown provider"));
        assert.is_true(g.includes("bi list-providers"))
    }

    test "GuidanceFor covers rate_limited, network, invalid_request" {
        assert.is_true(GuidanceFor("rate_limited", "groq").includes("retries"));
        assert.is_true(GuidanceFor("network", "groq").includes("BI_BASE_URL"));
        assert.is_true(
            GuidanceFor("invalid_request", "groq").includes("bi list-models --provider groq"),
        )
    }

    test "GuidanceFor stays silent where bi has no fix" {
        assert.equal(GuidanceFor("tool_failed", "groq"), "");
        assert.equal(GuidanceFor("step_budget_exceeded", "groq"), "");
        assert.equal(GuidanceFor("other", "groq"), "")
    }

    test "BuildAuthorizeUrl assembles the canonical PKCE shape" {
        assert.equal(
            BuildAuthorizeUrl(
                "https://idp.example/authorize",
                "cid",
                "http%3A%2F%2Flocalhost%3A9999%2Fcallback",
                "a%20b",
                "CH",
                "ST",
            ),
            "https://idp.example/authorize?code=true&client_id=cid&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback&scope=a%20b&code_challenge=CH&code_challenge_method=S256&state=ST",
        )
    }

    test "TokenExpiry subtracts the five-minute skew" {
        assert.equal(TokenExpiry(3600, 1000000000000), 1000000000000 + 3600000 - 300000)
    }

    test "TokenExpiry honors an explicit skew (codex uses none)" {
        assert.equal(TokenExpiry(3600, 1000000000000, skew_ms = 0), 1000000000000 + 3600000)
    }

    test "OAuthNeedsRefresh honors the validity window" {
        // Healthy token: expiry far out.
        assert.is_true(!OAuthNeedsRefresh(1000000000000 + 3600000 - 300000, 1000000000000));
        // Expiring within the window refreshes.
        assert.is_true(OAuthNeedsRefresh(1000000000000 + 60000, 1000000000000));
        // Already expired refreshes.
        assert.is_true(OAuthNeedsRefresh(999999999999, 1000000000000));
        // Unknown expiry refreshes rather than risking a dead token.
        assert.is_true(OAuthNeedsRefresh(null, 1000000000000));
        // Custom window respected (default is 300000).
        assert.is_true(
            !OAuthNeedsRefresh(1000000000000 + 60000, 1000000000000, min_validity_ms = 10000),
        )
    }
}
