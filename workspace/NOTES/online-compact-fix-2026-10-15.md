# online-compact abort-loop fix (2026-10-15)

## Bug

In session `2026-10-15T06-40-47-400Z` (35 min, 620 messages) the agent's last 4
minutes show:

| ts | writeTokens | window | ratio | decideCompaction | abort |
|---|---|---|---|---|---|
| 07:11:58.283 | 145,958 | 200,000 | 0.730 | compact=true | fire |
| 07:15:11.869 | 150,752 | 200,000 | 0.754 | compact=true | fire |
| 07:15:47.245 | 141,437 | 200,000 | 0.707 | compact=true | fire |

Each abort produced an empty assistant turn with
`stopReason: error`, `errorMessage: "This operation was aborted"`. From the
user's view: "the agent ran one tool then died."

## Root cause (two bugs)

### 1. `context.abort()` fired with no plan

`turn_end` only checked `decideCompaction.compact`. The abort then killed
the in-flight response *before* `agent_settled → planSafe` ran. `planSafe`
had an early-return for empty plan:

```ts
if (plan.steps.length === 0) {
  void journal.record({ kind: "online_compact_skipped", reason: "empty-plan" });
  return;
}
```

So the abort interrupted the model, but `planSafe` refused to compact,
so the context never shrank → next turn → same conditions → abort again.
Endless loop.

In this session `plan.steps` was always `[]` (the agent never used
`update_plan`). The journal confirms:
- `online_compact_decision.compact=true` was recorded 7 times
- `online_compact_trigger`: **0**
- `online_compact_skipped` (the planSafe kind): **0** (because planSafe
  never reached the record call — but the abort already fired)

### 2. First-ever request bypasses the "too-soon" gate

`decideCompaction` has:

```ts
if (input.requestsSinceLast !== null && input.requestsSinceLast < economics.minRequestsBetween) {
  return fail("too-soon", ...);
}
```

But `requestsSinceLast` is computed from
`state.requestCount - state.lastCompactionRequestCount`. On the first ever
turn, `lastCompactionRequestCount === null` → `requestsSinceLast = null`
→ the gate short-circuits. Cold start can compact immediately.

## Fix

Two-line state-based gate added between `decideCompaction` and
`context.abort()`:

```ts
const gate = shouldFireAbort(r.state);
if (!gate.fire) {
  await journal.record({
    kind: "online_compact_skipped",
    reason: gate.reason as string,
  });
  return;
}
```

`shouldFireAbort(state)` is a pure function in `economics.ts`:

```ts
export function shouldFireAbort(state: OnlineState): AbortGateDecision {
  if (state.plan.steps.length === 0) {
    return { fire: false, reason: "empty-plan" };
  }
  if (state.lastCompactionRequestCount === null) {
    return { fire: false, reason: "first-request" };
  }
  return { fire: true, reason: null };
}
```

## Tests

`extensions/tests/online-compact.test.ts` — added 6 tests in a new
`describe("shouldFireAbort")` block:
1. fires when plan + prior compactions exist
2. refuses to fire when plan is empty (reproduces the bug)
3. refuses to fire on first request
4. empty-plan takes precedence over first-request
5. fires after plan + later compactions
6. structural-only: still fires when plan non-empty even if just past high-water

`extensions/tests/online-compact-bug-repro.test.ts` — 3 regression tests
that reproduce the exact writeTokens from the 3 aborts in the bug session,
asserting that `decideCompaction.compact === true` (policy unchanged) but
`shouldFireAbort.fire === false` (gate refuses).

## Test results

```
tests 30
pass 30
fail 0
```

(21 pre-existing + 6 shouldFireAbort + 3 bug repro)

The pre-existing `footer-override/index.ts(423,38)` ThemeBg type error
and `footer-override.test.ts` `registerEntryRenderer` mock gap are
unrelated to this fix.

## Files changed

| file | change |
|---|---|
| `extensions/online-compact/economics.ts` | +import OnlineState; +AbortGateDecision; +shouldFireAbort |
| `extensions/online-compact/index.ts` | +import shouldFireAbort; +gate check before `context.abort()`; +journal skip record |
| `extensions/tests/online-compact.test.ts` | +import shouldFireAbort; +6 tests |
| `extensions/tests/online-compact-bug-repro.test.ts` | NEW: 3 regression tests |

## Defense-in-depth

`planSafe`'s empty-plan guard is kept. With the new abort gate, planSafe's
empty-plan branch is unreachable in normal flow (abort never fires when
plan is empty). It stays as a guard in case state ever drifts between
`turn_end` and `agent_settled`.