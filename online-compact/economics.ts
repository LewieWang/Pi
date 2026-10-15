/**
 * Online Context Compact economics.
 *
 * Reference: SoL-Pi src/sol-pi/extensions/online-context-compact/economics.ts
 *
 * A simplified version. We model the "is it worth compacting now?" decision
 * with a small set of inputs that are available in v1.2.0:
 *
 *   - writeTokens        : estimated context tokens before compaction
 *   - contextWindow      : total context window
 *   - completionBoundary : did the last turn end a plan step? (boolean)
 *   - requestsSinceLast  : requests since the previous compaction
 *   - cacheWriteReadRatio: 1.0 for our models (no cache discount)
 *
 * The policy: compact when context is over a high-water mark AND we just hit a
 * natural boundary (a plan step finished), AND the cycle is long enough that
 * the cost of recompiling this much context on the next turn is more than the
 * cost of a one-shot summarization.
 */

import type { OnlineState } from "./state.js";

export const DEFAULT_HIGH_WATER_RATIO = 0.7;
export const DEFAULT_LOW_WATER_RATIO = 0.4;
export const DEFAULT_MIN_REQUESTS_BETWEEN = 4;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export interface CompactionEconomics {
	readonly highWaterRatio: number;
	readonly lowWaterRatio: number;
	readonly minRequestsBetween: number;
	readonly keepRecentTokens: number;
}

export const DEFAULT_ECONOMICS: CompactionEconomics = {
	highWaterRatio: DEFAULT_HIGH_WATER_RATIO,
	lowWaterRatio: DEFAULT_LOW_WATER_RATIO,
	minRequestsBetween: DEFAULT_MIN_REQUESTS_BETWEEN,
	keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
};

export interface CompactionInputs {
	readonly writeTokens: number;
	readonly contextWindow: number | null;
	readonly completionBoundary: boolean;
	readonly requestsSinceLast: number | null;
	readonly cacheWriteReadRatio: number | null;
	readonly economics: CompactionEconomics;
}

export interface CompactionDecision {
	readonly compact: boolean;
	readonly reason: string;
	readonly archiveTokens: number;
	readonly memoTokens: number;
	readonly postCompactionTokens: number;
}

export interface AbortGateDecision {
	readonly fire: boolean;
	readonly reason: string | null;
}

/**
 * State-based gate that decides whether we actually abort the in-flight
 * response. Called AFTER `decideCompaction` has decided "yes, compact".
 *
 * Two reasons we skip even when `decideCompaction` said compact:
 *
 *   1. **Empty plan** — without a plan there is nothing to hand off. abort
 *      would interrupt the model, then `planSafe` would skip the
 *      compaction, and we'd loop forever: abort → abort → abort with no
 *      actual compaction happening. This was the bug observed in session
 *      `2026-10-15T06-40-47-400Z` (3 aborts in 4 minutes, ratio 0.7+, no
 *      actual compact).
 *
 *   2. **First ever request** — `lastCompactionRequestCount === null`
 *      means `requestsSinceLast` in `decideCompaction` is `null`, which
 *      short-circuits the "too-soon" check. We want at least one full
 *      cycle before we consider compacting.
 *
 * Pure function — safe to unit-test directly.
 */
export function shouldFireAbort(state: OnlineState): AbortGateDecision {
	if (state.plan.steps.length === 0) {
		return { fire: false, reason: "empty-plan" };
	}
	if (state.lastCompactionRequestCount === null) {
		return { fire: false, reason: "first-request" };
	}
	return { fire: true, reason: null };
}

const POST_COMPACTION_TOKEN_ESTIMATE = 1_000;

export function decideCompaction(input: CompactionInputs): CompactionDecision {
	const { economics } = input;
	if (input.contextWindow === null || input.contextWindow <= 0) {
		return fail("no-context-window");
	}
	if (!input.completionBoundary) {
		return fail("no-boundary");
	}
	if (input.requestsSinceLast !== null && input.requestsSinceLast < economics.minRequestsBetween) {
		return fail("too-soon", `last=${input.requestsSinceLast} min=${economics.minRequestsBetween}`);
	}
	const ratio = input.writeTokens / input.contextWindow;
	if (ratio < economics.highWaterRatio) {
		return fail("below-high-water", `ratio=${ratio.toFixed(3)}`);
	}

	const archiveTokens = Math.max(0, input.writeTokens - economics.keepRecentTokens);
	const memoTokens = POST_COMPACTION_TOKEN_ESTIMATE;
	const postCompactionTokens = economics.keepRecentTokens + memoTokens;

	// Cost model:
	//   1. The cache-write cost to repopulate context is `archiveTokens * ratio`.
	//      ratio = 1.0 for our MiniMax-M3 model (no cache discount).
	//   2. The memo tokens are a one-shot generation cost (memoTokens).
	//   3. We save `archiveTokens - memoTokens` on every subsequent request
	//      until the agent re-fills the context.
	// We compact when net savings per turn > 0:
	//   (archive - memo) - (archive * ratio) > memo
	//   archive * (1 - ratio) > 2 * memo
	const cacheFactor = input.cacheWriteReadRatio ?? 1.0;
	if (archiveTokens <= 0) return fail("not-enough-archive");
	const netSavings = archiveTokens * (1 - cacheFactor) - memoTokens;
	if (netSavings <= 0) {
		return fail(
			"cache-debt-too-high",
			`net=${Math.round(netSavings)} archive=${archiveTokens} ratio=${cacheFactor} memo=${memoTokens}`,
		);
	}

	return {
		compact: true,
		reason: "high-water-and-boundary",
		archiveTokens,
		memoTokens,
		postCompactionTokens,
	};
}

function fail(reason: string, detail?: string): CompactionDecision {
	return {
		compact: false,
		reason: detail ? `${reason} (${detail})` : reason,
		archiveTokens: 0,
		memoTokens: 0,
		postCompactionTokens: 0,
	};
}