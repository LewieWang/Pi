/**
 * Evidence-Preserving Reducer (heuristic variant).
 *
 * Subscribes to `pi.on("tool_result")`. For each bash / fused result that
 *   1. matches the diagnostic-command regex,
 *   2. exceeds the byte threshold,
 *   3. contains no likely secrets,
 *
 * we archive the body, run the heuristic reducer, validate the receipt,
 * and replace the content. The whole thing is fail-open: any error
 * returns the original event untouched.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/evidence-preserving-reducer/index.ts
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { runtimeRoot } from "../shared/runtime-root.js";
import { createJournal } from "../shared/journal.js";
import { archiveBody, readArchive } from "./archive.js";
import { reducibleToolResult } from "./candidate.js";
import { reduce, type Receipt } from "./heuristic.js";
import { renderReceipt, type RenderedReceipt } from "./receipt.js";

const MIN_REDUCTION_RATIO = 0.7; // receipt must be <70% of source to be applied

export interface ReducerConfig {
	readonly minReductionRatio: number;
	readonly maxEvidence: number;
	readonly maxQuoteChars: number;
}

export const DEFAULT_REDUCER_CONFIG: ReducerConfig = {
	minReductionRatio: MIN_REDUCTION_RATIO,
	maxEvidence: 32,
	maxQuoteChars: 500,
};

export interface EvidenceReducerOptions {
	readonly config?: Partial<ReducerConfig>;
	readonly forceEnable?: boolean;
}

function errorName(error: unknown): string | undefined {
	return error && typeof error === "object" && "name" in error
		? String((error as { name: unknown }).name)
		: undefined;
}

export async function reduceToolResult(
	ctx: ExtensionContext,
	config: ReducerConfig,
	event: ToolResultEvent,
): Promise<{ content: ToolResultEvent["content"]; details: Record<string, unknown> } | undefined> {
	let reducible;
	try {
		reducible = await reducibleToolResult(event);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error(
			`[harness:reducer] candidate failed: ${(error as Error).message ?? String(error)}`,
		);
		return undefined;
	}
	if (!reducible) return undefined;
	const { body, command, toolCallId, isError, toolName } = reducible;

	const journal = createJournal();
	const archiveRoot = runtimeRoot(ctx, "evidence-reducer");

	let archive;
	try {
		archive = await archiveBody(archiveRoot, body);
	} catch (error) {
		await journal.record({
			kind: "reducer_fallback",
			toolCallId,
			reason: "archive-failed",
			error: (error as Error).message,
		});
		return undefined;
	}

	await journal.record({
		kind: "reducer_candidate",
		toolCallId,
		toolName,
		command: command.slice(0, 200),
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		sourceLines: archive.lines,
		isError,
	});

	let receipt: Receipt;
	try {
		receipt = reduce(body, {
			isError,
			limits: {
				maxEvidence: config.maxEvidence,
				maxQuoteChars: config.maxQuoteChars,
			},
		});
	} catch (error) {
		await journal.record({
			kind: "reducer_fallback",
			toolCallId,
			sourceSha256: archive.hash,
			reason: "reduce-threw",
			error: (error as Error).message,
		});
		return undefined;
	}

	let rendered: RenderedReceipt;
	try {
		rendered = renderReceipt(command, archive.hash, archive.bytes, archive.lines, receipt);
	} catch (error) {
		await journal.record({
			kind: "reducer_fallback",
			toolCallId,
			sourceSha256: archive.hash,
			reason: "render-threw",
			error: (error as Error).message,
		});
		return undefined;
	}

	// Cross-check: every quoted line must be present in the body.
	const expectedSha = archive.hash;
	const expectedBytes = archive.bytes;
	const verified = await verifyReceipt(rendered, body, expectedSha, expectedBytes);
	if (!verified.ok) {
		await journal.record({
			kind: "reducer_fallback",
			toolCallId,
			sourceSha256: archive.hash,
			reason: verified.reason,
		});
		return undefined;
	}

	// Only apply if the receipt is meaningfully smaller.
	const ratio = rendered.bytes / Math.max(archive.bytes, 1);
	if (ratio >= config.minReductionRatio) {
		await journal.record({
			kind: "reducer_fallback",
			toolCallId,
			sourceSha256: archive.hash,
			reason: "receipt-not-smaller",
			receiptBytes: rendered.bytes,
			sourceBytes: archive.bytes,
			ratio: Number(ratio.toFixed(3)),
		});
		return undefined;
	}

	const evidenceCount = receipt.evidence.length;
	const savedBytes = archive.bytes - rendered.bytes;
	await journal.record({
		kind: "reducer_applied",
		toolCallId,
		toolName,
		sourceSha256: archive.hash,
		receiptSha256: expectedSha,
		receiptBytes: rendered.bytes,
		sourceBytes: archive.bytes,
		savedBytes,
		evidenceCount,
		uncertain: receipt.uncertain,
		status: receipt.status,
		ratio: Number(ratio.toFixed(3)),
	});

	void readArchive; // exported for the model to call back into via reducer_replay

	return {
		content: reducible.projectReceipt(rendered.text),
		details: {
			...((event.details as Record<string, unknown> | undefined) ?? {}),
			evidencePreservingReducer: {
				schema: "evidence-preserving-reducer/v1",
				sourceSha256: archive.hash,
				sourceBytes: archive.bytes,
				receiptBytes: rendered.bytes,
				evidenceCount,
				uncertain: receipt.uncertain,
				status: receipt.status,
			},
		},
	};
}

async function verifyReceipt(
	rendered: RenderedReceipt,
	body: string,
	expectedSha: string,
	expectedBytes: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (rendered.sourceSha256 !== expectedSha) return { ok: false, reason: "sha-mismatch" };
	if (rendered.sourceBytes !== expectedBytes) return { ok: false, reason: "bytes-mismatch" };
	// Parse the evidence lines out of the receipt and confirm each is in body.
	const lines = rendered.text.split("\n");
	for (const line of lines) {
		const m = line.match(/^(fatal|failure|warning|target|summary)\s+L\s+(\d+)\s+(.*)$/u);
		if (!m) continue;
		const quote = m[3];
		if (quote && !body.includes(quote)) {
			return { ok: false, reason: `quote-not-in-source: ${quote.slice(0, 60)}` };
		}
	}
	return { ok: true };
}

export function createEvidenceReducerExtension(
	options: EvidenceReducerOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const config: ReducerConfig = {
			...DEFAULT_REDUCER_CONFIG,
			...options.config,
		};
		pi.on("tool_result", (event, context) => {
			if (!context) return undefined;
			// The config is loaded at the session level via sol-pi.json. The
			// `forceEnable` test override is the only way past it.
			if (!options.forceEnable) {
				const { readConfig } = require("../shared/config.js") as typeof import("../shared/config.js");
				const cfg = readConfig({ projectTrusted: context.isProjectTrusted() });
				if (!cfg.evidencePreservingReducer) return undefined;
			}
			return reduceToolResult(context, config, event as ToolResultEvent);
		});
	};
}

export default function evidenceReducerExtension(pi: ExtensionAPI): void {
	createEvidenceReducerExtension()(pi);
}

void errorName;