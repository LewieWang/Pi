/**
 * Sol-Pi config loader (subset).
 *
 * Reference: SoL-Pi src/sol-pi/config.ts
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "actionFusion": boolean,
 *     "observationPack": boolean,
 *     "evidencePreservingReducer": boolean,
 *     "onlineContextCompact": boolean,
 *     "cacheWriteReadRatio": number  // default 1.0 for our models
 *   }
 *
 * Read order:
 *   1. <project>/.pi/sol-pi.json (only when project is trusted)
 *   2. <home>/.pi/agent/sol-pi.json
 *
 * Unknown keys, wrong versions, wrong types are fatal.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir as osHomedir } from "node:os";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 1.0;

/**
 * Harness Journal — persistent filesystem memory of the harness itself
 * (Meta-Harness / EvoTrainer style): per-session fingerprint snapshots,
 * raw turn trajectories, session scores and a skills bank.
 *
 * Explicit opt-in: absent or `{"enabled": false}` means fully off.
 */
export interface HarnessJournalConfig {
	readonly enabled: boolean;
	/** Storage root. Default: <home>/.pi/agent/harness-history */
	readonly dir?: string;
	/** Keep the N newest session trajectories+scores. Default 500 (min 10). */
	readonly maxSessions?: number;
	/** Maintain the EvoTrainer-style skills bank directories. Default true. */
	readonly skillsBank?: boolean;
}

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
	readonly harnessJournal?: HarnessJournalConfig;
}

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	onlineContextCompact: false,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
] as const;
const HARNESS_JOURNAL_KEYS = new Set<string>(["enabled", "dir", "maxSessions", "skillsBank"]);
const VALID_KEYS = new Set<string>(["version", ...FEATURE_KEYS, "cacheWriteReadRatio", "harnessJournal"]);

/** Strict validation for the nested harnessJournal object. Fail-loud. */
function parseHarnessJournal(raw: unknown, path: string): HarnessJournalConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`sol-pi config harnessJournal must be a JSON object: ${path}`);
	}
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!HARNESS_JOURNAL_KEYS.has(key)) {
			throw new Error(`Unknown sol-pi config harnessJournal key: ${key}`);
		}
	}
	const enabled = record.enabled === undefined ? false : record.enabled;
	if (typeof enabled !== "boolean") {
		throw new Error(`sol-pi config harnessJournal.enabled must be boolean: ${path}`);
	}
	let dir: string | undefined;
	if (record.dir !== undefined) {
		if (typeof record.dir !== "string" || record.dir.trim() === "") {
			throw new Error(`sol-pi config harnessJournal.dir must be a non-empty string: ${path}`);
		}
		dir = record.dir;
	}
	let maxSessions: number | undefined;
	if (record.maxSessions !== undefined) {
		if (
			typeof record.maxSessions !== "number" ||
			!Number.isInteger(record.maxSessions) ||
			record.maxSessions < 10
		) {
			throw new Error(`sol-pi config harnessJournal.maxSessions must be an integer >= 10: ${path}`);
		}
		maxSessions = record.maxSessions;
	}
	let skillsBank: boolean | undefined;
	if (record.skillsBank !== undefined) {
		if (typeof record.skillsBank !== "boolean") {
			throw new Error(`sol-pi config harnessJournal.skillsBank must be boolean: ${path}`);
		}
		skillsBank = record.skillsBank;
	}
	return Object.freeze({
		enabled,
		...(dir !== undefined ? { dir } : {}),
		...(maxSessions !== undefined ? { maxSessions } : {}),
		...(skillsBank !== undefined ? { skillsBank } : {}),
	});
}

function configPath(projectTrusted: boolean, homeDir: string): string | undefined {
	if (projectTrusted) {
		const projectPath = join(process.cwd(), ".pi", "sol-pi.json");
		if (existsSync(projectPath)) return projectPath;
	}
	const globalPath = join(homeDir, ".pi", "agent", "sol-pi.json");
	if (existsSync(globalPath)) return globalPath;
	return undefined;
}

export interface ReadConfigOptions {
	projectTrusted?: boolean;
	homeDir?: string;
}

export function readConfig(opts: ReadConfigOptions = {}): SolPiConfig {
	const homeDir = opts.homeDir ?? osHomedir();
	const path = configPath(opts.projectTrusted ?? false, homeDir);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read sol-pi config ${path}: ${reason}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`sol-pi config must be a JSON object: ${path}`);
	}
	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!VALID_KEYS.has(key)) throw new Error(`Unknown sol-pi config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`sol-pi config version must be 1: ${path}`);
	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`sol-pi config ${key} must be boolean: ${path}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`sol-pi config cacheWriteReadRatio must be a finite non-negative number: ${path}`);
	}

	let harnessJournal: HarnessJournalConfig | undefined;
	if (Object.hasOwn(record, "harnessJournal")) {
		harnessJournal = parseHarnessJournal(record.harnessJournal, path);
	}

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		...(harnessJournal !== undefined ? { harnessJournal } : {}),
	}) as SolPiConfig;
}