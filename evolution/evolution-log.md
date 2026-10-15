# Evolution log

Append-only. One section per candidate attempt. Most recent at top.

Index by goal-tag and date for `rg`/`jq` search. Suggested queries:

```bash
# all attempts for a goal
rg -i "goal: faster-token-format" evolution/evolution-log.md

# everything on a date
rg -A2 "## 2026-10-15" evolution/evolution-log.md

# all rolled-back attempts (failures)
rg "outcome: rollback" evolution/evolution-log.md

# structured JSON dump (jq over the timestamp lines)
rg "^\| timestamp" evolution/evolution-log.md
```

| timestamp | goal | branch | outcome |
|---|---|---|---|
| 2026-10-15 23:54Z | format-tokens-billions | evolve/format-tokens-billions-20261015 | merged (100/100) |
| 2026-10-15 23:33Z | evolution-probes | (main) | merged (S2 scaffold) |
| 2026-10-15 23:18Z | harness-journal | evolve/harness-journal-20261015 | merged (pre-S2 baseline) |

---

## 2026-10-15 — S2 cycle 1: formatTokens extends through B (10⁹)

- **timestamp**: 2026-10-15T23:54Z
- **branch**: `evolve/format-tokens-billions-20261015`
- **commit**: `29d15ad`
- **tag**: `evolved-format-tokens-billions-20261015`
- **goal**: extend `formatTokens()` to the billions bracket so total
  cost strings render as `1.2B` instead of rolling up to `1200M`.
- **hypothesis**: the existing footer-arithmetic probe can absorb this
  with only added boundary cases; no existing bracket shrinks, so
  regression risk is zero against the old assertion set.
- **change summary** (+26 / −5):
  - `footer-override/index.ts`: two new `if` branches for
    `[1e9, 1e10) ⇒ "X.YB"` and `[1e10, ∞) ⇒ "XB"` plus an extended
    doc-comment listing the new bracket table.
  - `evolution/probes/footer-arithmetic.mjs`: +8 boundary assertions
    covering 999_999_999 (last M-bucket entry) through 5e10; the
    monotonic helper now scans up to 2e10 so future bracket shrinks
    would be caught.
- **probe before** (clean `main` at `9010cc1`):
  ```
  schema-strict               ✓ 100/100     26.1 ms    (23/23)
  extensions-load             ✓ 100/100   1769.1 ms    (14/14)
  footer-arithmetic           ✓ 100/100      0.2 ms    (32/32)
  harness-journal-arithmetic  ✓ 100/100      1.7 ms    (44/44)
  aggregate: 100/100 · total: 1.80s · 113 assertions
  ```
- **probe after** (branch tip):
  ```
  schema-strict               ✓ 100/100     33.7 ms    (23/23)
  extensions-load             ✓ 100/100   1788.0 ms    (14/14)
  footer-arithmetic           ✓ 100/100      0.2 ms    (40/40)   +8
  harness-journal-arithmetic  ✓ 100/100      1.7 ms    (44/44)
  aggregate: 100/100 · total: 1.83s · 121 assertions
  ```
- **red line check**: no probe flipped `pass`→`fail`. Score
  non-decreasing. Assertion coverage gained +8.
- **npm test**: 131/131 in 19.6s (unchanged).
- **decision**: **merge** (fast-forward into `main`).
- **outcome**: ✅ merged; branch preserved for traceability; tag
  `evolved-format-tokens-billions-20261015` placed on the merge point.
- **next**: deliberate regression probe to verify the red-line auto-
  rollback path (Phase D).

---

## 2026-10-15 — S2 scaffold: evolution/ + probes/ + append-only log

- **timestamp**: 2026-10-15T23:33Z
- **commit**: `36171db`
- **goal**: lay down the candidate-tree + probe-scoring engine so every
  subsequent attempt has a real before/after signal to be decided on.
- **hypothesis**: four narrow assertions-heavy probes that exercise
  schema strictness, module loading, footer arithmetic and harness-
  journal arithmetic cover the load-bearing parts of the harness
  without paying the cost of LLM-as-judge.
- **change summary**: 7 new files / +815 lines:
  - `evolution/README.md` (protocol + branch convention)
  - `evolution/evolution-log.md` (append-only journal)
  - `evolution/probes/run.mjs` (orchestrator)
  - `evolution/probes/schema-strict.mjs` (23 assertions)
  - `evolution/probes/extensions-load.mjs` (14 assertions)
  - `evolution/probes/footer-arithmetic.mjs` (32 assertions)
  - `evolution/probes/harness-journal-arithmetic.mjs` (44 assertions)
- **probe baseline** (this commit, on a clean `main`):
  ```
  schema-strict               ✓ 100/100    26.1 ms
  extensions-load             ✓ 100/100  1769.1 ms
  footer-arithmetic           ✓ 100/100     0.2 ms
  harness-journal-arithmetic  ✓ 100/100     1.7 ms
  aggregate: 100/100 · total: 1.80s · PASS
  ```
- **outcome**: ✅ merged into `main` (no branch — a scaffold is
  not a candidate).
- **next**: pick the first real candidate (e.g. a small footer-
  arithmetic polish), branch `evolve/<goal>-20261015`, run the
  loop, and write a section here comparing baseline vs candidate.

---

## 2026-10-15 — pre-S2 baseline: capture unfinished harness-journal work as the main-branch starting point

- **timestamp**: 2026-10-15T23:18Z
- **goal**: get `main` to a clean, fully tested state before S2 starts
  asking questions of it. Two pending commits (footer-override cache
  arithmetic + harness-journal extension wiring) were sitting in the
  working tree, untagged, untested.
- **hypothesis**: the working-tree state is correct; bundling it onto
  `main` as `evolve/harness-journal-20261015` produces the cleanest
  pre-S2 baseline we will evolve from.
- **change summary**:
  - `86346ab` `fix(footer-override): include reasoning tokens +
    cacheWrite in hit-rate denominator` (56 / -20)
  - `96597c3` `feat(harness-journal): persistent filesystem memory for
    self-evolution` (1465 / -2)
- **probe baseline**: N/A — probes/ was created later in this same
  evolution cycle. Test baseline: `npm test` ⇒ **131/131 in 22.3s**.
- **outcome**: ✅ `merged` (fast-forward into `main`); tagged
  `pre-s2-baseline-20261015`. Branch preserved for traceability.
- **next**: build `evolution/probes/` and the run-loop so every
  subsequent entry below has a real `probeBefore` / `probeAfter`
  block.
