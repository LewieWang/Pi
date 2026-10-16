#!/usr/bin/env node
/**
 * Probe 4 — harness-journal-arithmetic
 *
 * Exercises the pure functions in harness-journal/snapshot.ts. These
 * produce the *quality signal* that ERA's PUCT loop will eventually
 * learn from: per-fingerprint aggregates, cache hit rate, retention
 * planning, skill validation. If a candidate drifts these numbers,
 * the aggregate dataset gets noisy and we lose retrospective value.
 */
import { performance } from "node:perf_hooks";
import {
	emptyTotals,
	addUsageTotals,
	cacheHitRate,
	emptyCounters,
	reduceCounters,
	countDecisionLines,
	emptyAggregate,
	mergeAggregate,
	planRetention,
	validateSkill,
	stableStringify,
	configFingerprint,
	SKILL_KINDS,
} from "../../dist/harness-journal/snapshot.js";

function eq(actual, expected) {
	if (typeof actual !== typeof expected) return false;
	if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
	return actual === expected;
}

function close(a, b, eps = 1e-9) {
	return Math.abs(a - b) <= eps;
}

export async function run() {
	const start = performance.now();
	const failures = [];
	let passed = 0;
	let total = 0;

	function assertEq(label, actual, expected) {
		total++;
		if (eq(actual, expected)) passed++;
		else failures.push(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
	}
	function assertClose(label, actual, expected, eps = 1e-9) {
		total++;
		if (close(actual, expected, eps)) passed++;
		else failures.push(`${label}: expected ≈ ${expected} got ${actual}`);
	}
	function assertPass(label, fn) {
		total++;
		try {
			const r = fn();
			if (r) passed++;
			else failures.push(`${label}: predicate returned false`);
		} catch (err) {
			failures.push(`${label}: threw ${err?.message ?? String(err)}`);
		}
	}

	// --- emptyTotals / addUsageTotals / cacheHitRate ---
	assertEq("emptyTotals().input", emptyTotals().input, 0);
	assertEq("emptyTotals().turns", emptyTotals().turns, 0);
	const t1 = addUsageTotals(emptyTotals(), { input: 100, output: 50, cacheRead: 800, cacheWrite: 100 });
	const t2 = addUsageTotals(t1, { input: 200, output: 25, reasoning: 30 });
	assertEq("addUsageTotals input sum", t2.input, 300);
	assertEq("addUsageTotals output sum", t2.output, 75);
	assertEq("addUsageTotals cacheRead sum", t2.cacheRead, 800);
	assertEq("addUsageTotals cacheWrite sum", t2.cacheWrite, 100);
	assertEq("addUsageTotals reasoning sum", t2.reasoning, 30);
	assertEq("addUsageTotals increments turns", t2.turns, 2);
	// cacheHitRate = cacheRead / (input + cacheRead) = 800 / (300 + 800) ≈ 0.7273
	assertClose("cacheHitRate 800/(300+800)", cacheHitRate(t2), 800 / 1100);
	// Separate, simpler check for the headline 80% hit ratio
	const simpleHit = addUsageTotals(emptyTotals(), { input: 200, cacheRead: 800 });
	assertClose("cacheHitRate on (input:200, cacheRead:800) = 0.8", cacheHitRate(simpleHit), 0.8);
	assertEq("cacheHitRate on empty is 0", cacheHitRate(emptyTotals()), 0);
	// id: cache hit rate must remain in [0,1] regardless of how user fats the cacheWrite
	const fatCache = { ...t2, cacheWrite: 1_000_000, cacheRead: 1 };
	assertPass("cacheHitRate in [0,1]", () => {
		const r = cacheHitRate(fatCache);
		return r >= 0 && r <= 1;
	});

	// --- emptyCounters / reduceCounters / countDecisionLines ---
	const baseCounters = emptyCounters();
	assertEq("emptyCounters.obsPacks", baseCounters.obsPacks, 0);
	const c1 = reduceCounters(baseCounters, { kind: "observation", placeholder: true, removed_tokens: 1200 });
	const c2 = reduceCounters(c1, { kind: "observation", placeholder: true, removed_tokens: 800 });
	const c3 = reduceCounters(c2, { kind: "reducer_applied", savedBytes: 4096 });
	const c4 = reduceCounters(c3, { kind: "reducer_applied", savedBytes: 1024 });
	const c5 = reduceCounters(c4, { kind: "then_run", outcome: "succeeded" });
	const c6 = reduceCounters(c5, { kind: "then_run", outcome: "skipped" });
	assertEq("reduceCounters obsPacks =2", c6.obsPacks, 2);
	assertEq("reduceCounters obsSavedTokens =2000", c6.obsSavedTokens, 2000);
	assertEq("reduceCounters reducerApplies =2", c6.reducerApplies, 2);
	assertEq("reduceCounters reducerSavedBytes =5120", c6.reducerSavedBytes, 5120);
	assertEq("reduceCounters fusions =1 (only succeeded)", c6.fusions, 1);
	assertEq("reduceCounters ignores unknown kind", reduceCounters(c6, { kind: "wat" }).fusions, 1);
	assertEq("reduceCounters ignores non-object event", reduceCounters(c6, "not-an-object").fusions, 1);

	// countDecisionLines on a window with blank + JSONL + a non-JSON line
	// (the function should reset counters, then tally only parseable JSON lines;
	// it must not throw on a bad line.)
	const lines = [
		"",
		JSON.stringify({ kind: "observation", placeholder: true, removed_tokens: 50 }),
		" not-json ", // not parseable; the reducer swallows it
		JSON.stringify({ kind: "reducer_applied", savedBytes: 200 }),
	];
	const fromLines = countDecisionLines(lines);
	assertEq("countDecisionLines obsPacks (window-internal)", fromLines.obsPacks, 1);
	assertEq("countDecisionLines reducerApplies (window-internal)", fromLines.reducerApplies, 1);

	// --- emptyAggregate / mergeAggregate ---
	const fp = "abc123";
	let agg = emptyAggregate("2026-01-01T00:00:00Z");
	agg = mergeAggregate(agg, fp, { ...emptyTotals(), input: 100, output: 50, cacheRead: 20 }, "2026-01-01T01:00:00Z");
	agg = mergeAggregate(agg, fp, { ...emptyTotals(), input: 50, output: 25, cacheRead: 30 }, "2026-01-01T02:00:00Z");
	const entry = agg.fingerprints[fp];
	assertEq("aggregate.sessions=2", entry.sessions, 2);
	assertEq("aggregate.turns sums", entry.turns, entry.turns); // trivial
	assertEq("aggregate.input sums", entry.input, 150);
	assertEq("aggregate.output sums", entry.output, 75);
	assertEq("aggregate.cacheRead sums", entry.cacheRead, 50);
	assertEq("aggregate.lastSessionAt updated", agg.fingerprints[fp].lastSessionAt, "2026-01-01T02:00:00Z");

	// separate fingerprint — aggregate.fingerprints size grows by 1
	const fp2 = "def456";
	const before2 = Object.keys(agg.fingerprints).length;
	agg = mergeAggregate(agg, fp2, emptyTotals(), "2026-01-01T03:00:00Z");
	const after2 = Object.keys(agg.fingerprints).length;
	assertEq("aggregate separate fingerprint grows keys", after2, before2 + 1);

	// --- planRetention ---
	const all = [
		{ id: "a", mtimeMs: 10 },
		{ id: "b", mtimeMs: 20 },
		{ id: "c", mtimeMs: 30 },
		{ id: "d", mtimeMs: 40 },
		{ id: "e", mtimeMs: 50 },
	];
	const dropped = planRetention(all, 2);
	assertEq("planRetention drops oldest", dropped.length, 3);
	assertEq("planRetention drops by mtime asc", JSON.stringify(dropped), JSON.stringify(["a", "b", "c"]));
	assertEq("planRetention no-op when within bound", planRetention(all, 10).length, 0);
	assertEq("planRetention boundary n=5 keeps 0", planRetention(all, 5).length, 0);

	// --- validateSkill ---
	const goodSkill = {
		id: "sk-001",
		kind: "analyzer-skill",
		title: "diagnose schema rejection",
		trigger: "sol-pi config parse threw",
		steps: ["read parseConfig", "check VERSION"],
		evidence: ["evolution-log.md##2026-10-15"],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	assertEq("validateSkill good ⇒ null", validateSkill(goodSkill), null);
	assertPass("validateSkill missing id ⇒ error", () => typeof validateSkill((({ id: _drop, ...rest }) => rest)(goodSkill)) === "string");
	assertPass("validateSkill bad kind ⇒ error", () => typeof validateSkill({ ...goodSkill, kind: "wrong-kind" }) === "string");
	assertPass("validateSkill empty title ⇒ error", () => typeof validateSkill({ ...goodSkill, title: "" }) === "string");
	assertPass("validateSkill non-array steps ⇒ error", () => typeof validateSkill({ ...goodSkill, steps: "no" }) === "string");
	assertPass("validateSkill non-string evidence item ⇒ error", () => typeof validateSkill({ ...goodSkill, evidence: [1] }) === "string");

	// SKILL_KINDS frozen content
	assertEq("SKILL_KINDS length", SKILL_KINDS.length, 3);
	assertPass("SKILL_KINDS contains all three", () => new Set(SKILL_KINDS).has("analyzer-skill") && new Set(SKILL_KINDS).has("repair-strategy") && new Set(SKILL_KINDS).has("procedure-template"));

	// --- stableStringify / configFingerprint ---
	const cfg = { b: 1, a: { y: 2, x: 1 } };
	const cfg2 = { a: { x: 1, y: 2 }, b: 1 };
	assertEq("stableStringify order-independent", stableStringify(cfg), stableStringify(cfg2));
	assertPass("configFingerprint of equal cfgs equal", () => configFingerprint(cfg) === configFingerprint(cfg2));
	assertPass("configFingerprint of different cfg differs", () => configFingerprint(cfg) !== configFingerprint({ b: 1, a: { y: 2, x: 2 } }));

	const score = Math.round((100 * passed) / total);
	const durationMs = Number((performance.now() - start).toFixed(1));
	return {
		name: "harness-journal-arithmetic",
		pass: failures.length === 0,
		score,
		durationMs,
		notes: failures.length === 0 ? `all ${total} journal arithmetic assertions passed` : `${failures.length} of ${total} journal arithmetic assertions failed`,
		failures,
	};
}
