// bi/src/screen-model.ts — /model rows for the screen picker (slice 2).
// BAML owns the rows (ListAllModels); screen.ts owns the widget; the
// /model handler resolves the picked id through its existing apply
// path (disabled guard included).
import { ListAllModels_async, model_selector_search_text, type Model } from "../baml_sdk/index.js";
import { promptAvailable, pickList } from "./prompt.js";

export function screenModelAvailable(): boolean {
	return promptAvailable();
}

export async function screenPickModel(currentId: string, enabled: string[] | null): Promise<string | null> {
	if (!promptAvailable()) return null;
	const models = (await ListAllModels_async()) as Model[];
	if (models.length === 0) return null;
	const at = await pickList(
		"Select model (↑↓ navigate · type to filter · Enter switches · Esc keeps)",
		models.map((m) => ({
			label: m.id,
			description: `${m.provider} · ${m.context_window} ctx${m.id === currentId ? " · current" : ""}${
				enabled !== null && !enabled.includes(m.id) ? " · disabled" : ""
			}`,
			// bi#85: BAML selector search text (provider leads) so
			// `xai/grok` ranks the provider-prefixed row first.
			searchText: model_selector_search_text(m.id, m.provider, { name: m.name }),
		})),
		Math.max(0, models.findIndex((m) => m.id === currentId)),
	);
	if (at === null) return null;
	const m = models[at];
	return m ? m.id : null;
}
