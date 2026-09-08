// Conversation-history shape for bi port of pi/packages/ai.
// Widened iteratively: Stage 1 text only → Stage 2 reasoning/toolUse →
// Stage 3 media (image blocks) via ai.content.Media + baml.media.Image.
//
// Known gap (proposal 10, bi#06): host-constructed Media via toHistory
// (image) round-trips to host as AssistantMessage with Media, but passing
// that history to SendTurn/StreamTurn fails with `TypeMismatch: Value of
// type 'media' does not match union [Image, Audio, Video, Pdf]` — same
// handle-union class as proposals 04/08/09. The supported path is
// splitMediaTurns + SendTurnWithMedia: image blocks cross FFI as plain
// MediaSpec strings and the VM builds the Media blocks in the same call
// that invokes the model (turn.baml's MediaSpec boundary). toHistory's
// image branch is kept for direct/single-shot callers; the agent loop
// splits first so Media never sits in host history.

import { ToolSpec as BamlToolSpec, ai, baml, CreateMediaBlock_async, CreateMediaBlockFromUrl_async } from "../baml_sdk/index.js";

export type AssistantContent =
	| { type: "text"; text: string }
	| { type: "reasoning"; summary: string }
	| { type: "toolUse"; id: string; name: string; args: Record<string, unknown> }
	| { type: "image"; base64: string; mimeType: string }
	| { type: "imageUrl"; url: string; mimeType?: string };

export type ToolResultContent = string | readonly ({ type: "text"; text: string } | { type: "image"; base64: string; mimeType: string })[];

export type ConversationTurn =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; clientId: string }
	| { role: "assistant"; content: readonly AssistantContent[]; clientId: string }
	// pi-shaped aliases — also accepted, mapped to the same blocks
	| { role: "assistant"; text: string; reasoning?: string; toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[]; clientId: string }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: ToolResultContent; isError: boolean }
	| { role: "toolRequested"; id: string; name: string; args: Record<string, unknown> }
	| { role: "toolCompleted"; id: string; output: string }
	| { role: "toolFailed"; id: string; message: string };

async function toMediaBlock(b: Extract<AssistantContent, { type: "image" } | { type: "imageUrl" }>): Promise<ai.content.Block> {
	if (b.type === "image") {
		return CreateMediaBlock_async(b.base64, b.mimeType);
	}
	return CreateMediaBlockFromUrl_async(b.url, b.mimeType ?? null);
}

async function toAssistantContent(blocks: readonly AssistantContent[]): Promise<ai.content.Block[]> {
	const out: ai.content.Block[] = [];
	for (const b of blocks) {
		if (b.type === "text") out.push(new ai.content.Text({ text: b.text }));
		else if (b.type === "reasoning") out.push(new ai.content.Reasoning({ summary: b.summary }));
		else if (b.type === "toolUse") out.push(new ai.content.ToolUse({ id: b.id, name: b.name, args: b.args }));
		else out.push(await toMediaBlock(b as any));
	}
	return out;
}

// bi#06: pull image blocks out of host history before toHistory.
// Media built on the host cannot re-enter the VM (proposal 10 union-alias
// gap), so the agent loop splits image blocks into plain MediaSpec data
// (source/data/mimeType strings, which cross FFI intact) and sends them
// via SendTurnWithMedia_async alongside the media-free history. Pure and
// synchronous — no SDK calls. Image-only assistant turns drop out of the
// history (their clientId becomes mediaClientId); mixed turns keep their
// non-image blocks in place. Order of media follows turn order.
export interface MediaSpecData {
	source: "base64" | "url";
	data: string;
	mimeType?: string | null;
}

export interface SplitMedia {
	history: ConversationTurn[];
	media: MediaSpecData[];
	mediaClientId: string;
}

export function splitMediaTurns(turns: readonly ConversationTurn[]): SplitMedia {
	const history: ConversationTurn[] = [];
	const media: MediaSpecData[] = [];
	let mediaClientId = "test-client";
	for (const turn of turns) {
		const content = (turn as any).content;
		if (turn.role !== "assistant" || !Array.isArray(content)) {
			history.push(turn);
			continue;
		}
		const rest: AssistantContent[] = [];
		const before = media.length;
		for (const b of content as readonly AssistantContent[]) {
			if (b.type === "image") media.push({ source: "base64", data: b.base64, mimeType: b.mimeType });
			else if (b.type === "imageUrl") media.push({ source: "url", data: b.url, mimeType: b.mimeType ?? null });
			else rest.push(b);
		}
		if (media.length > before && (turn as any).clientId) mediaClientId = (turn as any).clientId;
		if (rest.length > 0) history.push({ role: "assistant", content: rest, clientId: (turn as any).clientId });
	}
	return { history, media, mediaClientId };
}

export async function toHistory(turns: readonly ConversationTurn[]): Promise<ai.events.Event[]> {
	const out: ai.events.Event[] = [];
	for (const turn of turns) {
		if (turn.role === "user") {
			out.push(new ai.events.UserMessage({ content: (turn as any).text }));
			continue;
		}
		if (turn.role === "toolResult") {
			// ToolResult content may be string or (text|image)[] — pi's ToolResultMessage shape.
			// BAML's ToolCompleted/ToolFailed only carry string, so image blocks are serialized
			// as placeholder text until BAML's Journal supports media (see proposal 10 gap).
			const serializeToolContent = (c: ToolResultContent): string => {
				if (typeof c === "string") return c;
				return c
					.map((part: any) => {
						if (part.type === "text") return part.text;
						if (part.type === "image") return `[image:${part.mimeType} ${part.base64.slice(0, 24)}...]`;
						return "";
					})
					.join("\n");
			};
			const serialized = serializeToolContent(turn.content as any);
			if (turn.isError) {
				out.push(new ai.events.ToolFailed({ id: turn.toolCallId, message: serialized }));
			} else {
				out.push(new ai.events.ToolCompleted({ id: turn.toolCallId, output: serialized }));
			}
			continue;
		}
		if (turn.role === "toolCompleted") {
			out.push(new ai.events.ToolCompleted({ id: turn.id, output: turn.output }));
			continue;
		}
		if (turn.role === "toolFailed") {
			out.push(new ai.events.ToolFailed({ id: turn.id, message: turn.message }));
			continue;
		}
		if (turn.role === "toolRequested") {
			out.push(new ai.events.ToolRequested({ id: turn.id, name: turn.name, args: turn.args }));
			continue;
		}
		// assistant — content array takes precedence (may contain async image blocks)
		if ((turn as any).content && Array.isArray((turn as any).content)) {
			const blocks = (turn as any).content as readonly AssistantContent[];
			const content = await toAssistantContent(blocks);
			out.push(new ai.events.AssistantMessage({ content, client_id: (turn as any).clientId }));
			continue;
		}
		// pi-shaped assistant with optional reasoning/toolCalls alongside text
		const t = turn as any as { text?: string; reasoning?: string; toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[]; clientId: string };
		if (t.reasoning != null || (t.toolCalls && t.toolCalls.length > 0)) {
			const content: ai.content.Block[] = [];
			if (t.text) content.push(new ai.content.Text({ text: t.text }));
			if (t.reasoning) content.push(new ai.content.Reasoning({ summary: t.reasoning }));
			if (t.toolCalls) {
				for (const tc of t.toolCalls) content.push(new ai.content.ToolUse({ id: tc.id, name: tc.name, args: tc.arguments }));
			}
			out.push(new ai.events.AssistantMessage({ content, client_id: t.clientId }));
			continue;
		}
		out.push(
			new ai.events.AssistantMessage({
				content: [new ai.content.Text({ text: (turn as any).text })],
				client_id: (turn as any).clientId,
			}),
		);
	}
	return out;
}

// pi-shaped tool spec (camelCase), mapped 1:1 onto baml_sdk's generated
// ToolSpec class. See turn.baml's header (limitation 4) for why this is
// plain data rather than a pre-built ai.tools.Tool.
export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export function toToolSpecs(tools: readonly ToolSpec[]): BamlToolSpec[] {
	return tools.map(
		(t) => new BamlToolSpec({ name: t.name, description: t.description, input_schema: t.inputSchema }),
	);
}
