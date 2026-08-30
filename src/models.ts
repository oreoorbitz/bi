// Thin TS host wrapper for the BAML model catalog (pi's Model<TApi>).
// Mirrors pi/packages/ai's MODELS/ANTHROPIC_MODELS shape but trimmed to
// the 3 providers bi has clients for.

import { GetModel_async, ListAllModels_async, ListModels_async, ModelSupportsReasoning_async, type Model } from "../baml_sdk/index.js";

export type { Model, ModelCost } from "../baml_sdk/index.js";

export async function listModels(provider: string): Promise<Model[]> {
	return ListModels_async(provider);
}

export async function listAllModels(): Promise<Model[]> {
	return ListAllModels_async();
}

export async function getModel(id: string): Promise<Model | null> {
	return GetModel_async(id);
}

export async function modelSupportsReasoning(id: string): Promise<boolean> {
	return ModelSupportsReasoning_async(id);
}

// Convenience — pi's Provider.getModels() equivalent for the 3 bi providers
export async function getModelsForProvider(provider: string): Promise<readonly Model[]> {
	return listModels(provider);
}
