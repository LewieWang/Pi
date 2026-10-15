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

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
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
const VALID_KEYS = new Set<string>(["version", ...FEATURE_KEYS, "cacheWriteReadRatio"]);

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

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
	}) as SolPiConfig;
}