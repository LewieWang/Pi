/**
 * Projection — replace large tool results with placeholders.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/observation-pack/index.ts::pi.on("context")
 *
 * We run as a `pi.on("context")` handler. The handler sees the canonical
 * message list and returns a transformed version. Stored session history is
 * untouched; only the projection the provider sees is changed.
 *
 * The handler is fail-open: if archiving or placeholdering throws, we return
 * the original messages so the agent still gets its observation.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isPureTextResult,
	placeholderFor,
	type Observation,
} from "./observation.js";
import { runtimeRoot } from "../shared/runtime-root.js";
import type { Journal } from "../shared/journal.js";

interface SessionState {
	/** observation root (one per session) */
	root: string;
	/** priorAssistantCounts[i] = number of assistant messages after message i */
	priorAssistantCounts: number[];
	/** requestIndex = assistantCount + 1 (1-based provider request count) */
	requestIndex: number;
	/** Map from observation id to count of full-send and placeholder-send events */
	sentCounts: Map<string, number>;
}

const states = new WeakMap<ExtensionContext, SessionState>();
const stateByToolPath = new Map<string, SessionState>();

function getState(ctx: ExtensionContext, journal: Journal): SessionState {
	let state = states.get(ctx);
	if (state) return state;
	// WeakMap keys are weak so we also keep a strong map keyed by cwd for non-weakly-held contexts.
	const key = `${ctx.cwd}|${ctx.sessionManager.getSessionId()}`;
	state = stateByToolPath.get(key);
	if (state) {
		states.set(ctx, state);
		return state;
	}
	state = {
		root: runtimeRoot(ctx, "observation-pack"),
		priorAssistantCounts: [],
		requestIndex: 1,
		sentCounts: new Map(),
	};
	stateByToolPath.set(key, state);
	states.set(ctx, state);
	void mkdir(state.root, { recursive: true });
	void journal.record({ kind: "observation_session_start", root: state.root });
	return state;
}

export function createProjectionHandler(pi: ExtensionAPI, journal: Journal) {
	return async function onContext(
		event: { messages: unknown[] },
		ctx: ExtensionContext,
	): Promise<{ messages: unknown[] } | undefined> {
		const messages = event.messages;
		if (!Array.isArray(messages)) return undefined;

		const state = getState(ctx, journal);

		// Walk backwards to compute assistant counts after each message.
		const priorAssistantCounts = new Array<number>(messages.length);
		let assistantCount = 0;
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			priorAssistantCounts[i] = assistantCount;
			const m = messages[i] as { role?: unknown };
			if (m && m.role === "assistant") assistantCount += 1;
		}
		state.priorAssistantCounts = priorAssistantCounts;
		state.requestIndex = assistantCount + 1;

		const projected = messages.slice();

		for (let i = 0; i < messages.length; i += 1) {
			const message = messages[i];
			if (!message || !isPureTextResult(message as never)) continue;

			let observation: Observation | null;
			try {
				observation = createObservation(message as never);
			} catch (error) {
				// Fail open: a parsing failure must never cost the agent its observation.
				void journal.record({
					kind: "observation_failure",
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (!observation) continue;

			try {
				await ensureStored(state.root, observation);

				const priorSends = state.sentCounts.get(observation.id) ?? priorAssistantCounts[i] ?? 0;
				if (priorSends < FULL_SENDS) {
					await journal.record({
						kind: "observation",
						id: observation.id,
						tool: observation.toolName,
						bytes: observation.bytes,
						lines: observation.lines,
						tokens: observation.tokens,
						content_hash: observation.contentHash,
						request: state.requestIndex,
						send_number: priorSends + 1,
						placeholder: false,
					});
					state.sentCounts.set(observation.id, priorSends + 1);
					continue;
				}

				const placeholder = placeholderFor(observation);
				const placeholderTokens = estimateTokens(placeholder);
				const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
				await journal.record({
					kind: "observation",
					id: observation.id,
					tool: observation.toolName,
					bytes: observation.bytes,
					lines: observation.lines,
					tokens: observation.tokens,
					content_hash: observation.contentHash,
					request: state.requestIndex,
					send_number: priorSends + 1,
					placeholder: true,
					placeholder_tokens: placeholderTokens,
					removed_tokens: removedTokens,
				});
				projected[i] = replaceContentWithPlaceholder(message, placeholder);
				state.sentCounts.set(observation.id, priorSends + 1);
			} catch (error) {
				void journal.record({
					kind: "observation_failure",
					id: observation.id,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return { messages: projected };
	};
}

function replaceContentWithPlaceholder(message: unknown, placeholder: string): unknown {
	const m = message as { content?: unknown };
	const newContent = [{ type: "text", text: placeholder }];
	return { ...m, content: newContent };
}

/** Helper to expose a TUI badge that shows when a placeholder replaced a result. */
export function placeholderBadge(): unknown {
	return "📦 Observation Pack · placeholder";
}

// Side-effect-free import to silence unused warning for `join`.
void join;