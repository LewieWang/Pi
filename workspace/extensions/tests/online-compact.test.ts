/**
 * Online Context Compact tests.
 *
 * The compact-decision logic and the plan-transition analyzer are pure
 * functions and easy to test directly. The event-handler orchestration is
 * exercised by hand in the end-to-end run; we don't try to drive Pi's
 * runtime here.
 */

import * as a from "node:assert";
import { describe, test } from "node:test";
import {
	DEFAULT_ECONOMICS,
	decideCompaction,
	shouldFireAbort,
	type CompactionInputs,
} from "../online-compact/economics.js";
import {
	analyzePlanTransition,
	emptyPlan,
	firstIncompleteStep,
	formatPlanSnapshot,
	parsePlanSteps,
	type PlanSnapshot,
} from "../online-compact/plan.js";
import {
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordProviderRequest,
} from "../online-compact/state.js";

function baseInputs(overrides: Partial<CompactionInputs> = {}): CompactionInputs {
	return {
		writeTokens: 0,
		contextWindow: 100_000,
		completionBoundary: false,
		requestsSinceLast: null,
		cacheWriteReadRatio: 0.0,
		economics: DEFAULT_ECONOMICS,
		...overrides,
	};
}

describe("decideCompaction", () => {
	test("refuses when there is no context window", () => {
		const d = decideCompaction(baseInputs({ contextWindow: null }));
		a.equal(d.compact, false);
		a.match(d.reason, /no-context-window/);
	});

	test("refuses when there is no boundary", () => {
		const d = decideCompaction(
			baseInputs({ writeTokens: 90_000, completionBoundary: false }),
		);
		a.equal(d.compact, false);
		a.match(d.reason, /no-boundary/);
	});

	test("refuses when context is below the high-water mark", () => {
		const d = decideCompaction(
			baseInputs({ writeTokens: 50_000, completionBoundary: true }),
		);
		a.equal(d.compact, false);
		a.match(d.reason, /below-high-water/);
	});

	test("refuses when too few requests since last compaction", () => {
		const d = decideCompaction(
			baseInputs({
				writeTokens: 90_000,
				completionBoundary: true,
				requestsSinceLast: 1,
			}),
		);
		a.equal(d.compact, false);
		a.match(d.reason, /too-soon/);
	});

	test("compacts when over high-water and a boundary", () => {
		const d = decideCompaction(
			baseInputs({ writeTokens: 90_000, completionBoundary: true, requestsSinceLast: 10 }),
		);
		a.equal(d.compact, true);
		a.ok(d.archiveTokens > 0);
		a.equal(d.memoTokens, 1_000);
		a.ok(d.postCompactionTokens < d.archiveTokens + d.memoTokens);
	});

	test("refuses when cache write cost exceeds savings", () => {
		// Over high-water, but cache-write is expensive enough that compact loses money.
		// archive 70k, memo 1k, ratio=2.0: net = 70k * (1-2) - 1k = -71k → refuse.
		const d = decideCompaction(
			baseInputs({
				writeTokens: 90_000,
				completionBoundary: true,
				requestsSinceLast: 10,
				cacheWriteReadRatio: 2.0,
			}),
		);
		a.equal(d.compact, false);
		a.match(d.reason, /cache-debt-too-high/);
	});
});

describe("parsePlanSteps", () => {
	test("rejects non-array input", () => {
		a.equal(parsePlanSteps(null), null);
		a.equal(parsePlanSteps("string"), null);
		a.equal(parsePlanSteps({}), null);
	});
	test("rejects empty array", () => {
		a.equal(parsePlanSteps([]), null);
	});
	test("normalizes status and rejects malformed entries", () => {
		const parsed = parsePlanSteps([
			{ id: "a", goal: "first" },
			{ id: "b", goal: "second", status: "completed" },
		]);
		a.ok(parsed);
		a.equal(parsed!.length, 2);
		a.equal(parsed![0].status, "pending");
		a.equal(parsed![1].status, "completed");
	});
	test("rejects entries missing id or goal", () => {
		const parsed = parsePlanSteps([{ id: "a" }, { id: "b", goal: "x" }]);
		a.equal(parsed, null);
	});
});

describe("analyzePlanTransition", () => {
	test("detects newly completed steps", () => {
		const before: PlanSnapshot = {
			steps: [
				{ id: "a", goal: "first", status: "in_progress" },
				{ id: "b", goal: "second", status: "pending" },
			],
			updatedAt: 0,
		};
		const after = [
			{ id: "a", goal: "first", status: "completed" as const },
			{ id: "b", goal: "second", status: "in_progress" as const },
		];
		const t = analyzePlanTransition(before, after);
		a.equal(t.completedSteps.length, 1);
		a.equal(t.completedSteps[0].id, "a");
		a.ok(t.advice.some((s) => s.includes("a")));
	});

	test("ignores steps that were already completed", () => {
		const before: PlanSnapshot = {
			steps: [{ id: "a", goal: "x", status: "completed" }],
			updatedAt: 0,
		};
		const t = analyzePlanTransition(before, before.steps);
		a.equal(t.completedSteps.length, 0);
	});

	test("ignores brand-new steps", () => {
		const before = emptyPlan();
		const t = analyzePlanTransition(before, [
			{ id: "a", goal: "x", status: "completed" as const },
		]);
		a.equal(t.completedSteps.length, 0);
	});
});

describe("formatPlanSnapshot", () => {
	test("renders empty plan", () => {
		a.equal(formatPlanSnapshot(emptyPlan()), "(empty plan)");
	});
	test("uses unicode markers for each status", () => {
		const text = formatPlanSnapshot({
			steps: [
				{ id: "a", goal: "first", status: "completed" },
				{ id: "b", goal: "second", status: "in_progress" },
				{ id: "c", goal: "third", status: "pending" },
			],
			updatedAt: 0,
		});
		a.ok(text.includes("✓"));
		a.ok(text.includes("…"));
		a.ok(text.includes("a: first"));
		a.ok(text.includes("b: second"));
		a.ok(text.includes("c: third"));
	});
});

describe("firstIncompleteStep", () => {
	test("returns undefined when everything is done", () => {
		const snap: PlanSnapshot = {
			steps: [{ id: "a", goal: "x", status: "completed" }],
			updatedAt: 0,
		};
		a.equal(firstIncompleteStep(snap), undefined);
	});
	test("returns the first non-completed step in order", () => {
		const snap: PlanSnapshot = {
			steps: [
				{ id: "a", goal: "x", status: "completed" },
				{ id: "b", goal: "y", status: "in_progress" },
				{ id: "c", goal: "z", status: "pending" },
			],
			updatedAt: 0,
		};
		const step = firstIncompleteStep(snap);
		a.ok(step);
		a.equal(step!.id, "b");
	});
});

describe("state helpers", () => {
	test("initialOnlineState is fresh", () => {
		const s = initialOnlineState();
		a.equal(s.requestCount, 0);
		a.equal(s.lastCompactionRequestCount, null);
		a.equal(s.nativeCompactionCount, 0);
		a.equal(s.plan.steps.length, 0);
	});

	test("recordProviderRequest increments counters", () => {
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordProviderRequest(s, 200);
		a.equal(s.requestCount, 2);
		a.equal(s.positiveContextDeltaCount, 2);
		a.equal(s.positiveContextDeltaTotal, 200);
	});

	test("recordBoundary records request count and grows array", () => {
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordBoundary(s);
		s = recordProviderRequest(s, 200);
		s = recordBoundary(s);
		a.deepEqual(s.completedBoundaryRequestCounts, [1, 2]);
	});

	test("recordCompaction updates lastCompactionRequestCount and debt", () => {
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordCompaction(s, 30_000, 1_000);
		a.equal(s.nativeCompactionCount, 1);
		a.equal(s.lastCompactionRequestCount, 1);
		a.equal(s.cacheDebtTokens, 29_000);
	});
});

describe("shouldFireAbort", () => {
	test("fires when plan has steps AND we have prior compactions", () => {
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordCompaction(s, 30_000, 1_000);
		s = { ...s, plan: { steps: [{ id: "a", goal: "x", status: "in_progress" }], updatedAt: 1 } };
		const g = shouldFireAbort(s);
		a.equal(g.fire, true);
		a.equal(g.reason, null);
	});

	test("refuses to fire when plan is empty (the bug repro)", () => {
		// Reproduces session 2026-10-15T06-40-47-400Z:
		// decideCompaction said compact=true at ratio 0.73 but the plan
		// was always empty. Without this gate the agent loops on aborts
		// forever without ever compacting.
		let s = initialOnlineState();
		s = recordProviderRequest(s, 145_958);
		s = recordCompaction(s, 30_000, 1_000);
		s = recordProviderRequest(s, 145_958 + 5_000);
		// plan is still empty (steps: []), lastCompactionRequestCount is set.
		const g = shouldFireAbort(s);
		a.equal(g.fire, false);
		a.equal(g.reason, "empty-plan");
	});

	test("refuses to fire on first request (cold-start guard)", () => {
		// decideCompaction's "too-soon" gate is bypassed when
		// lastCompactionRequestCount is null (since requestsSinceLast
		// becomes null too). Without this gate, the very first turn
		// with high water would immediately compact.
		let s = initialOnlineState();
		s = recordProviderRequest(s, 145_958);
		s = { ...s, plan: { steps: [{ id: "a", goal: "x", status: "in_progress" }], updatedAt: 1 } };
		// lastCompactionRequestCount is still null (never compacted).
		const g = shouldFireAbort(s);
		a.equal(g.fire, false);
		a.equal(g.reason, "first-request");
	});

	test("empty-plan takes precedence over first-request (deterministic order)", () => {
		// When BOTH conditions hold (initial state: empty plan, no
		// compactions yet), the gate returns empty-plan. The order
		// matters for the journal reason string so debugging is
		// unambiguous.
		const s = initialOnlineState();
		const g = shouldFireAbort(s);
		a.equal(g.fire, false);
		a.equal(g.reason, "empty-plan");
	});

	test("fires after plan is added AND prior compactions exist", () => {
		// Simulate the happy path: agent starts, uses update_plan,
		// crosses high-water, then later gets a meaningful turn.
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordCompaction(s, 1_000, 100);
		s = { ...s, plan: { steps: [{ id: "a", goal: "x", status: "in_progress" }], updatedAt: 1 } };
		s = recordProviderRequest(s, 145_000);
		const g = shouldFireAbort(s);
		a.equal(g.fire, true);
		a.equal(g.reason, null);
	});

	test("still fires when plan is non-empty even if just past high-water", () => {
		// Sanity check: the gate is purely structural, not token-based.
		// decideCompaction handles the token ratio separately.
		let s = initialOnlineState();
		s = recordProviderRequest(s, 100);
		s = recordCompaction(s, 1_000, 100);
		s = { ...s, plan: { steps: [{ id: "a", goal: "x", status: "in_progress" }], updatedAt: 1 } };
		const g = shouldFireAbort(s);
		a.equal(g.fire, true);
	});
});