/**
 * Harness Journal — pure snapshot/score/retention logic.
 *
 * No pi imports here: everything is plain filesystem + data transforms so
 * unit tests can drive it deterministically.
 *
 * Design references:
 *   - Meta-Harness (arXiv:2603.28052): keep the FULL history of harness
 *     candidates (source hashes), trajectories and scores on the filesystem;
 *     no lossy summarization at this layer.
 *   - EvoTrainer (arXiv:2606.03108): Memory + Skill bank — durable
 *     analyzer-skills / repair-strategies / procedure-templates.
 *   - ERA (Nature, 2026): per-fingerprint scores are the quality signal a
 *     later PUCT-style harness search will optimize over.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../shared/sha256.js";

// ---------------------------------------------------------------------------
// Harness snapshot / fingerprint
// ---------------------------------------------------------------------------

/** Directories that never belong to harness identity. */
export const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	".pi-uploads",
	"sessions",
	"coverage",
]);

/** File basenames that always belong to harness identity (if present). */
const ALWAYS_INCLUDE = new Set(["package.json", "tsconfig.json"]);

/**
 * Recursively list harness source files under `root`, as sorted relative
 * POSIX-style paths. Includes *.ts and the always-include basenames.
 */
export function listSourceFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable subtree → skip (fail-open)
		}
		for (const entry of entries) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), relPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (ALWAYS_INCLUDE.has(entry.name) || entry.name.endsWith(".ts")) {
				out.push(relPath);
			}
		}
	};
	walk(root, "");
	return out.sort((a, b) => a.localeCompare(b));
}

/** Hash the given files (relative to `root`). Unreadable files are skipped. */
export function hashFiles(
	root: string,
	relPaths: readonly string[],
): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const rel of relPaths) {
		try {
			hashes[rel] = sha256(readFileSync(join(root, rel)));
		} catch {
			// File vanished between listing and hashing → skip.
		}
	}
	return hashes;
}

/** Canonical JSON (recursively sorted object keys) for stable hashing. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Hash of the effective sol-pi config (key-order independent). */
export function configFingerprint(config: unknown): string {
	return sha256(stableStringify(config));
}

/**
 * Harness fingerprint = sha256 over (sorted file hashes + config hash).
 * Same code + same config across sessions ⇒ same fingerprint ⇒ the
 * fingerprints/<fp>.json snapshot file is deduped.
 */
export function computeFingerprint(
	fileHashes: Readonly<Record<string, string>>,
	configHash: string,
): string {
	const entries = Object.entries(fileHashes).sort(([a], [b]) => a.localeCompare(b));
	return sha256(JSON.stringify({ configHash, files: entries }));
}

// ---------------------------------------------------------------------------
// Per-session usage totals (Meta-Harness: raw evidence, no compression)
// ---------------------------------------------------------------------------

export interface UsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly turns: number;
}

export function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0 };
}

/** Add one turn's usage (pi semantics: input already excludes cached tokens). */
export function addUsageTotals(
	totals: UsageTotals,
	usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		reasoning?: number;
	},
): UsageTotals {
	return {
		input: totals.input + (usage.input ?? 0),
		output: totals.output + (usage.output ?? 0),
		cacheRead: totals.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: totals.cacheWrite + (usage.cacheWrite ?? 0),
		reasoning: totals.reasoning + (usage.reasoning ?? 0),
		turns: totals.turns + 1,
	};
}

/** cacheRead / (input + cacheRead) — input is the uncached portion. */
export function cacheHitRate(totals: UsageTotals): number {
	const denom = totals.input + totals.cacheRead;
	if (denom <= 0) return 0;
	return totals.cacheRead / denom;
}

// ---------------------------------------------------------------------------
// Decision counters (obs / reducer / fusion) from decisions.jsonl windows
// ---------------------------------------------------------------------------

export interface DecisionCounters {
	readonly obsPacks: number;
	readonly obsSavedTokens: number;
	readonly reducerApplies: number;
	readonly reducerSavedBytes: number;
	readonly fusions: number;
}

export function emptyCounters(): DecisionCounters {
	return {
		obsPacks: 0,
		obsSavedTokens: 0,
		reducerApplies: 0,
		reducerSavedBytes: 0,
		fusions: 0,
	};
}

/**
 * Tally a single parsed decisions.jsonl event. Unrecognized kinds are
 * ignored (the journal is append-only and shared).
 */
export function reduceCounters(counters: DecisionCounters, event: unknown): DecisionCounters {
	if (typeof event !== "object" || event === null) return counters;
	const ev = event as Record<string, unknown>;
	switch (ev.kind) {
		case "observation":
			if (ev.placeholder === true) {
				return {
					...counters,
					obsPacks: counters.obsPacks + 1,
					obsSavedTokens: counters.obsSavedTokens + (Number(ev.removed_tokens) || 0),
				};
			}
			return counters;
		case "reducer_applied":
			return {
				...counters,
				reducerApplies: counters.reducerApplies + 1,
				reducerSavedBytes: counters.reducerSavedBytes + (Number(ev.savedBytes) || 0),
			};
		case "then_run":
			if (ev.outcome === "succeeded") {
				return { ...counters, fusions: counters.fusions + 1 };
			}
			return counters;
		default:
			return counters;
	}
}

/** Parse a JSONL window (already sliced) into decision counters. */
export function countDecisionLines(lines: readonly string[]): DecisionCounters {
	let counters = emptyCounters();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			counters = reduceCounters(counters, JSON.parse(trimmed));
		} catch {
			// Torn/partial line → skip (fail-open, evidence not fabricated).
		}
	}
	return counters;
}

// ---------------------------------------------------------------------------
// Retention planning
// ---------------------------------------------------------------------------

export interface DatedSession {
	readonly id: string;
	readonly mtimeMs: number;
}

/**
 * Return the session ids to DELETE so at most `maxSessions` newest remain.
 * Order by mtime ascending; oldest first out.
 */
export function planRetention(sessions: readonly DatedSession[], maxSessions: number): string[] {
	if (sessions.length <= maxSessions) return [];
	const sorted = [...sessions].sort((a, b) => a.mtimeMs - b.mtimeMs);
	return sorted.slice(0, sessions.length - maxSessions).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Skills bank schema (EvoTrainer Memory + Skill)
// ---------------------------------------------------------------------------

export const SKILL_KINDS = ["analyzer-skill", "repair-strategy", "procedure-template"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_DIRS: Readonly<Record<SkillKind, string>> = Object.freeze({
	"analyzer-skill": "analyzer-skills",
	"repair-strategy": "repair-strategies",
	"procedure-template": "procedure-templates",
});

export interface SkillRecord {
	readonly id: string;
	readonly kind: SkillKind;
	readonly title: string;
	readonly trigger: string;
	readonly steps: readonly string[];
	readonly evidence: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Structural validation for a skill JSON file. Returns error string or null. */
export function validateSkill(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return "skill must be a JSON object";
	const s = raw as Record<string, unknown>;
	for (const key of ["id", "kind", "title", "trigger", "steps", "evidence", "createdAt", "updatedAt"]) {
		if (!(key in s)) return `skill missing field: ${key}`;
	}
	if (!SKILL_KINDS.includes(s.kind as SkillKind)) return `unknown skill kind: ${String(s.kind)}`;
	if (typeof s.title !== "string" || s.title.trim() === "") return "title must be non-empty";
	if (typeof s.trigger !== "string") return "trigger must be a string";
	if (!Array.isArray(s.steps) || s.steps.some((x) => typeof x !== "string")) {
		return "steps must be string[]";
	}
	if (!Array.isArray(s.evidence) || s.evidence.some((x) => typeof x !== "string")) {
		return "evidence must be string[]";
	}
	return null;
}

/** List and validate all skill files in a skills bank directory. */
export function loadSkillsBank(skillsDir: string): {
	valid: SkillRecord[];
	invalid: { file: string; error: string }[];
} {
	const valid: SkillRecord[] = [];
	const invalid: { file: string; error: string }[] = [];
	for (const kind of SKILL_KINDS) {
		const dir = join(skillsDir, SKILL_DIRS[kind]);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			continue; // bank not created yet
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
				const error = validateSkill(raw);
				if (error) {
					invalid.push({ file: path, error });
				} else {
					valid.push(raw as SkillRecord);
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				invalid.push({ file: path, error: reason });
			}
		}
	}
	return { valid, invalid };
}

// ---------------------------------------------------------------------------
// Aggregate (per-fingerprint cumulative scores — the future PUCT dataset)
// ---------------------------------------------------------------------------

export interface AggregateEntry {
	readonly sessions: number;
	readonly turns: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly lastSessionAt: string;
}

export interface Aggregate {
	readonly updatedAt: string;
	readonly fingerprints: Record<string, AggregateEntry>;
}

export function emptyAggregate(nowIso: string): Aggregate {
	return { updatedAt: nowIso, fingerprints: {} };
}

/** Merge one finished session into the aggregate (pure). */
export function mergeAggregate(
	aggregate: Aggregate,
	fingerprint: string,
	totals: UsageTotals,
	nowIso: string,
): Aggregate {
	const prev: AggregateEntry =
		aggregate.fingerprints[fingerprint] ??
		{
			sessions: 0,
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			lastSessionAt: nowIso,
		};
	return {
		updatedAt: nowIso,
		fingerprints: {
			...aggregate.fingerprints,
			[fingerprint]: {
				sessions: prev.sessions + 1,
				turns: prev.turns + totals.turns,
				input: prev.input + totals.input,
				output: prev.output + totals.output,
				cacheRead: prev.cacheRead + totals.cacheRead,
				cacheWrite: prev.cacheWrite + totals.cacheWrite,
				reasoning: prev.reasoning + totals.reasoning,
				lastSessionAt: nowIso,
			},
		},
	};
}

/** Bytes of a file (0 when missing) — used for decisions.jsonl windows. */
export function fileSizeOrZero(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
