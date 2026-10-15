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
| 2026-10-15 23:18Z | harness-journal | evolve/harness-journal-20261015 | merged (pre-S2 baseline) |

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
