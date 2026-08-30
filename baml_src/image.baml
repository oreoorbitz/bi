// Image generation via openai.ImageClient — distinct from history Media blocks.
// Pi uses openai/gpt-image-1 via pi/packages/ai/src/images.ts; this is the
// BAML port's minimal vertical: prompt -> ModelTurn with Media blocks.

function GenerateImage(
    prompt: string,
    model: string = "gpt-image-1",
    api_key: string? = null,
    base_url: string? = null,
    n: int? = null,
    size: string? = null,
) -> ai.ModelTurn | TurnFailure {
    let c = openai.ImageClient.new(
        model = model,
        api_key = api_key,
        base_url = base_url,
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
