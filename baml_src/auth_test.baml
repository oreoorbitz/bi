testset "auth credential policy (bi#18)" {
    test "valid api_key credential validates" {
        let c = Credential {
            provider_id: "groq",
            type: "api_key",
            key: "gsk-test",
            refresh: null,
            access: null,
            expires: null,
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
}
