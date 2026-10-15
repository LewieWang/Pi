/**
 * Per-session token-usage accumulator.
 *
 * We accumulate raw token counts and per-turn deltas, then expose formatters
 * for the two report styles:
 *
 *   - per-turn (turn_end): a single line showing this turn's tokens and the
 *     running session total.
 *   - per-session (agent_settled): a multi-line block summarizing the
 *     whole session, plus averages and cache-hit ratios.
 */

export interface TokenUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h?: number;
	readonly reasoning?: number;
}

export function zeroUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		input: a.input + (b.input || 0),
		output: a.output + (b.output || 0),
		cacheRead: a.cacheRead + (b.cacheRead || 0),
		cacheWrite: a.cacheWrite + (b.cacheWrite || 0),
		cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) || undefined,
		reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) || undefined,
	};
}

export interface SessionStats {
	readonly total: TokenUsage;
	readonly turns: number;
	readonly assistantMessages: number;
	readonly userMessages: number;
	readonly toolResults: number;
	readonly firstTurnAt: number | null;
	readonly lastTurnAt: number | null;
}

export function emptyStats(): SessionStats {
	return {
		total: zeroUsage(),
		turns: 0,
		assistantMessages: 0,
		userMessages: 0,
		toolResults: 0,
		firstTurnAt: null,
		lastTurnAt: null,
	};
}

export function addTurn(
	stats: SessionStats,
	usage: TokenUsage,
	ts: number,
): SessionStats {
	return {
		...stats,
		total: addUsage(stats.total, usage),
		turns: stats.turns + 1,
		assistantMessages: stats.assistantMessages + 1,
		firstTurnAt: stats.firstTurnAt ?? ts,
		lastTurnAt: ts,
	};
}

export function addUserMessage(stats: SessionStats): SessionStats {
	return { ...stats, userMessages: stats.userMessages + 1 };
}

export function addToolResult(stats: SessionStats, count = 1): SessionStats {
	return { ...stats, toolResults: stats.toolResults + count };
}

export function cacheHitRatio(stats: SessionStats): number {
	const denom = stats.total.input + stats.total.cacheRead;
	if (denom <= 0) return 0;
	return stats.total.cacheRead / denom;
}

export function cacheHitSavings(stats: SessionStats, writeReadRatio: number): number {
	// Approximation: cache reads save `cacheRead * writeReadRatio` tokens of
	// re-send cost compared to a fresh context. For our zero-cost models this
	// is the *length* we did not retransmit, not a dollar figure.
	return Math.round(stats.total.cacheRead * writeReadRatio);
}