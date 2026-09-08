// Image generation via openai.ImageClient — distinct from history Media blocks.
// Pi fronts this with an image-models registry (provider -> models,
// data-generated); bi keeps an advisory catalog of stable public OpenAI
// image models. openrouter-images (custom data-URL client in pi) is
// deferred — see bi#17.

class ImageModel {
    id: string,
    name: string,
    provider: string,
    base_url: string,
}

function _image_models() -> ImageModel[] {
    [
        ImageModel {
            id: "gpt-image-1",
            name: "GPT Image 1 (OpenAI)",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
        },
        ImageModel {
            id: "gpt-image-1-mini",
            name: "GPT Image 1 mini (OpenAI)",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
        },
    ]
}

function ListImageModels(provider: string?) -> ImageModel[] {
    let out: ImageModel[] = [];
    for (let m in _image_models()) {
        if (provider is null || m.provider == provider) {
            out.push(m)
        }
    }
    out
}

function GetImageModel(id: string) -> ImageModel? {
    for (let m in _image_models()) {
        if (m.id == id) {
            return m;
        }
    }
    null
}

function GenerateImage(
    prompt: string,
    model: string = "gpt-image-1",
    api_key: string? = null,
    base_url: string? = null,
    n: int? = null,
    size: string? = null,
) -> ai.ModelTurn | TurnFailure {
    let resolved = match (GetImageModel(model)) {
        null => {
            throw baml.errors.InvalidArgument {
                message: `unknown image model: ${model} (ListImageModels lists known ids)`,
            }
        },
        let m: ImageModel => m,
    };
    let c = openai.ImageClient.new(
        model = resolved.id,
        api_key = api_key,
        base_url = base_url ?? resolved.base_url,
        n = n,
        size = size,
    );
    let spec = TurnPrompt@spec(prompt);
    c.invoke(
        ai.ModelTurnInput {
            prompt: spec.prompt_template,
            journal: ai.Journal { log: [] },
            toolbox: build_toolbox([]),
            output_type: spec.output_type(),
        },
    ) catch (e) {
        let f: ai.errors.Failure => classify_failure(f),
    }
}

// bi#32 paste policy — the clipboard formats bi accepts without
// transcoding (pi converts BMP/TIFF via Photon; bi has no WASM dep, so
// unsupported bytes are rejected). Mirrors sniffImageMime in
// src/clipboard.ts: the host sniffs magic bytes, BAML owns the
// allowlist + staged-file extension so both stay in one place.
function paste_supported_mimes() -> string[] {
    ["image/png", "image/jpeg", "image/webp", "image/gif"]
}

function paste_mime_supported(mime: string) -> bool {
    let hit = false;
    for (let m in paste_supported_mimes()) {
        if (m == mime) {
            hit = true
        }
    }
    hit
}

function paste_extension(mime: string) -> string? {
    if (mime == "image/png") {
        "png"
    } else if (mime == "image/jpeg") {
        "jpg"
    } else if (mime == "image/webp") {
        "webp"
    } else if (mime == "image/gif") {
        "gif"
    } else {
        null
    }
}

// bi#70 transcript echo — the label shown for a staged image part.
// BAML owns text shaping (the host owns detection + emission in
// src/image-display.ts): basename of the staged path so the placeholder
// stays short and never leaks directory prefixes. Last non-empty
// slash-segment wins, so trailing slashes and empty paths degrade to "".
function staged_image_label(path: string) -> string {
    let label = "";
    for (let p in path.split("/")) {
        if (p.length() > 0) {
            label = p
        }
    }
    label
}
