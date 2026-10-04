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

## Outcome classes

`pass` and `fail` are grades. `unknown` means the grader could not perform a
check. `harness-error` means the harness ended the attempt. `authority-hold`
means the run parked on a decision the evaluation may not take (an approval or
merge) and was left pending: it is not a failure, not a malfunction, and not a
pass, so keep it out of model-quality denominators and count it on its own.
Records written before this class existed keep their original outcome; a
supplementary `reclassification-*.json` beside them says what they would be.

## Status

- **First live canary**: `eval-20261003-2` `pj-s-question` n=1 via the ship
  adapter (pass). Mock-adapter validation predates it.
- **First executed batch (2026-10-04, configuration A only)**:
  `eval-20261003-3`, `eval-20261003-4`, `eval-20261004-1` (11 scenarios
  × 3 repeats; `pj-b-db-migration` excluded as planned) plus
  `eval-20261004-2/-3/-4` (`pj-c-same-pr` × 3). Summary and honest reads:
  [../BATCH_2026-10-04.md](../BATCH_2026-10-04.md). 24/33 first-attempt
  passes, $1.81 priced, $0 real spend (coding-plan key). Records earlier
  than this batch were scored under the pre-PR-#34 graders and keep their
  original grades.
