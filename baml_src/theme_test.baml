// bi/baml_src/theme_test.baml — chrome palette token pins (bi#185).
// Builtin-role and custom-theme-file tests stay inline in theme.baml;
// these pin the chrome token schema + defaults on literals.

testset "chrome palette (bi#185)" {
    test "dark palette is kimi's five tokens, hex only" {
        match (chrome_palette("dark")) {
            null => assert.is_true(false),
            let p: ChromePalette => {
                assert.equal(p.text, "#E0E0E0");
                assert.equal(p.text_dim, "#9B4F96");
                assert.equal(p.text_muted, "#6B6B6B");
                assert.equal(p.primary, "#D60270");
                assert.equal(p.border, "#0038A8")
            },
        }
        assert.is_true(chrome_palette("bogus") is null)
    }

    test "levels map to tokens, unknown degrades to text" {
        assert.equal(chrome_token_for_level("title"), "text");
        assert.equal(chrome_token_for_level("label"), "text");
        assert.equal(chrome_token_for_level("dim"), "text_dim");
        assert.equal(chrome_token_for_level("hint"), "text_muted");
        assert.equal(chrome_token_for_level("muted"), "text_muted");
        assert.equal(chrome_token_for_level("accent"), "primary");
        assert.equal(chrome_token_for_level("border"), "border");
        assert.equal(chrome_token_for_level("bogus-level"), "text")
    }

    test "dark defaults validate clean" {
        match (chrome_palette("dark")) {
            null => assert.is_true(false),
            let p: ChromePalette => {
                assert.equal(
                    validate_chrome_tokens(p.text, p.text_dim, p.text_muted, p.primary, p.border),
                    [],
                )
            },
        }
    }

    test "hex-tokens-only rule refuses named colors and empties, naming the token" {
        let reasons = validate_chrome_tokens("#E0E0E0", "gray", "#6B6B6B", "", "#5A5A5A");
        assert.equal(reasons.length(), 2);
        assert.contains(reasons.at(0) ?? "", "text_dim:");
        assert.contains(reasons.at(0) ?? "", "gray");
        assert.contains(reasons.at(1) ?? "", "primary:")
    }
}
