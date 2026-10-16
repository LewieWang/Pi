# Failure case — 2026-10-15 / branch `evolve/failure-smoke-20261015`

> **Outcome**: rolled back (red line triggered).
> **Branch**: `evolve/failure-smoke-20261015` (kept as evidence; never merged).
> **Smoke commit on branch**: `81a45b2` `smoke(failure): regress formatTokens
> [1e3,1e4) to "BAD-N" (DO NOT MERGE)`.

## Symptom

Probe `footer-arithmetic` flipped from `pass:true` to `pass:false`
during the candidate evaluation. Aggregate dropped from `100/100` →
`97/100`. `run.mjs` exited with code `1`.

## Probe output (from the run that triggered the rollback)

```
{"name":"schema-strict","pass":true,"score":100,"durationMs":34.0}
{"name":"extensions-load","pass":true,"score":100,"durationMs":1757.7}
{"name":"footer-arithmetic","pass":false,"score":88,"durationMs":0.2,"notes":"5 of 40 format assertions failed","failures":[
  "formatTokens(1000): expected \"1.0k\" got \"BAD-1000\"",
  "formatTokens(1500): expected \"1.5k\" got \"BAD-1500\"",
  "formatTokens(9500): expected \"9.5k\" got \"BAD-9500\"",
  "formatTokens(9999): expected \"10.0k\" got \"BAD-9999\"",
  "formatTokens not strictly monotonic: BAD-2000 < 20k < 200k < 2.0M < 20M < 2.0B < 20B"
]}
{"name":"harness-journal-arithmetic","pass":true,"score":100,"durationMs":1.8}

aggregate: 97/100 · total: 1.80s · FAIL
```

## Assumed hypothesis (the candidate had)

A naive "fix" to the [1e3, 1e4) bracket would just shrink the band to
emit integer numbers instead of decimal `"X.Yk"` because the test was
not asserting that boundary. The smoke seed replaced the band with
`return \`BAD-${count}\`;` to confirm the probe will catch a real
change even when npm test still passes.

## Why the hypothesis was wrong

`evolution/probes/footer-arithmetic.mjs` enumerates **every** bracket
boundary (`1000`, `1500`, `9500`, `9999`) and a monotonic helper
spans all five magnitude bands in one shot. A regression that loses
the suffix — `"BAD-1000"` instead of `"1.0k"` — simultaneously fails
five distinct assertions, so the red line trips the moment the band
is touched.

## Diagnostic conclusion

`formatTokens` requires **exact** string invariants. Any change to the
function must be paired with an update to `footer-arithmetic.mjs`
adding the new expected outputs. The probe is the only signal we
have of these micro-rules because `npm test` does not exercise the
formatting helpers directly. This is by design: it forces harness
modifications to leave a paper trail through the probe file.

## Final state on main

The broken branch was **not merged**. `main` was untouched. After this
candidate was rejected:

- `npm test`: 131/131 (unchanged)
- `aggregate probe score`: 100/100 (unchanged)

## Lessons folded into the diagnosis skill (for S3)

When adding new bracketing behaviour to a pure formatter, the probe
file is the spec. Do not edit `formatTokens` without also adding the
expected `(input, output)` pair to the case list. The simplest edit
loop is: change implementation + change probe boundary together,
then re-run.

Path forward for S3: the diagnosis skill should treat
"formatTokens style failure" as a **bracket-collapse** symptom with
the canonical repair being "restore the old branch / append a new
band". Any failure of this kind should map back to this case study.
