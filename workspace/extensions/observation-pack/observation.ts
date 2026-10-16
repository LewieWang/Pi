/**
 * Observation — a stored, paged tool result.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/observation-pack/observation.ts
 *
 * An observation is the projection of a single tool result message. We hash
 * the text content to get a stable id (the same id is used across requests so
 * recall works no matter which projection emits the placeholder), archive the
 * raw bytes once, and emit a short placeholder when sending the result a
 * second or later time.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Threshold (bytes) above which a tool result is eligible for observation packing. */
export const THRESHOLD_BYTES = 4 * 1024;

/** How many times we send the full result before swapping in a placeholder. */
export const FULL_SENDS = 2;

/** Bytes shown in the placeholder excerpt (head + tail). */
export const PLACEHOLDER_EXCERPT_BYTES = 256;

/**
 * Min bytes between content boundary lines for placeholder math. We pick this
 * conservatively — SoL-Pi uses 4 KB chars/4 = 1K tokens heuristic.
 */
export const CHARS_PER_TOKEN = 4;

export interface Observation {
	/** Stable id derived from content hash. */
	readonly id: string;
	/** Tool name that produced this result. */
	readonly toolName: string;
	/** Source message timestamp if available. */
	readonly toolCallId?: string;
	/** Plain text content. */
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly tokens: number;
	readonly contentHash: string;
}

export function textContent(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const content = (message as unknown as { content: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const blocks: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			(block as { type: unknown }).type === "text" &&
			"text" in block &&
			typeof (block as { text: unknown }).text === "string"
		) {
			blocks.push((block as { text: string }).text);
		}
	}
	if (blocks.length === 0) return undefined;
	return blocks.join("\n");
}

export function isPureTextResult(message: AgentMessage): boolean {
	return textContent(message) !== undefined;
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) count += 1;
	}
	if (text.endsWith("\n")) count -= 1;
	return count;
}

export function sha256(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Extract an Observation from a tool result message. Returns null when the
 * message is not eligible (non-text, too small, etc.).
 */
export function createObservation(message: AgentMessage): Observation | null {
	const text = textContent(message);
	if (!text) return null;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes < THRESHOLD_BYTES) return null;
	const contentHash = sha256(text);
	const id = `obs_${contentHash.slice(0, 16)}`;
	const msgAny = message as unknown as {
		toolName?: string;
		toolCallId?: string;
	};
	return {
		id,
		toolName: msgAny.toolName ?? "unknown",
		toolCallId: msgAny.toolCallId,
		text,
		bytes,
		lines: countLines(text),
		tokens: estimateTokens(text),
		contentHash,
	};
}

export function observationPath(root: string, id: string): string {
	return join(root, `${id}.txt`);
}

/** Persist the raw text under the observation id. Idempotent. */
export async function ensureStored(root: string, observation: Observation): Promise<void> {
	const path = observationPath(root, observation.id);
	await mkdir(root, { recursive: true });
	let existing: import("node:fs").Stats | undefined;
	try {
		existing = await stat(path);
	} catch {
		existing = undefined;
	}
	if (existing && existing.size === Buffer.byteLength(observation.text, "utf8")) return;
	await writeFile(path, observation.text, "utf8");
}

/**
 * Short placeholder the model sees in place of the full text after FULL_SENDS
 * requests. Includes the id (so the model can pull it) plus byte/line/token
 * totals and a brief head/tail excerpt.
 */
export function placeholderFor(observation: Observation): string {
	const head = observation.text.slice(0, PLACEHOLDER_EXCERPT_BYTES);
	const tail = observation.text.slice(-PLACEHOLDER_EXCERPT_BYTES);
	const removedTokens = Math.max(
		0,
		observation.tokens - estimateTokens(`[obs id=${observation.id} ...]`),
	);
	return (
		`[obs id=${observation.id} tool=${observation.toolName} ` +
		`bytes=${observation.bytes} lines=${observation.lines} ` +
		`tokens=${observation.tokens} removed=${removedTokens}]\n` +
		`Use obs_recid { id: "${observation.id}", offset?: number } to read more.\n` +
		`--- head ---\n${head}\n` +
		`--- tail ---\n${tail}`
	);
}

const OBSERVATION_ID_RE = /^obs_[a-f0-9]{16}$/u;

export function isObservationId(value: unknown): value is string {
	return typeof value === "string" && OBSERVATION_ID_RE.test(value);
}

export interface RecallChunk {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

export async function readRecallChunk(
	path: string,
	offset: number,
	limits: { maxBytes: number; maxLines: number },
): Promise<RecallChunk> {
	const raw = await readFile(path, "utf8");
	const bytes = Buffer.byteLength(raw, "utf8");
	if (offset >= bytes) {
		return { text: "", bytes: 0, lines: 0, nextOffset: offset, eof: offset >= bytes };
	}
	// Slice by bytes first (cheap), then by lines if still too long.
	let slice = raw.slice(offset, offset + limits.maxBytes);
	let nextOffset = offset + Buffer.byteLength(slice, "utf8");
	const sliceLines = slice.split("\n");
	let lines = sliceLines.length;
	if (lines > limits.maxLines) {
		slice = sliceLines.slice(0, limits.maxLines).join("\n");
		lines = limits.maxLines;
		// Recompute nextOffset to a line boundary.
		nextOffset = offset + Buffer.byteLength(slice, "utf8");
	}
	const eof = nextOffset >= bytes;
	return { text: slice, bytes: Buffer.byteLength(slice, "utf8"), lines, nextOffset, eof };
}