// Provider registry — pi's Provider<TApi> trimmed to id/name/baseUrl/api.
// Complements models.ts ListModels.

import {
	GetProvider_async,
	ListProviders_async,
	ProviderExists_async,
	ProviderForModel_async,
	RefreshAllModels_async,
	RefreshModels_async,
	type Provider,
} from "../baml_sdk/index.js";

export type { Provider } from "../baml_sdk/index.js";

export async function listProviders(): Promise<Provider[]> {
	return ListProviders_async();
}

export async function getProvider(id: string): Promise<Provider | null> {
	return GetProvider_async(id);
}

export async function providerExists(id: string): Promise<boolean> {
	return ProviderExists_async(id);
}

export async function providerForModel(modelId: string): Promise<Provider | null> {
	return ProviderForModel_async(modelId);
}

export async function refreshModels(provider: string): Promise<boolean> {
	return RefreshModels_async(provider);
}

export async function refreshAllModels(): Promise<number> {
	return RefreshAllModels_async();
}
