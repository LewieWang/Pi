/**
 * Decision journal — append-only JSONL log of every harness decision.
 *
 * Lives under `~/.pi/agent/decisions.jsonl` per AGENTS.md §L.
 *
 * Format: one JSON object per line, ISO timestamp prefix. Fields are
 * intentionally narrow — enough to reconstruct "what did the harness do"
 * without depending on Pi's session log.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir as osHomedir } from "node:os";

const JOURNAL_PATH = join(osHomedir(), ".pi", "agent", "decisions.jsonl");
/** Default decisions.jsonl path — harness-journal reads decision windows from it. */
export const DEFAULT_JOURNAL_PATH = JOURNAL_PATH;

/**
 * Format a Date as a wall-clock string in the *local* timezone, including
 * the explicit UTC offset, e.g. `"2026-10-15 15:33:25+08:00"`. The offset
 * is included so a reader on a different machine can still reconstruct
 * the exact UTC instant.
 *
 * Pure function — exposed for tests.
 */
export function formatLocalTime(d: Date = new Date()): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const HH = String(d.getHours()).padStart(2, "0");
	const MM = String(d.getMinutes()).padStart(2, "0");
	const SS = String(d.getSeconds()).padStart(2, "0");

	// getTimezoneOffset() returns minutes-WEST-of-UTC (e.g. -480 for CST).
	// Flip sign to get east-of-UTC convention.
	const offsetMin = -d.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	const offHH = String(Math.floor(abs / 60)).padStart(2, "0");
	const offMM = String(abs % 60).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}${sign}${offHH}:${offMM}`;
}

export type JournalEvent =
	// Config / tools
	| { kind: "config_loaded"; config: Record<string, unknown> }
	| { kind: "tools_registered"; names: readonly string[] }
	// Harness Journal
	| { kind: "harness_journal_init"; sessionId: string; fingerprint: string; fileCount: number; dir: string }
	| {
			kind: "harness_journal_score";
			sessionId: string;
			fingerprint: string;
			turns: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			reasoning: number;
			obsPacks: number;
			reducerApplies: number;
			fusions: number;
	  }
	| { kind: "harness_journal_failure"; op: string; reason: string }
	// Action Fusion
	| {
			kind: "mutation";
			path: string;
			outcome: "ok" | "error";
	  }
	| {
			kind: "then_run";
			path: string;
			outcome: "succeeded" | "failed" | "skipped" | "no_command";
			duration_ms?: number;
			command?: string;
			reason?: string;
	  }
	// Observation Pack
	| {
			kind: "observation";
			id: string;
			tool: string;
			bytes: number;
			lines: number;
			tokens: number;
			content_hash: string;
			request: number;
			send_number: number;
			placeholder: boolean;
			placeholder_tokens?: number;
			removed_tokens?: number;
	  }
	| { kind: "observation_failure"; id?: string; reason: string }
	| { kind: "observation_session_start"; root: string }
	| {
			kind: "obs_recall";
			id: string;
			offset: number;
			bytes: number;
			lines: number;
			next_offset: number;
			eof: boolean;
	  }
	// Evidence-Preserving Reducer
	| {
			kind: "reducer_candidate";
			toolCallId: string;
			toolName: string;
			command: string;
			sourceSha256: string;
			sourceBytes: number;
			sourceLines: number;
			isError: boolean;
	  }
	| {
			kind: "reducer_applied";
			toolCallId: string;
			toolName: string;
			sourceSha256: string;
			receiptSha256: string;
			receiptBytes: number;
			sourceBytes: number;
			savedBytes: number;
			evidenceCount: number;
			uncertain: boolean;
			status: "success" | "failure";
			ratio: number;
	  }
	| {
			kind: "reducer_fallback";
			toolCallId: string;
			sourceSha256?: string;
			reason: string;
			receiptBytes?: number;
			sourceBytes?: number;
			ratio?: number;
			error?: string;
	  }
	// Online Context Compact
	| { kind: "online_compact_session_start" }
	| { kind: "online_compact_plan"; stepCount: number; completed: readonly string[] }
	| {
			kind: "online_compact_decision";
			compact: boolean;
			reason: string;
			archiveTokens: number;
			memoTokens: number;
			writeTokens: number;
			contextWindow: number | null;
	  }
	| { kind: "online_compact_trigger"; archiveTokens: number; memoTokens: number }
	| {
			kind: "online_compact_applied";
			archiveTokens: number;
			memoTokens: number;
			reason?: string;
	  }
	| { kind: "online_compact_skipped"; reason: string }
	| { kind: "online_compact_failure"; aborted: boolean; reason: string }
	// Token Tracker
	| {
			kind: "token_turn";
			turnIndex: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalInput: number;
			totalOutput: number;
			totalCacheRead: number;
			totalCacheWrite: number;
	  }
	| {
			kind: "token_session";
			turns: number;
			messages: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cacheHit: number;
			durationMs: number | null;
	  };

export interface Journal {
	record(event: JournalEvent): Promise<void>;
}

export function createJournal(path: string = JOURNAL_PATH): Journal {
	const write = async (event: JournalEvent): Promise<void> => {
		const now = new Date();
		// Both `timestamp` (UTC ISO with Z) and `localTime` (wall-clock in
		// the local timezone, with offset) are written so the journal is
		// unambiguous regardless of the reader's timezone. See session
		// 2026-10-15T07-15-55Z where the user noticed UTC vs CST confusion.
		const line = JSON.stringify({
			timestamp: now.toISOString(),
			localTime: formatLocalTime(now),
			...event,
		});
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${line}\n`, "utf8");
	};
	return { record: write };
}

/** No-op journal for unit tests and opt-out. */
export const silentJournal: Journal = {
	record: async () => {},
};