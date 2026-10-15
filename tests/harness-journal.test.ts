/**
 * Harness Journal tests — pure logic + tmpdir end-to-end flows.
 *
 * Covers: fingerprint stability, config schema strictness, the
 * init → trajectory → score → aggregate flow, decision counters,
 * retention pruning, skills bank seeding and IO fail-open behavior.
 */

import * as a from "node:assert/strict";
import { describe, test } from "node:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJournal } from "../shared/journal.js";
import { readConfig } from "../shared/config.js";
import {
	cacheHitRate,
	computeFingerprint,
	configFingerprint,
	countDecisionLines,
	listSourceFiles,
	loadSkillsBank,
	mergeAggregate,
	emptyAggregate,
	emptyTotals,
	addUsageTotals,
	planRetention,
	stableStringify,
	validateSkill,
} from "../harness-journal/snapshot.js";
import {
	createHarnessJournalExtension,
	findExtensionsRoot,
} from "../harness-journal/index.js";

type AnyPi = Parameters<ReturnType<typeof createHarnessJournalExtension>>[0];
type Ctx = { isProjectTrusted: () => boolean; sessionManager: { getSessionId: () => string }; model?: { id: string } };

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "harness-journal-"));
}

function fixtureExtensionsDir(root: string): string {
	const dir = join(root, "fixture-extensions");
	mkdirSync(join(dir, "alpha"), { recursive: true });
	mkdirSync(join(dir, "beta"), { recursive: true });
	mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ pi: { extensions: ["./alpha/index.ts"] } }));
	writeFileSync(join(dir, "alpha", "index.ts"), "export default () => {};\n");
	writeFileSync(join(dir, "beta", "index.ts"), "export default () => {};\n");
	writeFileSync(join(dir, "node_modules", "x", "index.ts"), "// ignored\n");
	writeFileSync(join(dir, "dist", "index.js"), "// ignored\n");
	return dir;
}

const TURN_USAGE = {
	message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, reasoning: 5 } },
};

/**
 * A single harness-journal instance bound to a *rotatable* session id.
 * Rotating `state.sessionId` simulates the next pi session in the same
 * process — exactly how the retention/aggregate paths get exercised.
 */
function makeRunner(opts: {
	historyDir: string;
	extensionsDir: string;
	journalPath: string;
	overrides?: Record<string, unknown>;
}) {
	const journal = createJournal(opts.journalPath);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
			handlers.set(name, handler);
		},
	} as never as AnyPi;

	const state = { sessionId: "s1" };
	const ctx = (): Ctx => ({
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => state.sessionId },
		model: { id: "MiniMax-M3" },
	});

	createHarnessJournalExtension({
		dir: opts.historyDir,
		extensionsDir: opts.extensionsDir,
		journal,
		journalPath: opts.journalPath,
		getConfig: () => ({ harnessJournal: { enabled: true } }) as never,
		now: () => 1_700_000_000_000,
		...opts.overrides,
	})(pi);

	return {
		state,
		fire(name: string, payload?: unknown) {
			const h = handlers.get(name);
			a.ok(h, `handler registered: ${name}`);
			h?.(payload ?? {}, ctx());
		},
	};
}

describe("Harness Journal — snapshot logic", () => {
	test("fingerprint is order-independent and sensitive to file/config changes", () => {
		const filesA = { "a.ts": "h1", "b.ts": "h2" };
		const filesB = { "b.ts": "h2", "a.ts": "h1" };
		const cfg = configFingerprint({ enabled: true });
		a.equal(computeFingerprint(filesA, cfg), computeFingerprint(filesB, cfg));
		a.notEqual(computeFingerprint(filesA, cfg), computeFingerprint({ ...filesA, "c.ts": "h3" }, cfg));
		a.notEqual(computeFingerprint(filesA, cfg), computeFingerprint(filesA, configFingerprint({ enabled: false })));
	});

	test("configFingerprint ignores key order", () => {
		a.equal(
			configFingerprint({ a: 1, b: { c: 2, d: 3 } }),
			configFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
		);
		a.equal(stableStringify([1, { y: 2 }]), stableStringify([{ y: 2 }, 1]) === stableStringify([1, { y: 2 }])
			? stableStringify([1, { y: 2 }])
			: stableStringify([1, { y: 2 }]));
	});

	test("listSourceFiles includes ts + package.json, skips node_modules/dist", () => {
		const root = tmpRoot();
		const dir = fixtureExtensionsDir(root);
		const files = listSourceFiles(dir);
		a.ok(files.includes("package.json"));
		a.ok(files.includes("alpha/index.ts"));
		a.ok(files.includes("beta/index.ts"));
		a.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/")));
	});

	test("usage totals + hit rate follow pi semantics (input excludes cache)", () => {
		let totals = emptyTotals();
		totals = addUsageTotals(totals, TURN_USAGE.message.usage);
		totals = addUsageTotals(totals, { input: 10 });
		a.equal(totals.turns, 2);
		a.equal(totals.input, 110);
		a.equal(totals.cacheRead, 900);
		a.equal(cacheHitRate(totals).toFixed(4), (900 / 1010).toFixed(4));
	});

	test("countDecisionLines tallies obs/reducer/fusion and skips torn lines", () => {
		const counters = countDecisionLines([
			JSON.stringify({ kind: "observation", placeholder: true, removed_tokens: 120 }),
			JSON.stringify({ kind: "observation", placeholder: false, removed_tokens: 999 }),
			JSON.stringify({ kind: "reducer_applied", savedBytes: 500 }),
			JSON.stringify({ kind: "then_run", outcome: "succeeded" }),
			JSON.stringify({ kind: "then_run", outcome: "failed" }),
			"{torn line",
			"",
		]);
		a.equal(counters.obsPacks, 1);
		a.equal(counters.obsSavedTokens, 120);
		a.equal(counters.reducerApplies, 1);
		a.equal(counters.reducerSavedBytes, 500);
		a.equal(counters.fusions, 1);
	});

	test("planRetention keeps the newest N by mtime", () => {
		const sessions = [
			{ id: "old", mtimeMs: 1 },
			{ id: "mid", mtimeMs: 2 },
			{ id: "new", mtimeMs: 3 },
		];
		a.deepEqual(planRetention(sessions, 2), ["old"]);
		a.deepEqual(planRetention(sessions, 3), []);
	});

	test("aggregate merge is cumulative per fingerprint", () => {
		let agg = emptyAggregate("t0");
		const totals = addUsageTotals(emptyTotals(), TURN_USAGE.message.usage);
		agg = mergeAggregate(agg, "fp1", totals, "t1");
		agg = mergeAggregate(agg, "fp1", totals, "t2");
		agg = mergeAggregate(agg, "fp2", totals, "t3");
		a.equal(agg.fingerprints["fp1"].sessions, 2);
		a.equal(agg.fingerprints["fp1"].turns, 2);
		a.equal(agg.fingerprints["fp2"].sessions, 1);
		a.equal(agg.updatedAt, "t3");
	});

	test("skill validation accepts a well-formed record and rejects bad ones", () => {
		const ok = {
			id: "x", kind: "repair-strategy", title: "T", trigger: "when",
			steps: ["a"], evidence: ["decisions.jsonl#1"], createdAt: "t", updatedAt: "t",
		};
		a.equal(validateSkill(ok), null);
		a.ok(validateSkill({ ...ok, kind: "nope" }) !== null);
		a.ok(validateSkill({ ...ok, steps: [1] }) !== null);
		a.ok(validateSkill({}) !== null);
	});

	test("loadSkillsBank reports valid and invalid entries", () => {
		const root = tmpRoot();
		const skills = join(root, "skills");
		mkdirSync(join(skills, "repair-strategies"), { recursive: true });
		writeFileSync(
			join(skills, "repair-strategies", "good.json"),
			JSON.stringify({ id: "g", kind: "repair-strategy", title: "T", trigger: "w", steps: [], evidence: [], createdAt: "t", updatedAt: "t" }),
		);
		writeFileSync(join(skills, "repair-strategies", "bad.json"), "{oops");
		const { valid, invalid } = loadSkillsBank(skills);
		a.equal(valid.length, 1);
		a.equal(valid[0].id, "g");
		a.equal(invalid.length, 1);
		a.match(invalid[0].file, /bad\.json$/);
	});
});

describe("Harness Journal — config schema", () => {
	function writeConfig(root: string, content: unknown): string {
		const projectDir = join(root, "proj", ".pi");
		mkdirSync(projectDir, { recursive: true });
		const path = join(projectDir, "sol-pi.json");
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
		return path;
	}

	function readIn(root: string) {
		const prevCwd = process.cwd();
		process.chdir(join(root, "proj"));
		try {
			return readConfig({ projectTrusted: true, homeDir: join(root, "home") });
		} finally {
			process.chdir(prevCwd);
		}
	}

	test("valid harnessJournal config is normalized, enabled defaults false", () => {
		const root = tmpRoot();
		writeConfig(root, { version: 1, harnessJournal: { enabled: true, maxSessions: 20 } });
		const config = readIn(root);
		a.equal(config.harnessJournal?.enabled, true);
		a.equal(config.harnessJournal?.maxSessions, 20);
		a.equal(config.harnessJournal?.dir, undefined);
	});

	test("empty harnessJournal object means disabled", () => {
		const root = tmpRoot();
		writeConfig(root, { version: 1, harnessJournal: {} });
		a.equal(readIn(root).harnessJournal?.enabled, false);
	});

	test("no harnessJournal key → feature absent (off)", () => {
		const root = tmpRoot();
		writeConfig(root, { version: 1 });
		a.equal(readIn(root).harnessJournal, undefined);
	});

	test("unknown harnessJournal key / wrong types are fatal", () => {
		const root = tmpRoot();
		for (const bad of [
			{ version: 1, harnessJournal: { enabled: true, nope: 1 } },
			{ version: 1, harnessJournal: { enabled: "yes" } },
			{ version: 1, harnessJournal: { maxSessions: 5 } },
			{ version: 1, harnessJournal: { dir: "" } },
			{ version: 1, harnessJournal: [] },
			{ version: 1, harnessJournal: "on" },
		]) {
			writeConfig(root, bad);
			a.throws(() => readIn(root), Error, JSON.stringify(bad));
		}
	});
});

describe("Harness Journal — session flow", () => {
	test("init writes index + fingerprint + skills bank; trajectories + score + aggregate accumulate", async () => {
		const root = tmpRoot();
		const runner = makeRunner({
			historyDir: join(root, "history"),
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
		});
		const historyDir = join(root, "history");

		runner.fire("turn_end", TURN_USAGE);
		runner.fire("turn_end", TURN_USAGE);

		// trajectory: 2 lines, raw usage preserved
		const traj = readFileSync(join(historyDir, "trajectories", "s1.jsonl"), "utf8").trim().split("\n");
		a.equal(traj.length, 2);
		const t1 = JSON.parse(traj[0]) as { turn: number; input: number; cacheRead: number };
		a.equal(t1.turn, 1);
		a.equal(t1.input, 100);
		a.equal(t1.cacheRead, 900);

		// index.jsonl has exactly one session line
		const index = readFileSync(join(historyDir, "index.jsonl"), "utf8").trim().split("\n");
		a.equal(index.length, 1);
		const entry = JSON.parse(index[0]) as { kind: string; sessionId: string; fingerprint: string; model: string };
		a.equal(entry.kind, "harness_journal_session");
		a.equal(entry.sessionId, "s1");
		a.equal(entry.model, "MiniMax-M3");

		// fingerprint snapshot exists and lists the session
		const fpFile = join(historyDir, "fingerprints", `${entry.fingerprint}.json`);
		a.ok(existsSync(fpFile), "fingerprint snapshot written");
		const fp = JSON.parse(readFileSync(fpFile, "utf8")) as { sessions: string[]; fileCount: number };
		a.deepEqual(fp.sessions, ["s1"]);
		a.ok(fp.fileCount > 0);

		// skills bank seeded
		a.ok(existsSync(join(historyDir, "skills", "README.md")));
		a.ok(existsSync(join(historyDir, "skills", "analyzer-skills")));
		a.ok(existsSync(join(historyDir, "skills", "repair-strategies")));
		a.ok(existsSync(join(historyDir, "skills", "procedure-templates")));

		// decisions during the session → counted at shutdown
		const { createJournal: cj } = await import("../shared/journal.js");
		await cj(join(root, "decisions.jsonl")).record({ kind: "observation", placeholder: true, removed_tokens: 77 } as never);
		await cj(join(root, "decisions.jsonl")).record({ kind: "then_run", outcome: "succeeded" } as never);
		await cj(join(root, "decisions.jsonl")).record({ kind: "then_run", outcome: "failed" } as never);

		runner.fire("session_shutdown");

		const score = JSON.parse(
			readFileSync(join(historyDir, "scores", "s1.json"), "utf8"),
		) as {
			fingerprint: string;
			totals: { turns: number; input: number };
			decisions: { obsPacks: number; obsSavedTokens: number; fusions: number };
		};
		a.equal(score.totals.turns, 2);
		a.equal(score.totals.input, 200);
		a.equal(score.decisions.obsPacks, 1);
		a.equal(score.decisions.obsSavedTokens, 77);
		a.equal(score.decisions.fusions, 1);
		a.equal(score.fingerprint, entry.fingerprint);

		const aggregate = JSON.parse(readFileSync(join(historyDir, "aggregate.json"), "utf8")) as {
			fingerprints: Record<string, { sessions: number; turns: number }>;
		};
		a.equal(aggregate.fingerprints[entry.fingerprint].sessions, 1);
		a.equal(aggregate.fingerprints[entry.fingerprint].turns, 2);
	});

	test("session ids rotate: fingerprint deduped, aggregate grows", () => {
		const root = tmpRoot();
		const historyDir = join(root, "history");
		const runner = makeRunner({
			historyDir,
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
		});

		for (const sid of ["s1", "s2", "s3"]) {
			runner.state.sessionId = sid;
			runner.fire("turn_end", TURN_USAGE);
			runner.fire("session_shutdown");
		}

		const fpFiles = readdirSync(join(historyDir, "fingerprints"));
		a.equal(fpFiles.length, 1, "fingerprint deduped across sessions");
		const fingerprint = fpFiles[0].replace(".json", "");
		const fp = JSON.parse(
			readFileSync(join(historyDir, "fingerprints", `${fingerprint}.json`), "utf8"),
		) as { sessions: string[] };
		a.deepEqual([...fp.sessions].sort(), ["s1", "s2", "s3"]);

		a.equal(readdirSync(join(historyDir, "scores")).length, 3);

		// index.jsonl keeps all three session lines (append-only evidence)
		const index = readFileSync(join(historyDir, "index.jsonl"), "utf8").trim().split("\n");
		a.equal(index.length, 3);

		const aggregate = JSON.parse(readFileSync(join(historyDir, "aggregate.json"), "utf8")) as {
			fingerprints: Record<string, { sessions: number; turns: number }>;
		};
		a.equal(aggregate.fingerprints[fingerprint].sessions, 3);
		a.equal(aggregate.fingerprints[fingerprint].turns, 3);
	});

	test("maxSessions prunes oldest trajectories+scores but never index/fingerprints", () => {
		const root = tmpRoot();
		const historyDir = join(root, "history");
		const runner = makeRunner({
			historyDir,
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
		});

		for (const sid of ["r1", "r2", "r3"]) {
			runner.state.sessionId = sid;
			runner.fire("turn_end", TURN_USAGE);
			runner.fire("session_shutdown");
		}
		// backdate r1 so it's the oldest score
		utimesSync(join(historyDir, "scores", "r1.json"), new Date(1000), new Date(1000));

		// a fresh instance with a tighter cap (3) prunes only r1 at the next shutdown
		const tighter = makeRunner({
			historyDir,
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
			overrides: { maxSessions: 3 },
		});
		tighter.state.sessionId = "r4";
		tighter.fire("turn_end", TURN_USAGE);
		tighter.fire("session_shutdown");

		a.ok(!existsSync(join(historyDir, "scores", "r1.json")), "oldest score pruned");
		a.ok(!existsSync(join(historyDir, "trajectories", "r1.jsonl")), "oldest trajectory pruned");
		for (const sid of ["r2", "r3", "r4"]) {
			a.ok(existsSync(join(historyDir, "scores", `${sid}.json`)), `${sid} kept`);
		}
		a.equal(readdirSync(join(historyDir, "fingerprints")).length, 1, "fingerprints never pruned");
		a.equal(readFileSync(join(historyDir, "index.jsonl"), "utf8").trim().split("\n").length, 4, "index never pruned");
	});

	test("disabled sessions never touch the filesystem", () => {
		const root = tmpRoot();
		const runner = makeRunner({
			historyDir: join(root, "history"),
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
			overrides: { getConfig: () => ({}) as never }, // no harnessJournal → off
		});
		runner.fire("turn_end", TURN_USAGE);
		runner.fire("session_shutdown");
		a.ok(!existsSync(join(root, "history", "index.jsonl")));
		a.ok(!existsSync(join(root, "history", "trajectories")));
	});

	test("fail-open: unusable storage dir records a failure instead of throwing", async () => {
		const root = tmpRoot();
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "this is a file, not a dir");
		const runner = makeRunner({
			historyDir: blocker,
			extensionsDir: fixtureExtensionsDir(root),
			journalPath: join(root, "decisions.jsonl"),
		});
		a.doesNotThrow(() => runner.fire("turn_end", TURN_USAGE));
		a.doesNotThrow(() => runner.fire("session_shutdown"));
		await new Promise((r) => setTimeout(r, 20)); // journal writes are async
		const lines = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n");
		const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
		a.ok(kinds.includes("harness_journal_failure"), "failure recorded");
	});

	test("journal records init and score decisions", async () => {
		const root = tmpRoot();
		const journalPath = join(root, "decisions.jsonl");
		const runner = makeRunner({
			historyDir: join(root, "history"),
			extensionsDir: fixtureExtensionsDir(root),
			journalPath,
		});
		runner.fire("turn_end", TURN_USAGE);
		runner.fire("session_shutdown");
		await new Promise((r) => setTimeout(r, 20)); // journal writes are async
		const kinds = readFileSync(journalPath, "utf8").trim().split("\n").map(
			(l) => (JSON.parse(l) as { kind: string }).kind,
		);
		a.ok(kinds.includes("harness_journal_init"));
		a.ok(kinds.includes("harness_journal_score"));
	});
});

describe("Harness Journal — module resolution", () => {
	test("findExtensionsRoot walks up to the package.json with pi.extensions", () => {
		const root = tmpRoot();
		const dir = fixtureExtensionsDir(root);
		a.equal(findExtensionsRoot(join(dir, "alpha")), dir);
		a.equal(findExtensionsRoot(dir), dir);
	});

	test("findExtensionsRoot stops at a package.json without pi.extensions", () => {
		const root = tmpRoot();
		const plain = join(root, "plain");
		mkdirSync(join(plain, "sub"), { recursive: true });
		writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "plain" }));
		a.equal(findExtensionsRoot(join(plain, "sub")), null);
	});
});
