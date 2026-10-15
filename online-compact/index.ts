/**
 * Online Context Compact — extension entry point.
 *
 * Triggers Pi's native context compaction at natural plan-step boundaries
 * when the context is over the configured high-water mark. After a
 * successful compaction we send a short continuation message that reminds
 * the agent of the plan.
 *
 * The decision logic lives in economics.ts. Plan tracking lives in
 * plan.ts. Per-session state lives in state.ts.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/online-context-compact/extension.ts
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readConfig } from "../shared/config.js";
import { createJournal, type Journal } from "../shared/journal.js";
import {
	DEFAULT_ECONOMICS,
	decideCompaction,
	shouldFireAbort,
	type CompactionDecision,
	type CompactionEconomics,
} from "./economics.js";
import {
	analyzePlanTransition,
	emptyPlan,
	firstIncompleteStep,
	formatPlanSnapshot,
	parsePlanSteps,
	type PlanSnapshot,
	type PlanStep,
} from "./plan.js";
import {
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordProviderRequest,
	type OnlineState,
} from "./state.js";

export interface OnlineContextCompactOptions {
	readonly economics?: Partial<CompactionEconomics>;
	readonly forceEnable?: boolean;
}

const POST_COMPACTION_REMINDER =
	"Online context compact just summarized the conversation. Continue the remaining work " +
	"from the current plan; the active task is still in progress.";

function appendPlanHandoff(pi: ExtensionAPI, plan: PlanSnapshot): void {
	const next = firstIncompleteStep(plan);
	if (!next) {
		pi.appendEntry("harness-online-compact-handoff", {
			plan: plan.steps,
			updatedAt: plan.updatedAt,
			note: "all-steps-completed",
		});
		return;
	}
	pi.appendEntry("harness-online-compact-handoff", {
		plan: plan.steps,
		nextStep: { id: next.id, goal: next.goal },
		updatedAt: plan.updatedAt,
	});
}

function readStateFromContext(context: ExtensionContext): OnlineState {
	const branch = context.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!entry) continue;
		if (entry.type === "custom" && (entry as { customType?: string }).customType === "harness-online-compact-state") {
			const content = (entry as { content?: unknown }).content;
			if (content && typeof content === "object") {
				return { ...initialOnlineState(), ...(content as Partial<OnlineState>) };
			}
		}
	}
	return initialOnlineState();
}

function saveState(pi: ExtensionAPI, state: OnlineState): void {
	pi.appendEntry("harness-online-compact-state", state);
}

function contextTokens(context: ExtensionContext): { tokens: number; window: number | null } {
	const usage = context.getContextUsage();
	if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
		return { tokens: usage.tokens, window: usage.contextWindow };
	}
	if (usage && typeof usage.contextWindow === "number") {
		return { tokens: 0, window: usage.contextWindow };
	}
	const modelWindow = context.model?.contextWindow;
	return { tokens: 0, window: typeof modelWindow === "number" ? modelWindow : null };
}

export function createOnlineContextCompactExtension(
	options: OnlineContextCompactOptions = {},
): ExtensionFactory {
	const economics: CompactionEconomics = { ...DEFAULT_ECONOMICS, ...options.economics };

	return (pi: ExtensionAPI) => {
		const journal = createJournal();
		const perContext = new WeakMap<ExtensionContext, Runtime>();

		const getRuntime = (context: ExtensionContext): Runtime => {
			let r = perContext.get(context);
			if (!r) {
				r = {
					state: readStateFromContext(context),
					pendingBoundary: false,
					pendingDecision: undefined,
					postCompactionPending: false,
					configChecked: false,
				};
				perContext.set(context, r);
			}
			return r;
		};

		const enabled = (context: ExtensionContext): boolean => {
			if (options.forceEnable) return true;
			try {
				const cfg = readConfig({ projectTrusted: context.isProjectTrusted() });
				return cfg.onlineContextCompact;
			} catch {
				return false;
			}
		};

		pi.registerTool({
			name: "update_plan",
			label: "Update Plan",
			description:
				"Record progress on the agent's plan. Pass the full list of steps with their current status. " +
				"This is what triggers Online Context Compact: marking a step as 'completed' is a natural boundary.",
			promptSnippet: "Update the agent's plan to record progress on a step",
			parameters: Type.Object({
				steps: Type.Array(
					Type.Object({
						id: Type.String({ description: "Stable step id, e.g. 'implement-validation'" }),
						goal: Type.String({ description: "What this step aims to do" }),
						status: Type.Union([
							Type.Literal("pending"),
							Type.Literal("in_progress"),
							Type.Literal("completed"),
						]),
					}),
				),
			}),
			async execute(
				toolCallId: string,
				params: Record<string, unknown>,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			) {
				if (!enabled(ctx)) {
					return {
						content: [
							{ type: "text", text: "[update_plan] Online Context Compact is disabled" },
						],
						details: { ok: false, reason: "disabled" },
					};
				}
				const steps = parsePlanSteps(params.steps);
				if (!steps || steps.length === 0) {
					return {
						content: [{ type: "text", text: "Plan must contain at least one valid step" }],
						details: { ok: false, reason: "empty" },
					};
				}
				const r = getRuntime(ctx);
				const plan: PlanSnapshot = { steps, updatedAt: Date.now() };
				const transition = analyzePlanTransition(r.state.plan, steps);
				r.state = { ...r.state, plan };
				if (transition.completedSteps.length > 0) {
					r.state = recordBoundary(r.state);
					r.pendingBoundary = true;
				}
				void ctx;
				void toolCallId;
				saveState(pi, r.state);
				await journal.record({
					kind: "online_compact_plan",
					stepCount: steps.length,
					completed: transition.completedSteps.map((s) => s.id),
				});
				return {
					content: [
						{ type: "text", text: [formatPlanSnapshot(plan), ...transition.advice].join("\n") },
					],
					details: {
						ok: true,
						boundary: transition.completedSteps.length > 0,
						completed: transition.completedSteps.map((s) => s.id),
					},
				} as never;
			},
		});

		pi.on("session_start", (_event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			void journal.record({ kind: "online_compact_session_start" });
			void r;
		});

		pi.on("before_provider_request", (_event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			const { tokens } = contextTokens(context);
			r.state = recordProviderRequest(r.state, tokens);
			saveState(pi, r.state);
		});

		pi.on("turn_end", async (event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			// Heuristic boundary: any non-`update_plan` successful tool result in
			// the turn marks progress on the current plan step.
			const hadMeaningfulWork = event.toolResults.some(
				(tr) => tr.toolName !== "update_plan" && !tr.isError,
			);
			if (hadMeaningfulWork) r.pendingBoundary = true;

			if (!r.pendingBoundary) return;
			r.pendingBoundary = false;
			if (event.message.role !== "assistant" || event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				return;
			}

			const { tokens, window } = contextTokens(context);
			const cfg = (() => {
				try {
					return readConfig({ projectTrusted: context.isProjectTrusted() });
				} catch {
					return null;
				}
			})();
			const cacheWriteReadRatio = cfg?.cacheWriteReadRatio ?? null;
			const requestsSinceLast =
				r.state.lastCompactionRequestCount === null
					? null
					: r.state.requestCount - r.state.lastCompactionRequestCount;
			const decision: CompactionDecision = decideCompaction({
				writeTokens: tokens,
				contextWindow: window,
				completionBoundary: true,
				requestsSinceLast,
				cacheWriteReadRatio,
				economics,
			});
			await journal.record({
				kind: "online_compact_decision",
				compact: decision.compact,
				reason: decision.reason,
				archiveTokens: decision.archiveTokens,
				memoTokens: decision.memoTokens,
				writeTokens: tokens,
				contextWindow: window,
			});
			if (!decision.compact) return;
			// State-based gate: don't abort if there's no plan to hand off
			// (would loop forever) or if this is the first request we've
			// ever seen (decideCompaction's "too-soon" check is null-
			// short-circuited in that case). Without this gate, an agent
			// that never calls update_plan gets its post-tool turns
			// aborted indefinitely without any compaction actually
			// happening. See session 2026-10-15T06-40-47-400Z.
			const gate = shouldFireAbort(r.state);
			if (!gate.fire) {
				// gate.reason is always non-null when fire=false
				await journal.record({
					kind: "online_compact_skipped",
					reason: gate.reason as string,
				});
				return;
			}
			r.pendingDecision = decision;
			// Mark that a compact is in flight so the agent_settled handler
			// can act on it.
			void context.abort();
		});

		pi.on("agent_settled", (event, context) => {
			if (!enabled(context)) return;
			if (event.aborted === false && context.isIdle() === false) return;
			const r = getRuntime(context);
			const decision = r.pendingDecision;
			r.pendingDecision = undefined;
			if (!decision) return;

			void journal.record({
				kind: "online_compact_trigger",
				archiveTokens: decision.archiveTokens,
				memoTokens: decision.memoTokens,
			});
			void planSafe(pi, r.state.plan, r, context, journal);
		});

		pi.on("session_compact", (event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			if (event.fromExtension) {
				const decision = r.pendingDecision;
				const archive = decision?.archiveTokens ?? 0;
				const memo = decision?.memoTokens ?? 0;
				r.state = recordCompaction(r.state, archive, memo);
				r.pendingDecision = undefined;
				r.postCompactionPending = true;
				saveState(pi, r.state);
				void journal.record({
					kind: "online_compact_applied",
					archiveTokens: archive,
					memoTokens: memo,
				});
			} else {
				// Native /compact or threshold trigger. Treat as a non-extension compact.
				r.state = recordCompaction(r.state, 0, 0);
				saveState(pi, r.state);
				void journal.record({
					kind: "online_compact_applied",
					archiveTokens: 0,
					memoTokens: 0,
					reason: "native",
				});
			}
		});

		pi.on("session_compact_failed", (event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			r.pendingDecision = undefined;
			void journal.record({
				kind: "online_compact_failure",
				aborted: event.aborted,
				reason: event.errorMessage ?? "unknown",
			});
			void r;
		});

		pi.on("turn_start", (_event, context) => {
			if (!enabled(context)) return;
			const r = getRuntime(context);
			if (r.postCompactionPending) {
				r.postCompactionPending = false;
				pi.sendMessage(
					{
						customType: "harness-online-compact-handoff",
						content: POST_COMPACTION_REMINDER,
						display: false,
					},
					{ triggerTurn: true },
				);
			}
		});
	};
}

interface Runtime {
	state: OnlineState;
	pendingBoundary: boolean;
	pendingDecision: CompactionDecision | undefined;
	postCompactionPending: boolean;
	configChecked: boolean;
}

function planSafe(
	pi: ExtensionAPI,
	plan: PlanSnapshot,
	r: Runtime,
	context: ExtensionContext,
	journal: Journal,
): void {
	if (plan.steps.length === 0) {
		void journal.record({ kind: "online_compact_skipped", reason: "empty-plan" });
		return;
	}
	const beforeFirst = firstIncompleteStep(plan);
	if (!beforeFirst) {
		void journal.record({ kind: "online_compact_skipped", reason: "all-completed" });
		return;
	}
	appendPlanHandoff(pi, plan);
	r.postCompactionPending = true;
	void context;
}

export default function onlineContextCompactExtension(pi: ExtensionAPI): void {
	createOnlineContextCompactExtension()(pi);
}