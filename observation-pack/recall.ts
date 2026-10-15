/**
 * obs_recall — recall an exact page of a previously packed tool result.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/observation-pack/index.ts::pi.registerTool
 *
 * The model receives a short placeholder that names an observation id. When
 * it needs more, it calls obs_recall with that id and (for long results) an
 * offset. The tool returns a header describing the slice and the raw text up
 * to the page limits (RECALL_MAX_BYTES / RECALL_MAX_LINES).
 */

import { stat } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isObservationId,
	observationPath,
	readRecallChunk,
} from "./observation.js";
import { runtimeRoot } from "../shared/runtime-root.js";
import type { Journal } from "../shared/journal.js";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

export function registerObsRecall(pi: ExtensionAPI, journal: Journal): void {
	pi.registerTool({
		name: "obs_recid",
		label: "Recall Observation",
		description:
			"Read a previously packed tool result by observation id and byte offset. Use when an `[obs id=...]` placeholder appears in the conversation and you need the full content.",
		promptSnippet: "Recall a paged excerpt from a previously replaced tool result",
		renderShell: "self",
		parameters: Type.Object({
			id: Type.String({ description: "Observation id from a placeholder" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Byte offset, default 0" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionToolContext,
		) {
			const id = params.id;
			if (!isObservationId(id)) throw new Error(`Unknown observation id: ${String(id)}`);
			const offset = typeof params.offset === "number" ? params.offset : 0;
			const root = runtimeRoot(ctx, "observation-pack");
			const path = observationPath(root, id);
			try {
				await stat(path);
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code === "ENOENT") throw new Error(`Unknown observation id: ${id}`);
				throw error;
			}
			let chunk;
			try {
				chunk = await readRecallChunk(path, offset, RECALL_LIMITS);
			} catch (error) {
				throw new Error(`Recall failed for ${id}: ${(error as Error).message}`);
			}
			const header =
				`[obs_recid id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]\n` +
				`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`;
			const content = `${header}\n${chunk.text}`;
			const finalBytes = Buffer.byteLength(content, "utf8");
			const finalLines = content.split("\n").length;
			if (finalBytes > RECALL_MAX_BYTES || finalLines > RECALL_MAX_LINES) {
				throw new Error("Recall output exceeded its hard limit");
			}
			await journal.record({
				kind: "obs_recall",
				id,
				offset,
				bytes: chunk.bytes,
				lines: chunk.lines,
				next_offset: chunk.nextOffset,
				eof: chunk.eof,
			});
			return {
				content: [{ type: "text", text: content }],
				details: {
					id,
					offset,
					bytes: chunk.bytes,
					lines: chunk.lines,
					nextOffset: chunk.nextOffset,
					eof: chunk.eof,
				},
			};
		},
	});
}