testset "image generation" {
    test "GenerateImage closed-port classifies as TurnFailure" {
        let result = GenerateImage("a cute cat", model = "gpt-image-1", api_key = "test-key", base_url = "http://127.0.0.1:1");
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => {
                assert.equal(f.kind, "network");
                assert.is_true(f.retry_safe)
            },
            _ => assert.is_true(false),
        }
    }

    test "GenerateImage with size param still reaches wire" {
        let result = GenerateImage(
            "a sunset",
            model = "gpt-image-1",
            api_key = "test-key",
            base_url = "http://127.0.0.1:1",
            size = "1024x1024",
        );
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.equal(f.kind, "network"),
            _ => assert.is_true(false),
        }
    }

    test "GenerateImage default model reaches wire" {
        let result = GenerateImage("hello", api_key = "test-key", base_url = "http://127.0.0.1:1");
        assert.is_true(result is TurnFailure);
        match (result) {
            let f: TurnFailure => assert.is_true(f.retry_safe),
            _ => assert.is_true(false),
        }
    }

    test "ListImageModels returns the advisory catalog" {
        assert.equal(ListImageModels(null).length(), 2);
        assert.equal(ListImageModels("openai").length(), 2);
        assert.equal(ListImageModels("nope").length(), 0);
        match (GetImageModel("gpt-image-1")) {
            let m: ImageModel => assert.equal(m.base_url, "https://api.openai.com/v1"),
            _ => assert.is_true(false),
        }
        assert.is_true(GetImageModel("dall-e-9") is null);
    }

    test "GenerateImage unknown model fails fast naming the id" {
        GenerateImage("hi", model = "dall-e-9", api_key = "test-key") catch (e) {
            baml.errors.InvalidArgument => {
                assert.is_true(e.message.includes("dall-e-9"))
            },
        }
    }

    test "paste allowlist mirrors the host sniff set" {
        assert.equal(paste_supported_mimes().length(), 4);
        assert.is_true(paste_mime_supported("image/png"));
        assert.is_true(paste_mime_supported("image/jpeg"));
        assert.is_true(paste_mime_supported("image/webp"));
        assert.is_true(paste_mime_supported("image/gif"));
        assert.is_true(!paste_mime_supported("image/bmp"));
        assert.is_true(!paste_mime_supported("image/tiff"));
        assert.is_true(!paste_mime_supported("text/plain"))
    }

    test "paste extensions map one to one" {
        assert.equal(paste_extension("image/png"), "png");
        assert.equal(paste_extension("image/jpeg"), "jpg");
        assert.equal(paste_extension("image/webp"), "webp");
        assert.equal(paste_extension("image/gif"), "gif");
        assert.is_true(paste_extension("image/bmp") is null)
    }

    test "staged image label is the basename" {
        assert.equal(staged_image_label("/tmp/paste-123.png"), "paste-123.png");
        assert.equal(staged_image_label("cat.png"), "cat.png");
        assert.equal(staged_image_label("/tmp/dir/"), "dir");
        assert.equal(staged_image_label(""), "");
        assert.equal(staged_image_label("/"), "")
    }
}
