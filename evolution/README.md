# Harness evolution engine (S2 / candidate-tree + probe scoring)

This directory is the persistent memory of the harness self-evolution
engine. It is the **S2** layer of the three-paper plan:

| Layer | Status |
|---|---|
| S1 — evolution write-back log (this `evolution/` dir, `evolution-log.md`) | ✅ shipped |
| **S2 — candidate tree + probe scoring** | **🚧 in progress** |
| S3 — diagnosis skill + regression gate (needs ≥5 cases incl. ≥2 failures) | pending |

ERA-style idea: every change to this repo is a candidate that we score
with cheap assertions; winners merge into `main`, losers are recorded
but discarded. The branch is the candidate tree, the probe output is
the quality signal.

## Layout

```
evolution/
  evolution-log.md     append-only log; one entry per evolution attempt
  probes/              cheap assertion scripts; each outputs a ProbeResult
    run.mjs            entry point — runs all probes (or one by name)
    schema-strict.mjs  parseConfig / parseHarnessJournal strict-schema
    extensions-load.mjs every extension factory loadable + createable
    footer-arithmetic.mjs  footer-override._internal pure math
    harness-journal-arithmetic.mjs  harness-journal snapshot.ts pure math
  failures/            one .md per rolled-back candidate (append-only)
```

## Branch convention

```
evolve/<short-name>-<YYYYMMDD>
```

One branch per candidate. Squash-merge on win, delete on loss. The
deleted branch's tag and the `evolution-log.md` entry preserve the
trajectory.

## Probe protocol

Each probe is a `.mjs` script that exports `run()` returning:

```ts
{ name: string, pass: boolean, score: number /* 0..100 */, durationMs: number, notes?: string }
```

`run.mjs` orchestrates all probes, prints one JSON result per line on
stdout and a summary table on stderr. Exit code 0 iff **all probes pass**.

## Running

```bash
# Build first so probes can dynamic-import dist/**
npm run build

# All probes
node evolution/probes/run.mjs

# Single probe
node evolution/probes/run.mjs schema-strict
```

Full run target: **< 2 minutes** on a single thread, no LLM calls.
If a probe takes > 10s it should be flagged and re-thought.

## Regression red line

A candidate is **rejected** (branch deleted, `failures/<date>-<goal>.md`
written) if **any** probe changes from `pass:true` to `pass:false`, OR
if the candidate's aggregate score is ≤ the baseline recorded at
branch start. Wins fast-forward `main` and the proposal is tagged.

## Logging

Every attempt — win or loss — appends a section to `evolution-log.md`.
Entries are **append-only**. Do not edit history; if a previous
diagnosis is wrong, write a new entry that supersedes it.
