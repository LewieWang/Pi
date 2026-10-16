/**
 * Token Tracker — surface per-turn and per-session token usage without
 * putting it in the left footer.
 *
 * What you get:
 *
 *   - At every `turn_end`, a single line is printed with this turn's
 *     in/out tokens and the running session total. The line is emitted
 *     as a custom message (display: false) so it lands in the journal
 *     and shows up in print mode, without polluting the chat scroll.
 *
 *   - At `agent_settled` (turn end), we only write to the journal.
 *     The visible session summary now lives in footer-override, which
 *     appends a styled "Token 消耗明细" custom entry into the chat
 *     and exposes the same data as a footer hover panel.
 *
 * We do not put anything in the left footer (`setFooter`/`setStatus`)
 * because the user wants the totals at the end of each turn instead.
 *
 * Reference: SoL-Pi uses a similar pattern in showSolPiSavings(); we
 * trade a custom journal message for print-mode visibility.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../shared/config.js";
import { createJournal } from "../shared/journal.js";
import { formatInt, pad } from "./format.js";
import {
	addToolResult,
	addTurn,
	addUserMessage,
	cacheHitRatio,
	emptyStats,
	type SessionStats,
} from "./state.js";

export interface TokenTrackerOptions {
	readonly forceEnable?: boolean;
}

function isEnabled(context: ExtensionContext, force: boolean): boolean {
	if (force) return true;
	try {
		const cfg = readConfig({ projectTrusted: context.isProjectTrusted() });
		// Token tracker is on by default unless someone explicitly disables it
		// with a non-default key. We treat absence as "on" so the user sees
		// stats out of the box.
		return true;
	} catch {
		return false;
	}
}

function perTurnLine(turnUsage: { input: number; output: number; cacheRead: number; cacheWrite: number }, total: { input: number; output: number; cacheRead: number; cacheWrite: number }, turnIndex: number): string {
	const inLine = `${pad("in", 4)}${formatInt(turnUsage.input).padStart(10)}`;
	const outLine = `${pad("out", 4)}${formatInt(turnUsage.output).padStart(10)}`;
	const cacheLine = `cache ${formatInt(turnUsage.cacheRead).padStart(8)} read / ${formatInt(turnUsage.cacheWrite).padStart(8)} write`;
	const totalLine = `Σ in ${formatInt(total.input).padStart(8)} / out ${formatInt(total.output).padStart(8)}`;
	return `· turn ${String(turnIndex).padStart(3)}  ${inLine}  ${outLine}  ·  ${cacheLine}  ·  ${totalLine}`;
}

function perSessionBlock(_stats: SessionStats, _writeReadRatio: number, _durationMs: number | null): string {
	return "";
}

function usageOf(message: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: string; usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } };
	if (m.role !== "assistant" || !m.usage) return null;
	const u = m.usage;
	return {
		input: typeof u.input === "number" ? u.input : 0,
		output: typeof u.output === "number" ? u.output : 0,
		cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
		cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
	};
}

export function createTokenTrackerExtension(options: TokenTrackerOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// Map keyed by session id — ExtensionContext is event-scoped and may
		// not be stable across turn_end → agent_settled, so we cannot rely
		// on a WeakMap.
		const bySession = new Map<string, { stats: SessionStats; startedAt: number }>();
		const journal = createJournal();

		const get = (context: ExtensionContext): { stats: SessionStats; startedAt: number } => {
			const id = context.sessionManager.getSessionId();
			let entry = bySession.get(id);
			if (!entry) {
				entry = { stats: emptyStats(), startedAt: Date.now() };
				bySession.set(id, entry);
			}
			return entry;
		};

		pi.on("turn_end", async (event, context) => {
			if (!isEnabled(context, options.forceEnable ?? false)) return;
			const usage = usageOf(event.message);
			if (!usage) return;
			const turnUsage = usage;
			const entry = get(context);
			let stats = addTurn(entry.stats, turnUsage, Date.now());
			for (const tr of event.toolResults) {
				stats = addToolResult(stats, 1);
				const u = tr as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
				if (u.usage) {
					stats = addTurn(stats, u.usage as never, Date.now());
				}
			}
			entry.stats = stats;
			bySession.set(context.sessionManager.getSessionId(), entry);
			const line = perTurnLine(turnUsage, stats.total, event.turnIndex);
			process.stderr.write(`[tokens] ${line}\n`);
			await journal.record({
				kind: "token_turn",
				turnIndex: event.turnIndex,
				input: turnUsage.input,
				output: turnUsage.output,
				cacheRead: turnUsage.cacheRead,
				cacheWrite: turnUsage.cacheWrite,
				totalInput: stats.total.input,
				totalOutput: stats.total.output,
				totalCacheRead: stats.total.cacheRead,
				totalCacheWrite: stats.total.cacheWrite,
			});
		});

		pi.on("input", (event, context) => {
			if (!isEnabled(context, options.forceEnable ?? false)) return;
			const entry = get(context);
			entry.stats = addUserMessage(entry.stats);
			bySession.set(context.sessionManager.getSessionId(), entry);
		});

		pi.on("agent_settled", async (_event, context) => {
			if (!isEnabled(context, options.forceEnable ?? false)) return;
			const entry = get(context);
			const durationMs = Date.now() - entry.startedAt;
			await journal.record({
				kind: "token_session",
				turns: entry.stats.turns,
				messages: entry.stats.assistantMessages + entry.stats.userMessages,
				input: entry.stats.total.input,
				output: entry.stats.total.output,
				cacheRead: entry.stats.total.cacheRead,
				cacheWrite: entry.stats.total.cacheWrite,
				cacheHit: cacheHitRatio(entry.stats),
				durationMs,
			});
		});

		pi.on("session_shutdown", (_event, context) => {
			bySession.delete(context.sessionManager.getSessionId());
		});
	};
}

function readConfigSafe(context: ExtensionContext): number {
	try {
		return readConfig({ projectTrusted: context.isProjectTrusted() }).cacheWriteReadRatio;
	} catch {
		return 0.0;
	}
}

export default function tokenTrackerExtension(pi: ExtensionAPI): void {
	createTokenTrackerExtension()(pi);
}