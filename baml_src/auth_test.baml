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
}
