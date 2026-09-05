// bi/src/screen-model.ts — /model rows for the screen picker (slice 2).
// BAML owns the rows (ListAllModels); screen.ts owns the widget; the
// /model handler resolves the picked id through its existing apply
// path (disabled guard included).
import { ListAllModels_async, type Model } from "../baml_sdk/index.js";
import { screenAvailable, screenPickList } from "./screen.js";

export function screenModelAvailable(): boolean {
	return screenAvailable();
}

export async function screenPickModel(currentId: string, enabled: string[] | null): Promise<string | null> {
	if (!screenAvailable()) return null;
	const models = (await ListAllModels_async()) as Model[];
	if (models.length === 0) return null;
	const at = await screenPickList(
		"Select model (↑↓ navigate · Enter switches · Esc keeps)",
		models.map((m) => ({
			label: m.id,
			description: `${m.provider} · ${m.context_window} ctx${m.id === currentId ? " · current" : ""}${
				enabled !== null && !enabled.includes(m.id) ? " · disabled" : ""
			}`,
		})),
		Math.max(0, models.findIndex((m) => m.id === currentId)),
	);
	if (at === null) return null;
	const m = models[at];
	return m ? m.id : null;
}
