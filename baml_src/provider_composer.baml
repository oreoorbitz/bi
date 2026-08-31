// bi/baml_src/provider_composer.baml — provider composition, ported from
// pi/packages/coding-agent/src/core/provider-composer.ts (572 lines) +
// its caller model-runtime.ts (787 lines, subset). Vendor specs:
// bi/vendor/pi-provider-composer.ts + pi-model-runtime.ts (pi 0.84.3).
// BAML owns pure composition (base + extension + models.json overlay) and
// thinking/temperature passthrough. Host owns creds/network. Pure, so
// one-test→one-impl offline without API keys.

class ProviderComposerModelCost {
    input: float,
    output: float,
}

class ComposedModel {
    id: string,
    name: string,
    api: string,
    provider: string,
    base_url: string,
    reasoning: bool,
    context_window: int,
    max_tokens: int,
    headers: map<string, string>?,
}

class ComposedProvider {
    id: string,
    name: string,
    base_url: string?,
    api: string?,
    headers: map<string, string>?,
    models: ComposedModel[],
}

class ModelOverride {
    id: string,
    name: string?,
    reasoning: bool?,
    context_window: int?,
    max_tokens: int?,
}

class ProviderExtension {
    name: string?,
    base_url: string?,
    api: string?,
    headers: map<string, string>?,
    model_overrides: map<string, ModelOverride>?,
    models: ComposedModel[]?,
}

function models_from_extension(
    provider_id: string,
    extension: ProviderExtension,
) -> ComposedModel[] {
    let m = extension.models;
    if (m == null) {
        []
    } else {
        m
    }
}

function apply_model_override(model: ComposedModel, ov: ModelOverride) -> ComposedModel {
    ComposedModel {
        id: model.id,
        name: ov.name ?? model.name,
        api: model.api,
        provider: model.provider,
        base_url: model.base_url,
        reasoning: ov.reasoning ?? model.reasoning,
        context_window: ov.context_window ?? model.context_window,
        max_tokens: ov.max_tokens ?? model.max_tokens,
        headers: model.headers,
    }
}

function compose_models(
    base_models: ComposedModel[],
    extension: ProviderExtension?,
) -> ComposedModel[] {
    if (extension == null) {
        base_models
    } else {
        let ext: ProviderExtension = extension;
        if (ext.models == null) {
            if (ext.base_url == null) {
                base_models
            } else {
                base_models.map((m) -> {
                    ComposedModel {
                        id: m.id,
                        name: m.name,
                        api: m.api,
                        provider: m.provider,
                        base_url: ext.base_url ?? m.base_url,
                        reasoning: m.reasoning,
                        context_window: m.context_window,
                        max_tokens: m.max_tokens,
                        headers: m.headers,
                    }
                })
            }
        } else {
            let m2: ComposedModel[] = ext.models ?? [];
            m2
        }
    }
}

function compose_provider(
    provider_id: string,
    base: ComposedProvider?,
    extension: ProviderExtension?,
) -> ComposedProvider throws baml.errors.InvalidArgument {
    if (base == null && extension == null) {
        throw baml.errors.InvalidArgument { message: "Provider " + provider_id + ": no base or extension" }
    }
    if (extension == null) {
        if (base == null) {
            throw baml.errors.InvalidArgument { message: "no base for " + provider_id }
        } else {
            base
        }
    } else {
        let ext: ProviderExtension = extension;
        let base_models: ComposedModel[] = if (base != null) {
            base.models
        } else {
            []
        };
        let models = compose_models(base_models, ext);
        if (ext.model_overrides != null) {
            let ovs: map<string, ModelOverride> = ext.model_overrides ?? {};
            models
                = models.map((m) -> {
                    let ov: ModelOverride? = ovs[m.id];
                    if (ov == null) {
                        m
                    } else {
                        apply_model_override(m, ov)
                    }
                })
        }
        ComposedProvider {
            id: provider_id,
            name: ext.name
                ?? if (base != null) {
                    base.name
                } else {
                    provider_id
                },
            base_url: ext.base_url
                ?? if (base != null) {
                    base.base_url
                } else {
                    null
                },
            api: ext.api
                ?? if (base != null) {
                    base.api
                } else {
                    null
                },
            headers: if (ext.headers != null) {
                ext.headers
            } else {
                if (base != null) {
                    base.headers
                } else {
                    null
                }
            },
            models: models,
        }
    }
}

function resolve_thinking_level(requested: ThinkingLevel?, model_reasoning: bool) -> string? {
    if (requested == null) {
        null
    } else if (!model_reasoning && requested != ThinkingLevel.Off) {
        null
    } else {
        let lvl = requested ?? ThinkingLevel.Off;
        if (lvl == ThinkingLevel.Off) {
            "off"
        } else if (lvl == ThinkingLevel.Minimal) {
            "minimal"
        } else if (lvl == ThinkingLevel.Low) {
            "low"
        } else if (lvl == ThinkingLevel.Medium) {
            "medium"
        } else if (lvl == ThinkingLevel.High) {
            "high"
        } else if (lvl == ThinkingLevel.Xhigh) {
            "xhigh"
        } else {
            "max"
        }
    }
}
