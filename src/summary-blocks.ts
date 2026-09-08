// bi/src/summary-blocks.ts — transcript printers for branch/compaction/skill
// blocks (bi#27; bi#88/bi#97/bi#98 display leg). BAML owns every shaped line
// (format_branch_block/format_compaction_block/format_skill_block in
// render.baml); these printers only route: collapsed one-liners go to stdout,
// expanded bodies go through the markdown path. Emission wiring (/fork,
// /clone, compaction splice, skill guidance) stays with the cli/session
// owners — each printer is one import + one call.

import {
	format_branch_block_async,
	format_compaction_block_async,
	format_skill_block_async,
} from "../baml_sdk/index.js";
import { printMarkdownText } from "./markdown.js";

export interface BranchBlock {
	summary: string;
	fromId: string;
	newId: string;
	keptMessages: number;
	expanded?: boolean;
	expandHint?: string;
	theme?: string | null;
}

export async function printBranchSummary(b: BranchBlock): Promise<string> {
	const shaped = await format_branch_block_async(b.summary, b.fromId, b.newId, b.keptMessages, b.expanded ?? false, b.expandHint ?? "enter", {
		theme: b.theme ?? null,
	});
	if (b.expanded) await printMarkdownText(shaped, b.theme ?? null);
	else console.log(shaped);
	return shaped;
}

export interface CompactionBlock {
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	foldedTurns: number;
	expanded?: boolean;
	expandHint?: string;
	theme?: string | null;
}

export async function printCompactionSummary(c: CompactionBlock): Promise<string> {
	const shaped = await format_compaction_block_async(c.summary, c.tokensBefore, c.tokensAfter, c.foldedTurns, c.expanded ?? false, c.expandHint ?? "enter", {
		theme: c.theme ?? null,
	});
	if (c.expanded) await printMarkdownText(shaped, c.theme ?? null);
	else console.log(shaped);
	return shaped;
}

export interface SkillBlockView {
	name: string;
	content: string;
	userMessage?: string | null;
	expanded?: boolean;
	expandHint?: string;
	theme?: string | null;
}

export async function printSkillBlock(s: SkillBlockView): Promise<string> {
	const shaped = await format_skill_block_async(s.name, s.content, s.userMessage ?? null, s.expanded ?? false, s.expandHint ?? "enter", {
		theme: s.theme ?? null,
	});
	if (s.expanded) await printMarkdownText(shaped, s.theme ?? null);
	else console.log(shaped);
	return shaped;
}
