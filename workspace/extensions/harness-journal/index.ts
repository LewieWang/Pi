/**
 * Harness Journal — persistent filesystem memory of the harness itself.
 *
 * The three papers behind this extension:
 *   - Meta-Harness (arXiv:2603.28052): the filesystem keeps the FULL history
 *     of harness candidates (content-addressed fingerprints), raw turn
 *     trajectories and session scores. A future agentic proposer can grep/cat
 *     everything — no lossy summarization at this layer.
 *   - EvoTrainer (arXiv:2606.03108): a Memory + Skill bank accumulates
 *     analyzer-skills / repair-strategies / procedure-templates across
 *     sessions instead of re-deriving diagnostics every time.
 *   - ERA (Nature 2026): per-fingerprint aggregates are the quality signal a
 *     later PUCT-style harness search (harness-puct) will optimize.
 *
 * What it writes (default root ~/.pi/agent/harness-history/):
 *
 *   index.jsonl                     one line per session (append-only)
 *   fingerprints/<fp>.json          deduped harness snapshots (code+config)
 *   trajectories/<sessionId>.jsonl  raw per-turn usage
 *   scores/<sessionId>.json         session-end summary + decision counters
 *   aggregate.json                  cumulative per-fingerprint aggregates
 *   skills/…                        EvoTrainer skills bank (3 kinds)
 *
 * House rules honored:
 *   - Explicit opt-in: off unless sol-pi.json has harnessJournal.enabled=true
 *     (or the installer forces it via options.enabled).
 *   - Fail open: every IO error is swallowed and recorded as a
 *     harness_journal_failure decision; the session continues untouched.
 *   - Preserve evidence: index.jsonl and fingerprints/ are never pruned;
 *     only trajectories/scores rotate (maxSessions).
 *   - Strict schema: unknown harnessJournal keys are fatal at config load.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir as osHomedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_JOURNAL_PATH, formatLocalTime, type Journal, createJournal } from "../shared/journal.js";
import {
	readConfig,
	type SolPiConfig,
} from "../shared/config.js";
import {
	addUsageTotals,
	cacheHitRate,
	computeFingerprint,
	configFingerprint,
	countDecisionLines,
	emptyCounters,
	emptyTotals,
	fileSizeOrZero,
	hashFiles,
	listSourceFiles,
	loadSkillsBank,
	mergeAggregate,
	emptyAggregate,
	planRetention,
	type DecisionCounters,
	type UsageTotals,
	SKILL_DIRS,
	SKILL_KINDS,
} from "./snapshot.js";

export interface HarnessJournalOptions {
	/** Storage root override (beats config.dir). */
	readonly dir?: string;
	/** Extensions root override for snapshot hashing (beats module derivation). */
	readonly extensionsDir?: string;
	/** Decision journal (defaults to the real one). */
	readonly journal?: Journal;
	/** Path of decisions.jsonl for decision-window counting. */
	readonly journalPath?: string;
	/** Injectable clock for tests. */
	readonly now?: () => number;
	/** Retention override (beats config.maxSessions). */
	readonly maxSessions?: number;
	/** Force-enable, bypassing the config gate (used by bundle forceAll/tests). */
	readonly enabled?: boolean;
	/** Config provider override (tests). Default: strict readConfig, fail-open. */
	readonly getConfig?: () => SolPiConfig | null;
}

interface SessionState {
	readonly sessionId: string;
	readonly fingerprint: string;
	readonly startedAt: number;
	readonly decisionsOffset: number;
	totals: UsageTotals;
	readonly config: SolPiConfig | null;
}

const DEFAULT_HISTORY_DIR = join(osHomedir(), ".pi", "agent", "harness-history");

/** Find the extensions root by walking up until package.json has pi.extensions. */
export function findExtensionsRoot(startDir: string): string | null {
	let dir = startDir;
	for (let depth = 0; depth < 6; depth += 1) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
					pi?: { extensions?: unknown };
				};
				if (pkg?.pi?.extensions) return dir;
				// A nearer package.json without pi.extensions is a subproject
				// boundary — stop here (deterministic negative).
				return null;
			} catch {
				// unreadable package.json — keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

function defaultExtensionsDir(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return findExtensionsRoot(here);
	} catch {
		return null;
	}
}

/** Append a line to a JSONL file (creates parent dirs). */
function appendJsonl(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${line}\n`, "utf8");
}

/** Atomic JSON write: tmp file + rename. */
function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

const SKILLS_README = `# Harness Skills Bank (EvoTrainer Memory + Skill)

跨 session 持久化的"诊断知识库"。三类文件，均为 JSON：

- \`analyzer-skills/\`      —— 如何分析某类失败（trigger → 分析步骤）
- \`repair-strategies/\`    —— 某类失败的成功修复策略（trigger → 修复步骤 + evidence）
- \`procedure-templates/\`  —— 可复用的操作流程模板

Schema（structurally validated，见 snapshot.ts::validateSkill）：

{
  "id": "unique-id",
  "kind": "analyzer-skill" | "repair-strategy" | "procedure-template",
  "title": "…",
  "trigger": "什么时候用",
  "steps": ["…"],
  "evidence": ["指向 decisions.jsonl / scores/*.json 的证据行"],
  "createdAt": "ISO",
  "updatedAt": "ISO"
`

export function createHarnessJournalExtension(options: HarnessJournalOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const sessions = new Map<string, SessionState>();
		const disabled = new Set<string>();
		const journal: Journal = options.journal ?? createJournal();
		const journalPath = options.journalPath ?? DEFAULT_JOURNAL_PATH;
		const now = options.now ?? Date.now;

		const resolveDir = (config: SolPiConfig | null): string =>
			options.dir ?? config?.harnessJournal?.dir ?? DEFAULT_HISTORY_DIR;

		const resolveMaxSessions = (config: SolPiConfig | null): number =>
			options.maxSessions ?? config?.harnessJournal?.maxSessions ?? 500;

		const isEnabled = (config: SolPiConfig | null): boolean =>
			options.enabled ?? (config?.harnessJournal?.enabled === true);

		const fail = (op: string, error: unknown): void => {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				void journal.record({ kind: "harness_journal_failure", op, reason });
			} catch {
				// last resort: never throw from the journal itself
			}
		};

		const getConfig = (context: ExtensionContext): SolPiConfig | null => {
			if (options.getConfig) return options.getConfig();
			try {
				return readConfig({ projectTrusted: context.isProjectTrusted() });
			} catch {
				return null; // strict config errors → fail-open to disabled
			}
		};

		// ---- lazy init on first turn_end of a session -------------------
		const initSession = (context: ExtensionContext): SessionState | null => {
			const sessionId = context.sessionManager.getSessionId();

			const config = getConfig(context);
			if (!isEnabled(config)) {
				disabled.add(sessionId);
				return null;
			}
			if (sessions.has(sessionId)) return sessions.get(sessionId) ?? null;

			const root = resolveDir(config);
			const extensionsDir =
				options.extensionsDir ??
				defaultExtensionsDir() ??
				(() => {
					fail("snapshot", new Error("cannot locate extensions root for snapshot"));
					return null;
				})();
			if (!extensionsDir) {
				disabled.add(sessionId);
				return null;
			}

			try {
				const rels = listSourceFiles(extensionsDir);
				const hashes = hashFiles(extensionsDir, rels);
				const cfgHash = configFingerprint(config ?? {});
				const fingerprint = computeFingerprint(hashes, cfgHash);

				// fingerprints/<fp>.json — deduped snapshot, never pruned
				const fpPath = join(root, "fingerprints", `${fingerprint}.json`);
				let sessionsInFp: string[] = [];
				let createdAt = new Date(now()).toISOString();
				if (existsSync(fpPath)) {
					try {
						const prev = JSON.parse(readFileSync(fpPath, "utf8")) as {
							createdAt?: string;
							sessions?: string[];
						};
						if (typeof prev.createdAt === "string") createdAt = prev.createdAt;
						if (Array.isArray(prev.sessions)) sessionsInFp = prev.sessions.filter((s) => typeof s === "string");
					} catch {
						// corrupt snapshot → rebuild
					}
				}
				if (!sessionsInFp.includes(sessionId)) sessionsInFp = [...sessionsInFp, sessionId].slice(-200);
				writeJsonAtomic(fpPath, {
					fingerprint,
					createdAt,
					extensionsDir,
					fileCount: Object.keys(hashes).length,
					configHash: cfgHash,
					config: config ?? null,
					files: hashes,
					sessions: sessionsInFp,
				});

				// index.jsonl — append-only session line
				const ts = new Date(now());
				appendJsonl(
					join(root, "index.jsonl"),
					JSON.stringify({
						timestamp: ts.toISOString(),
						localTime: formatLocalTime(ts),
						kind: "harness_journal_session",
						sessionId,
						fingerprint,
						model:
							(context as { model?: { id?: string } }).model?.id ?? null,
						fileCount: Object.keys(hashes).length,
					}),
				);

				// skills bank — seed once, never overwrite
				if ((config?.harnessJournal?.skillsBank ?? true)) {
					const skillsDir = join(root, "skills");
					for (const kind of SKILL_KINDS) {
						mkdirSync(join(skillsDir, SKILL_DIRS[kind]), { recursive: true });
					}
					const readme = join(skillsDir, "README.md");
					if (!existsSync(readme)) {
						mkdirSync(skillsDir, { recursive: true });
						writeFileSync(readme, SKILLS_README, "utf8");
					}
				}

				const state: SessionState = {
					sessionId,
					fingerprint,
					startedAt: now(),
					decisionsOffset: fileSizeOrZero(journalPath),
					totals: emptyTotals(),
					config,
				};
				sessions.set(sessionId, state);
				try {
					void journal.record({
						kind: "harness_journal_init",
						sessionId,
						fingerprint,
						fileCount: Object.keys(hashes).length,
						dir: root,
					});
				} catch {
					// journal write failure is non-fatal
				}
				return state;
			} catch (error) {
				fail("init", error);
				disabled.add(sessionId);
				return null;
			}
		};

		// ---- score + aggregate + retention at session end ---------------
		const finishSession = (context: ExtensionContext): void => {
			const sessionId = context.sessionManager.getSessionId();
			const state = sessions.get(sessionId);
			if (!state) return;
			const config = state.config;
			const root = resolveDir(config);
			const nowIso = new Date(now()).toISOString();

			try {
				// decision counters from this session's decisions.jsonl window
				let counters: DecisionCounters = emptyCounters();
				if (existsSync(journalPath)) {
					const window = readFileSync(journalPath, "utf8").slice(state.decisionsOffset);
					counters = countDecisionLines(window.split("\n"));
				}

				const totals = state.totals;
				const score = {
					sessionId,
					fingerprint: state.fingerprint,
					startedAt: new Date(state.startedAt).toISOString(),
					endedAt: nowIso,
					totals,
					cacheHitRate: cacheHitRate(totals),
					decisions: counters,
				};
				writeJsonAtomic(join(root, "scores", `${sessionId}.json`), score);

				// aggregate.json — read-merge-atomic-write (no cross-session lock,
				// per house rule I; last writer wins on races)
				const aggPath = join(root, "aggregate.json");
				let aggregate = emptyAggregate(nowIso);
				if (existsSync(aggPath)) {
					try {
						const parsed = JSON.parse(readFileSync(aggPath, "utf8")) as {
							updatedAt?: string;
							fingerprints?: Record<string, never>;
						};
						aggregate = {
							updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso,
							fingerprints: parsed.fingerprints ?? {},
						};
					} catch {
						// corrupt aggregate → rebuild from scratch
					}
				}
				writeJsonAtomic(
					aggPath,
					mergeAggregate(aggregate, state.fingerprint, totals, nowIso),
				);

				try {
					void journal.record({
						kind: "harness_journal_score",
						sessionId,
						fingerprint: state.fingerprint,
						turns: totals.turns,
						input: totals.input,
						output: totals.output,
						cacheRead: totals.cacheRead,
						cacheWrite: totals.cacheWrite,
						reasoning: totals.reasoning,
						obsPacks: counters.obsPacks,
						reducerApplies: counters.reducerApplies,
						fusions: counters.fusions,
					});
				} catch {
					// non-fatal
				}

				retention(root, resolveMaxSessions(config));
				sessions.delete(sessionId);
			} catch (error) {
				fail("score", error);
				sessions.delete(sessionId);
			}
		};

		/** Prune trajectories+scores beyond maxSessions (index/fingerprints kept). */
		const retention = (root: string, maxSessions: number): void => {
			try {
				const trajDir = join(root, "trajectories");
				const scoreDir = join(root, "scores");
				const byId = new Map<string, { mtimeMs: number }>();
				if (existsSync(scoreDir)) {
					for (const f of readdirSync(scoreDir)) {
						if (!f.endsWith(".json")) continue;
						const id = f.slice(0, -".json".length);
						byId.set(id, { mtimeMs: statSync(join(scoreDir, f)).mtimeMs });
					}
				}
				const doomed = planRetention(
					[...byId].map(([id, v]) => ({ id, mtimeMs: v.mtimeMs })),
					maxSessions,
				);
				for (const id of doomed) {
					for (const p of [join(trajDir, `${id}.jsonl`), join(scoreDir, `${id}.json`)]) {
						try {
							if (existsSync(p)) unlinkSync(p);
						} catch {
							// best effort per file
						}
					}
				}
			} catch (error) {
				fail("retention", error);
			}
		};

		// ---- event wiring ------------------------------------------------
		pi.on("turn_end", (event, context) => {
			const sessionId = context.sessionManager.getSessionId();
			if (disabled.has(sessionId)) return;
			const state = sessions.get(sessionId) ?? initSession(context);
			if (!state) return;
			try {
				const usage = (
					event.message as {
						usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number };
					}
				).usage;
				state.totals = addUsageTotals(state.totals, usage ?? {});
				const ts = new Date(now());
				appendJsonl(
					join(resolveDir(state.config), "trajectories", `${sessionId}.jsonl`),
					JSON.stringify({
						timestamp: ts.toISOString(),
						localTime: formatLocalTime(ts),
						turn: state.totals.turns,
						input: usage?.input ?? 0,
						output: usage?.output ?? 0,
						cacheRead: usage?.cacheRead ?? 0,
						cacheWrite: usage?.cacheWrite ?? 0,
						reasoning: usage?.reasoning ?? 0,
					}),
				);
			} catch (error) {
				fail("trajectory", error);
			}
		});

		pi.on("session_shutdown", (_event, context) => {
			finishSession(context);
		});
	};
}

export const _internal = {
	DEFAULT_HISTORY_DIR,
	SKILLS_README,
	appendJsonl,
	writeJsonAtomic,
};

export default function harnessJournalExtension(pi: ExtensionAPI): void {
	createHarnessJournalExtension()(pi);
}
