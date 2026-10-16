/**
 * Action Fusion tool factory.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/action-fusion/index.ts
 *
 * Replaces Pi's built-in `edit` and `write` tools with versions that accept an
 * optional `then_run` parameter. When provided:
 *
 *   1. Apply the mutation (Pi's own file mutation queue serializes per-file)
 *   2. Hash the target twice with a yield between reads (catches unrelated writes)
 *   3. Run the command via Pi's built-in bash tool
 *   4. Append [then_run:succeeded|failed|skipped] + output to the mutation result
 *
 * Failure policy (matches AGENTS.md "Fail open"):
 *   - mutation error       → then_run skipped, error propagates
 *   - mutation ok, hash guard fires → then_run skipped, mutation kept
 *   - mutation ok, bash error → mutation result returned with [then_run:failed]
 *   - mutation ok, bash ok   → run succeeds with [then_run:succeeded]
 *
 * We deliberately do NOT call `withFileMutationQueue` here. The built-in
 * mutation tool already serializes per-file mutations via its own queue, and
 * nesting the queues would deadlock (SoL-Pi documents this exact lesson in
 * src/sol-pi/extensions/action-fusion/file-queue.ts).
 */

import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashToolInput,
	type BashToolOptions,
	type EditToolInput,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	THEN_RUN_SKIPPED,
	HashGuardError,
	assertUnchangedBeforeCommand,
} from "./hash-guard.js";
import type { Journal } from "../shared/journal.js";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export const THEN_RUN_SCHEMA = Type.Optional(
	Type.Object(
		{
			command: Type.String({ description: "Bash command to run after mutation succeeds" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
			),
		},
		{
			description:
				"Fused command — runs on this file right after a successful mutation (e.g. test, build, start). Optional timeout.",
		},
	),
);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Expand `~` and resolve to the absolute path Pi's mutation tool will write. */
function resolveToolPath(cwd: string, filePath: string): string {
	let expanded = filePath;
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/")) expanded = resolvePath(homedir(), expanded.slice(2));
	return resolvePath(cwd, expanded);
}

export interface MutationContext {
	readonly cwd: string;
	readonly journal: Journal;
}

async function runThenRunCommand(
	absolutePath: string,
	thenRun: ThenRunInput,
	mutationResult: AgentToolResult<unknown>,
	toolCallId: string,
	signal: AbortSignal | undefined,
	bashOptions: BashToolOptions | undefined,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<unknown>> {
	const bash = createBashToolDefinition(ctx.cwd, bashOptions);
	const startedAt = Date.now();
	let bashResult;
	try {
		bashResult = await bash.execute(
			`${toolCallId}:then_run`,
			thenRun satisfies BashToolInput,
			signal,
			undefined,
			ctx,
		);
	} catch (error) {
		const mutationOutput = resultText(mutationResult);
		const message = [mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n");
		throw new Error(message);
	}

	const output = resultText(bashResult);
	// bash.execute sets isError=true for non-zero exit codes; fail-open says
	// the mutation still stands but we surface the failure to the model so it
	// can decide whether to retry.
	if (bashResult.isError) {
		const mutationOutput = resultText(mutationResult);
		throw new Error([mutationOutput, THEN_RUN_FAILED, output].filter(Boolean).join("\n\n"));
	}

	return {
		...mutationResult,
		content: [
			...mutationResult.content,
			{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
		],
	};
}

/**
 * Execute mutation + then_run. The built-in mutation tool already serialized
 * per-file locks, so we just sequence mutation → hash guard → command.
 */
async function executeMutationThenRun<TDetails>({
	toolCallId,
	absolutePath,
	thenRun,
	bashOptions,
	signal,
	ctx,
	mutate,
	journal,
}: {
	toolCallId: string;
	absolutePath: string;
	thenRun: ThenRunInput | undefined;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionToolContext;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	journal: Journal;
}): Promise<AgentToolResult<TDetails>> {
	let mutationResult: AgentToolResult<TDetails>;
	try {
		mutationResult = await mutate();
		await journal.record({ kind: "mutation", path: absolutePath, outcome: "ok" });
	} catch (error) {
		await journal.record({ kind: "mutation", path: absolutePath, outcome: "error" });
		if (thenRun !== undefined) {
			await journal.record({
				kind: "then_run",
				path: absolutePath,
				outcome: "skipped",
				command: thenRun.command,
				reason: "mutation failed",
			});
			throw new Error(
				`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The mutation did not complete; command not run.`,
			);
		}
		throw error;
	}

	if (thenRun === undefined) {
		await journal.record({
			kind: "then_run",
			path: absolutePath,
			outcome: "no_command",
		});
		return mutationResult;
	}

	try {
		await assertUnchangedBeforeCommand(absolutePath);
	} catch (error) {
		if (error instanceof HashGuardError) {
			await journal.record({
				kind: "then_run",
				path: absolutePath,
				outcome: "skipped",
				command: thenRun.command,
				reason: "hash guard",
			});
			return {
				...mutationResult,
				content: [...mutationResult.content, { type: "text", text: error.message }],
			};
		}
		throw error;
	}

	const startedAt = Date.now();
	try {
		const fused = await runThenRunCommand(absolutePath, thenRun, mutationResult as AgentToolResult<unknown>, toolCallId, signal, bashOptions, ctx) as AgentToolResult<TDetails>;
		await journal.record({
			kind: "then_run",
			path: absolutePath,
			outcome: "succeeded",
			command: thenRun.command,
			duration_ms: Date.now() - startedAt,
		});
		return fused;
	} catch (error) {
		await journal.record({
			kind: "then_run",
			path: absolutePath,
			outcome: "failed",
			command: thenRun.command,
			duration_ms: Date.now() - startedAt,
			reason: errorText(error),
		});
		throw error;
	}
}

/**
 * Wrap a built-in edit/write definition with `then_run`.
 */
export function wrapEditWithThenRun(
	base: ToolDefinition<any, EditToolDetails | undefined>,
	journal: Journal,
	bashOptions?: BashToolOptions,
): ToolDefinition<any, EditToolDetails | undefined> {
	const wrapped: ToolDefinition<any, EditToolDetails | undefined> = {
		...base,
		parameters: Type.Object({
			...base.parameters.properties,
			then_run: THEN_RUN_SCHEMA,
		}),
		async execute(
			toolCallId: string,
			input: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<EditToolDetails | undefined> | undefined,
			ctx: ExtensionToolContext,
		) {
			const { then_run, ...editInput } = input as EditToolInput & { then_run?: ThenRunInput };
			return executeMutationThenRun({
				toolCallId,
				absolutePath: resolveToolPath(ctx.cwd, (editInput as { path: string }).path),
				thenRun: then_run,
				bashOptions,
				signal,
				ctx,
				mutate: () => base.execute(toolCallId, editInput, signal, onUpdate, ctx),
				journal,
			});
		},
	};
	return wrapped;
}

export function wrapWriteWithThenRun(
	base: ToolDefinition<any, undefined>,
	journal: Journal,
	bashOptions?: BashToolOptions,
): ToolDefinition<any, undefined> {
	const wrapped: ToolDefinition<any, undefined> = {
		...base,
		parameters: Type.Object({
			...base.parameters.properties,
			then_run: THEN_RUN_SCHEMA,
		}),
		async execute(
			toolCallId: string,
			input: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<undefined> | undefined,
			ctx: ExtensionToolContext,
		) {
			const { then_run, ...writeInput } = input as WriteToolInput & { then_run?: ThenRunInput };
			return executeMutationThenRun({
				toolCallId,
				absolutePath: resolveToolPath(ctx.cwd, (writeInput as { path: string }).path),
				thenRun: then_run,
				bashOptions,
				signal,
				ctx,
				mutate: () => base.execute(toolCallId, writeInput, signal, onUpdate, ctx),
				journal,
			});
		},
	};
	return wrapped;
}

export function createActionFusionTools(
	cwd: string,
	journal: Journal,
	bashOptions?: BashToolOptions,
) {
	const editBase = createEditToolDefinition(cwd);
	const writeBase = createWriteToolDefinition(cwd);
	return {
		edit: wrapEditWithThenRun(editBase, journal, bashOptions),
		write: wrapWriteWithThenRun(writeBase, journal, bashOptions),
		editBase,
		writeBase,
	};
}