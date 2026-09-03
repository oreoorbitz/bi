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
