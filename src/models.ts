// Thin TS host wrapper for the BAML model catalog (pi's Model<TApi>).
// Mirrors pi/packages/ai's MODELS/ANTHROPIC_MODELS shape but trimmed to
// the 3 providers bi has clients for.

import { cycle_model_forward_async, GetModel_async, GetProvider_async, ListAllModels_async, ListModels_async, ListProviders_async, validate_refreshed_models_async, type Model } from "../baml_sdk/index.js";

export type { Model, ModelCost } from "../baml_sdk/index.js";

export async function listModels(provider: string): Promise<Model[]> {
	const over = overlay.get(provider);
	if (over) return [...over.models];
	return ListModels_async(provider);
}

export async function listAllModels(): Promise<Model[]> {
	if (overlay.size === 0) return ListAllModels_async();
	const out: Model[] = [];
	for (const p of await ListProviders_async()) {
		const over = overlay.get(p.id);
		out.push(...(over ? over.models : await ListModels_async(p.id)));
	}
	return out;
}

// Overlay-aware: refreshed ids resolve like builtins. Static BAML first
// would shadow a refreshed row with the same id, so the overlay wins.
export async function getModel(id: string): Promise<Model | null> {
	for (const over of overlay.values()) {
		const hit = over.models.find((m) => m.id === id);
		if (hit) return hit;
	}
	return GetModel_async(id);
}

export async function modelSupportsReasoning(id: string): Promise<boolean> {
	const m = await getModel(id);
	return m ? m.reasoning : false;
}

// Convenience — pi's Provider.getModels() equivalent for the 3 bi providers
export async function getModelsForProvider(provider: string): Promise<readonly Model[]> {
	return listModels(provider);
}

// Resolve a /model argument against the live catalog: exact model id
// (overlay included), then "provider/id", else null. BAML owns the static
// match; the overlay check keeps refreshed ids resolving like builtins.
export async function resolveModelRef(ref: string): Promise<Model | null> {
	const direct = await getModel(ref);
	if (direct) return direct;
	const slash = ref.indexOf("/");
	if (slash < 0) return null;
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	if (!id) return null;
	const ms = await listModels(provider);
	return ms.find((m) => m.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// bi#89: host-owned catalog refresh lifecycle.
//
// Split mirrors pi's refresh coordinator (packages/ai models.ts): BAML
// keeps the validated catalog schema (validate_refreshed_models), the host
// owns fetch/dedupe/abort. Per-provider in-flight promises coalesce
// concurrent refreshes to one fetch; each caller races the shared promise
// against its own signal, so one caller's abort rejects only its own wait.
// A superseding refresh (force) bumps the generation — the stale publish
// is dropped, never half-applied. With no fetcher the refresh is static
// (validates the provider id, reports the built-in count), mirroring pi's
// `refreshModels({allowNetwork:false})` pre-turn check.

export interface RefreshedModelInput {
	id: string;
	name?: string | null;
	api?: string | null;
	reasoning?: boolean | null;
	context_window?: number | null;
	max_tokens?: number | null;
}

export type CatalogFetcher = (provider: string, signal: AbortSignal) => Promise<RefreshedModelInput[]>;

export type CatalogRefreshSource = "static" | "remote" | "unknown" | "aborted" | "stale";

export interface CatalogRefreshOutcome {
	provider: string;
	refreshed: boolean;
	source: CatalogRefreshSource;
	model_count: number;
	errors: string[];
	aborted: boolean;
}

interface InflightRefresh {
	promise: Promise<CatalogRefreshOutcome>;
	controller: AbortController;
}

const inflight = new Map<string, InflightRefresh>();
const generations = new Map<string, number>();
const overlay = new Map<string, { models: Model[]; checkedAt: number }>();

function abortError(): Error {
	const e = new Error("catalog refresh aborted");
	e.name = "AbortError";
	return e;
}

// One caller's wait over the shared fetch: rejects on the caller's abort,
// leaves the shared fetch running for the other waiters.
function raceWithAbort(promise: Promise<CatalogRefreshOutcome>, signal?: AbortSignal): Promise<CatalogRefreshOutcome> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<CatalogRefreshOutcome>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

function combineSignals(parent: AbortSignal | undefined, own: AbortSignal): AbortSignal {
	if (!parent) return own;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([parent, own]);
	const controller = new AbortController();
	if (parent.aborted || own.aborted) controller.abort();
	else {
		const onAbort = () => controller.abort();
		parent.addEventListener("abort", onAbort, { once: true });
		own.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

export async function refreshCatalog(
	provider: string,
	opts: { fetcher?: CatalogFetcher; signal?: AbortSignal; force?: boolean } = {},
): Promise<CatalogRefreshOutcome> {
	if (await GetProvider_async(provider).then((p) => p === null)) {
		return { provider, refreshed: false, source: "unknown", model_count: 0, errors: [`unknown provider "${provider}"`], aborted: false };
	}
	const running = inflight.get(provider);
	if (running && !opts.force) return raceWithAbort(running.promise, opts.signal);
	if (running && opts.force) running.controller.abort();
	const generation = (generations.get(provider) ?? 0) + 1;
	generations.set(provider, generation);
	const controller = new AbortController();
	const signal = combineSignals(opts.signal, controller.signal);
	const promise = (async (): Promise<CatalogRefreshOutcome> => {
		if (signal.aborted) return { provider, refreshed: false, source: "aborted", model_count: 0, errors: [], aborted: true };
		if (!opts.fetcher) {
			const count = (await ListModels_async(provider)).length;
			return { provider, refreshed: true, source: "static", model_count: count, errors: [], aborted: false };
		}
		let fetched: RefreshedModelInput[];
		try {
			fetched = await opts.fetcher(provider, signal);
		} catch (e) {
			if (signal.aborted) return { provider, refreshed: false, source: "aborted", model_count: 0, errors: [], aborted: true };
			throw e;
		}
		if (signal.aborted) return { provider, refreshed: false, source: "aborted", model_count: 0, errors: [], aborted: true };
		const v = await validate_refreshed_models_async(
			provider,
			fetched.map((f) => ({
				id: f.id,
				name: f.name ?? null,
				api: f.api ?? null,
				reasoning: f.reasoning ?? null,
				context_window: f.context_window ?? null,
				max_tokens: f.max_tokens ?? null,
			})),
		);
		// Stale (superseded) or aborted while validating: drop the publish.
		if (signal.aborted) return { provider, refreshed: false, source: "aborted", model_count: 0, errors: [], aborted: true };
		if (generations.get(provider) !== generation) {
			return { provider, refreshed: false, source: "stale", model_count: 0, errors: [], aborted: false };
		}
		overlay.set(provider, { models: v.valid, checkedAt: Date.now() });
		return {
			provider,
			refreshed: true,
			source: "remote",
			model_count: v.valid.length,
			errors: v.errors.map((e) => `${e.id}: ${e.reason}`),
			aborted: false,
		};
	})();
	inflight.set(provider, { promise, controller });
	const done = () => {
		if (inflight.get(provider)?.promise === promise) inflight.delete(provider);
	};
	promise.then(done, done);
	return raceWithAbort(promise, opts.signal);
}

// Overlay introspection for /model refresh reporting + staleness policy.
export function catalogCheckedAt(provider: string): number | undefined {
	return overlay.get(provider)?.checkedAt;
}

export function isCatalogStale(provider: string, maxAgeMs: number): boolean {
	const at = overlay.get(provider)?.checkedAt;
	if (at === undefined) return true;
	return Date.now() - at > maxAgeMs;
}

// Test seam: drop one (or all) overlays so suites start from the static catalog.
export function clearCatalogOverlay(provider?: string): void {
	if (provider) overlay.delete(provider);
	else overlay.clear();
}

// ---------------------------------------------------------------------------
// bi#90: Ctrl+P cycling over the scoped set.
//
// BAML owns the stepping policy (cycle_model_forward over catalog order
// filtered by the enablement set); the host resolves the stepped id
// (overlay-aware, so refreshed ids cycle like builtins) and refuses loudly
// when there is nothing to step to. The REPL applies the returned Model to
// the live backend and prints it; readline mode never calls this (numeric
// /model picks stay the fallback).
export async function cycleModelForward(currentId: string, enabled: string[] | null): Promise<Model> {
	const nextId = await cycle_model_forward_async(currentId, enabled);
	if (!nextId) {
		if (enabled !== null && enabled.length === 0) {
			throw new Error("no models enabled — /scoped-models all resets to all-enabled");
		}
		throw new Error("only one model in the enabled set — model cycling needs at least two (/scoped-models enable <id>)");
	}
	const next = await getModel(nextId);
	if (!next) {
		throw new Error(`cycled to unknown model "${nextId}" — bare /model lists the catalog`);
	}
	return next;
}
