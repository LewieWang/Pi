/**
 * Per-session Online State.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/online-context-compact/state.ts
 *
 * We persist this as a session entry so the model (or a follow-up agent
 * run) can recover the plan after a /tree or compaction. In v1.2.0 we use
 * a custom session entry via pi.appendEntry().
 */

import type { PlanSnapshot } from "./plan.js";

export const ONLINE_STATE_ENTRY_TYPE = "harness-online-compact-state";

export interface OnlineState {
	readonly plan: PlanSnapshot;
	readonly requestCount: number;
	readonly lastCompactionRequestCount: number | null;
	readonly nativeCompactionCount: number;
	readonly positiveContextDeltaCount: number;
	readonly positiveContextDeltaTotal: number;
	readonly cacheDebtTokens: number;
	readonly cacheDebtRepaymentTokens: number;
	readonly completedBoundaryRequestCounts: number[];
}

export function initialOnlineState(): OnlineState {
	return {
		plan: { steps: [], updatedAt: 0 },
		requestCount: 0,
		lastCompactionRequestCount: null,
		nativeCompactionCount: 0,
		positiveContextDeltaCount: 0,
		positiveContextDeltaTotal: 0,
		cacheDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		completedBoundaryRequestCounts: [],
	};
}

export function recordProviderRequest(state: OnlineState, contextTokens: number): OnlineState {
	const previous = state.positiveContextDeltaTotal;
	const delta = Math.max(0, contextTokens - previous);
	if (delta > 0) {
		return {
			...state,
			requestCount: state.requestCount + 1,
			positiveContextDeltaCount: state.positiveContextDeltaCount + 1,
			positiveContextDeltaTotal: state.positiveContextDeltaTotal + delta,
		};
	}
	return { ...state, requestCount: state.requestCount + 1 };
}

export function recordBoundary(state: OnlineState): OnlineState {
	return {
		...state,
		completedBoundaryRequestCounts: [
			...state.completedBoundaryRequestCounts,
			state.requestCount,
		],
	};
}

export function recordCompaction(
	state: OnlineState,
	archiveTokens: number,
	memoTokens: number,
): OnlineState {
	return {
		...state,
		nativeCompactionCount: state.nativeCompactionCount + 1,
		lastCompactionRequestCount: state.requestCount,
		cacheDebtTokens: Math.max(0, state.cacheDebtTokens + archiveTokens - memoTokens),
		cacheDebtRepaymentTokens: 0,
	};
}