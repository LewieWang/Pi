/**
 * Candidate selection.
 *
 * Not every tool result is worth reducing. SoL-Pi gates on three things:
 *
 *   1. The tool is bash (or edit/write that fused a then_run command).
 *   2. The command matches the diagnostic command regex (builds, tests,
 *      type-checks, lints).
 *   3. The body is at or above the configured byte threshold.
 *
 * We follow the same shape. Reference: SoL-Pi
 * src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts.
 */

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

const DIAGNOSTIC_TOOLS =
	/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|compile|check|lint|typecheck|tsc|verify|spec|ci)\b/iu;

// Diagnostic tools. Matches bare invocations and absolute/relative paths
// ending in a known diagnostic tool basename.
const DIAGNOSTIC_BARE =
	/^\s*(?:\S*[\/\\])?(?:tsc|pytest|jest|vitest|mocha|cargo|swiftc|xcodebuild|rustc|gcc|g\+\+|clang(?:\+\+)?|gradle|mvn|sbt|eslint|prettier)(?:\s|--|$)|^\s*node\s+--check\b|^\s*go\s+test\b|^\s*swift\s+(?:test|build)\b|^\s*(?:make|cmake)\b/iu;

function isDiagnosticInner(command: string): boolean {
	return DIAGNOSTIC_TOOLS.test(command) || DIAGNOSTIC_BARE.test(command);
}

export const isDiagnostic = isDiagnosticInner;

const MIN_BYTES = 2 * 1024;
const MAX_CHARS = 200_000;
const LIKELY_SECRET = /(-----BEGIN [A-Z ]+ PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/u;

export interface ReducibleToolResult {
	readonly command: string;
	readonly body: string;
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
	readonly toolCallId: string;
	readonly isError: boolean;
	readonly toolName: string;
}

function textContent(event: ToolResultEvent): string {
	return event.content
		.filter(
			(item): item is { type: "text"; text: string } => item.type === "text",
		)
		.map((item) => item.text)
		.join("\n");
}

function detailsFullOutputPath(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const value = (details as Record<string, unknown>).fullOutputPath;
	return typeof value === "string" ? value : undefined;
}

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";

export function detectThenRun(
	event: ToolResultEvent,
): { command: string; index: number; markerStart: number; markerEnd: number; separator: string } | undefined {
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const input = event.input as Record<string, unknown>;
	const thenRun = input.then_run;
	if (!thenRun || typeof thenRun !== "object") return undefined;
	const command = (thenRun as Record<string, unknown>).command;
	if (typeof command !== "string" || !command) return undefined;
	if (!isDiagnostic(command)) return undefined;
	const marker = event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < event.content.length; index += 1) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		const markerStart = block.text.indexOf(marker);
		if (markerStart < 0) continue;
		const markerEnd = markerStart + marker.length;
		const suffix = block.text.slice(markerEnd);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		return { command, index, markerStart, markerEnd, separator };
	}
	return undefined;
}

export async function reducibleToolResult(
	event: ToolResultEvent,
): Promise<ReducibleToolResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!isDiagnostic(command)) return undefined;
		const inline = textContent(event);
		const body = await exactBodyFromInline(inline, event.details);
		if (Buffer.byteLength(body, "utf8") < MIN_BYTES) return undefined;
		if (body.length > MAX_CHARS) return undefined;
		if (LIKELY_SECRET.test(body)) return undefined;
		return {
			command,
			body,
			toolCallId: event.toolCallId,
			isError: event.isError,
			toolName: event.toolName,
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
		};
	}

	const fused = detectThenRun(event);
	if (!fused) return undefined;
	const inline = textContent(event);
	if (Buffer.byteLength(inline, "utf8") < MIN_BYTES) return undefined;
	if (inline.length > MAX_CHARS) return undefined;
	if (LIKELY_SECRET.test(inline)) return undefined;
	return {
		command: fused.command,
		body: inline,
		toolCallId: event.toolCallId,
		isError: event.isError,
		toolName: event.toolName,
		projectReceipt: (receipt) =>
			event.content.map((content, contentIndex) =>
				contentIndex === fused.index && content.type === "text"
					? { ...content, text: receipt }
					: content,
			),
	};
}

async function exactBodyFromInline(inline: string, details: unknown): Promise<string> {
	const path = detailsFullOutputPath(details);
	if (!path) return inline;
	try {
		const { readFile } = await import("node:fs/promises");
		return await readFile(path, "utf8");
	} catch {
		return inline;
	}
}