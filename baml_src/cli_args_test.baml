testset "cli_args" {
    test "is_valid_thinking_level" {
        assert.is_true(is_valid_thinking_level("off"));
        assert.is_true(is_valid_thinking_level("high"));
        assert.is_true(is_valid_thinking_level("max"));
        assert.is_true(!is_valid_thinking_level("ultra"));
        assert.is_true(!is_valid_thinking_level(""));
    }

    test "parse provider and model" {
        let a = parse_args(["--provider", "openai", "--model", "gpt-4o"]);
        assert.equal(a.provider, "openai");
        assert.equal(a.model, "gpt-4o");
    }

    test "parse thinking valid" {
        let a = parse_args(["--thinking", "high"]);
        assert.equal(a.thinking, ThinkingLevel.High);
        assert.equal(a.diagnostics.length(), 0);
    }

    test "parse thinking invalid pushes warning" {
        let a = parse_args(["--thinking", "ultra"]);
        assert.is_true(a.thinking == null);
        assert.is_true(a.diagnostics.length() > 0);
        assert.equal(a.diagnostics[0].type, "warning");
    }

    test "parse help and version" {
        let h = parse_args(["--help"]);
        assert.is_true(h.help == true);
        let v = parse_args(["-v"]);
        assert.is_true(v.version == true);
    }

    test "parse mode" {
        let j = parse_args(["--mode", "json"]);
        assert.equal(j.mode, Mode.Json);
        let r = parse_args(["--mode", "rpc"]);
        assert.equal(r.mode, Mode.Rpc);
    }

    test "parse tools allowlist" {
        let a = parse_args(["--tools", "read, bash, edit"]);
        assert.equal(a.tools, ["read", "bash", "edit"]);
    }

    test "parse exclude_tools" {
        let a = parse_args(["--exclude-tools", "ask_question"]);
        assert.equal(a.exclude_tools, ["ask_question"]);
    }

    test "parse no_tools" {
        let a = parse_args(["--no-tools"]);
        assert.is_true(a.no_tools == true);
    }

    test "parse print with message" {
        let a = parse_args(["-p", "hello world"]);
        assert.is_true(a.print == true);
        assert.equal(a.messages, ["hello world"]);
    }

    test "parse file_args with @" {
        let a = parse_args(["@prompt.md", "hello"]);
        assert.equal(a.file_args, ["prompt.md"]);
        assert.equal(a.messages, ["hello"]);
    }

    test "parse -- separator" {
        let a = parse_args(["--", "@file.txt", "msg"]);
        assert.equal(a.file_args, ["file.txt"]);
        assert.equal(a.messages, ["msg"]);
    }

    test "parse unknown flag with = and value" {
        let a = parse_args(["--plan", "--foo=bar", "--custom", "val"]);
        assert.equal(a.unknown_flags.get("plan"), "true");
        assert.equal(a.unknown_flags.get("foo"), "bar");
        assert.equal(a.unknown_flags.get("custom"), "val");
    }

    test "parse list_models without search" {
        let a = parse_args(["--list-models"]);
        assert.equal(a.list_models, "true");
    }

    test "parse list_models with search" {
        let a = parse_args(["--list-models", "sonnet"]);
        assert.equal(a.list_models, "sonnet");
    }

    test "parse tui_mode" {
        let a = parse_args(["--tui-mode", "fullscreen"]);
        assert.equal(a.tui_mode, TuiMode.Fullscreen);
        let b = parse_args(["--tui-mode", "regular"]);
        assert.equal(b.tui_mode, TuiMode.Regular);
    }

    test "parse continue and resume" {
        let a = parse_args(["--continue"]);
        assert.is_true(a.cont == true);
        let b = parse_args(["-r"]);
        assert.is_true(b.resume == true);
    }

    test "normalize_session_name" {
        assert.equal(normalize_session_name("  hello  "), "hello");
        assert.is_true(normalize_session_name("   ") == null);
        assert.is_true(normalize_session_name("") == null);
    }

    test "app_name is bi" {
        assert.equal(app_name(), "bi");
        assert.equal(config_dir_name(), ".bi");
        assert.contains(format_help(), "bi - AI coding assistant");
        assert.is_true(!format_help().includes("pi - AI coding assistant"));
    }
}
