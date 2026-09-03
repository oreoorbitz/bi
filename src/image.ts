// Thin host wrapper for image generation via openai.ImageClient.
// Mirrors pi/packages/ai's images.ts (openai/gpt-image-1).

import { GenerateImage_async, GetImageModel_async, ListImageModels_async, type TurnFailure, ai } from "../baml_sdk/index.js";
import { resolveAuth } from "./auth.js";

export interface ImageModel {
	id: string;
	name: string;
	provider: string;
	base_url: string;
}

export async function listImageModels(provider?: string | null): Promise<ImageModel[]> {
	return (await ListImageModels_async(provider ?? null)) as ImageModel[];
}

export interface GenerateImageOptions {
	model?: string;
	apiKey?: string | null;
	baseUrl?: string | null;
	n?: number | null;
	size?: string | null;
}

export async function generateImage(prompt: string, options: GenerateImageOptions = {}): Promise<ai.ModelTurn | TurnFailure> {
	const model = options.model ?? "gpt-image-1";
	// bi#19: image models carry their provider in the catalog; unknown
	// models fall back to openai so GenerateImage keeps its own
	// unknown-model error (host never invents a provider).
	const entry = await GetImageModel_async(model);
	const provider = entry?.provider ?? "openai";
	const resolved = await resolveAuth(provider, options.apiKey);
	if ("failure" in resolved) return resolved.failure;
	const auth = resolved.auth;
	return GenerateImage_async(prompt, {
		model,
		api_key: auth.key,
		base_url: options.baseUrl ?? null,
		n: options.n ?? null,
		size: options.size ?? null,
	});
}
