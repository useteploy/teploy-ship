# Results

Baseline results for the S02 product-journey scenarios. Per-run layout:

```
results/
  <run-id>/                 # e.g. 2026-09-22T1400-zai-glm53
    summary.json            # roll-up: per-scenario pass/fail, totals
    <scenario-id>/
      result.json           # one record per scenario, shape: schema.json
      preserve/
        transcript.txt      # the raw run transcript — NEVER deleted by tooling
        first-failed-attempt/  # failed attempts preserved verbatim, not retried away
      artifacts/            # grader output, diffs, screenshots, logs
```

## Rules

1. **Failures are preserved.** Failed attempts are never deleted or
   overwritten by tooling; a retry writes a new `result.json` field
   (`attempts[]` grows) and the old raw output stays under `preserve/`.
   The only allowed writes under `preserve/` are additive.
2. **Verified vs claimed evidence.** `result.json` separates
   `verifiedEvidence` (what a grader independently established) from
   `claimedEvidence` (what the agent asserted). A run where these disagree
   is recorded, not corrected.
3. **Cost is priced or unknown — never guessed.** `cost.status` is
   `priced` (with amount + source, e.g. gateway telemetry) or `unknown`
   (with a reason). No baseline row may carry an invented number.
4. **Exact revisions.** Every record pins `harnessRevision` and
   `fixtureRevision` (git SHA or content hash) so a baseline is
   reproducible.

## Status: NO BASELINE NUMBERS EXIST YET

Nothing has run. This directory contains the schema and the convention
only. The first real baseline requires the execution wiring that this
slice deliberately does not include (see the runner's spend gate).
