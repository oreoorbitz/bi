// Thin host wrapper for image generation via openai.ImageClient.
// Mirrors pi/packages/ai's images.ts (openai/gpt-image-1).

import { GenerateImage_async, ListImageModels_async, type TurnFailure, ai } from "../baml_sdk/index.js";

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
	return GenerateImage_async(prompt, {
		model: options.model ?? "gpt-image-1",
		api_key: options.apiKey ?? null,
		base_url: options.baseUrl ?? null,
		n: options.n ?? null,
		size: options.size ?? null,
	});
}
