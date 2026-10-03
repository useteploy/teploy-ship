# Baseline recount, 2026-10-03

## Human note (written by hand; everything below the rule is generated)

The programme document states a frozen baseline of "21 passes, 13 failures and two human-gated harness errors over 36 attempts". **That figure cannot be reproduced from the retained records.** Nothing was adjusted to make it match.

What the repository holds is 28 `result.json` records across 20 run directories (`eval-20260922-1..4`, `eval-20260924-1..16`), no unreadable record, and no result ever deleted from git history (checked with `git log --all --diff-filter=D`). Counted by class, using the recorded `outcome` where present and `outcomeOf` from `scripts/eval-journeys-lib.mjs` where it is absent:

| class | records |
| --- | --- |
| pass | 15 |
| fail | 5 |
| unknown | 6 |
| harness-error | 2 |
| authority-hold | 0 |
| total | 28 |

Why the numbers differ, as far as the records show:

- **Total.** 28 retained attempts against 36 stated: 8 attempts are not in the repository. The programme text itself says the private completion receipts (`COMPLETION_2026-09-25/`) are not available here, so they may be the source of the 36; that was not checked and cannot be from this repository.
- **Passes and failures.** Only 15 passes are retained, not 21, and 5 failures, not 13. Six records are `unknown` (the grader could not check: every failing reason is `not-wired`). The per-run `summary.json` files written before the `unknown` class existed count those six as `fail`, and the one plain harness error as `fail` too; seven `summary.json` totals disagree with this recount (listed under Consistency checks). Counted that old way the retained set reads 15 pass, 11 fail, 2 harness-error over 28, and that does not match 21/13/2 either.
- **The two harness errors.** The retained set does contain two `harness-error` records, which matches the count of 2, but they are not both human-gated. `eval-20260924-16/pj-b-db-migration` parked on a change-approval decision; a supplementary `reclassification-authority-hold.json` says it is an authority hold. That is listed, not applied: the original record still says `harness-error`, so it sits in the harness-error count. `eval-20260924-10/pj-c-review` is a plain adapter failure (`workspace poll failed ... fetch failed`).
- **Supplements.** `eval-20260924-13/pj-s-question` was regraded to pass by `regrade-table-citations.json` after a grader fix, with no model rerun. It is counted as `fail` here because the original record says so. Applying both supplements would give 16 pass, 4 fail, 6 unknown, 1 harness-error, 1 authority-hold (28). That is a sensitivity reading only.
- **The pass rate is not a model-quality number.** 15 of 20 graded spans eleven scenarios of unequal difficulty, and 10 of the 20 graded attempts are repeats of the single `pj-s-question` scenario, run while the harness and grader were being fixed. The records pin different `harnessRevision` values.
- **Cost.** 12 records are priced, 16 are unknown. The priced sum is a lower bound. Two priced records show exactly 0 (`eval-20260924-12`, `eval-20260924-14`); `eval-20260924-14/.../cost-reconciliation.json` shows the zero was sampled before terminal usage existed (reconciled 0.0367178 USD; not applied here).
- **Latency.** Two records show 0 ms and 1 ms and are excluded from the statistics, not deleted.

Regenerate the body with `node scripts/eval-report.mjs --date 2026-10-03`; the generator does not write this note.

---

# Product-journey evaluation recount (2026-10-03)

Source: `evals/product-journeys/results`. Records found: 28; counted: 28; unreadable: 0; runs: 20.
Outcome class source: recorded 13, derived 15 (older records lack `outcome`; derived with outcomeOf from eval-journeys-lib.mjs), other 0.

## Raw counts per outcome class

| class | records |
| --- | --- |
| pass | 15 |
| fail | 5 |
| unknown | 6 |
| harness-error | 2 |
| authority-hold | 0 |
| total counted | 28 |

## Model-quality view

Denominator (pass + fail): **20**. Pass: 15. Fail: 5. Pass rate: 75.0%.
denominator is pass + fail only; unknown, harness-error and authority-hold are excluded (see exclusions).

First-attempt success (graded records): 15 pass, 5 not-pass, 0 not recorded, of 20.
Eventual success (no rescue): 15 pass, 5 not-pass, 0 not recorded, of 20.

## Authority holds (reported separately)

Count: 0. Not a pass, not a failure, not a harness malfunction; excluded from the denominator.

## Interventions and rescue

Interventions: 1 total over 1 record(s); not recorded on 0. By kind: clarification 1.
Rescue: needed 1, provided 0, field absent on 15 record(s).

## Cost

Priced: 12. Unknown: 16. Priced without an amount: 0. No cost field: 0. Currencies: USD.
Sum over priced records only: 0.560513 (a lower bound: unknown-cost records are NOT zero and are not in this sum).
Suspect: 2 priced record(s) carry an amount of exactly 0, which more likely means usage was not yet readable than that the run was free:
- `eval-20260924-12/pj-s-question/result.json`
- `eval-20260924-14/pj-s-copy/result.json`

## Latency

All records at or above 1000 ms: n=26, min 12000 ms, median 129852 ms, mean 157848 ms, max 451931 ms.
Graded (pass/fail) only: n=18, min 12000 ms, median 113057.5 ms, mean 153311 ms, max 451931 ms.
Excluded as implausible (< 1000 ms): `eval-20260922-1/pj-s-question/result.json` (1 ms), `eval-20260922-3/pj-s-question/result.json` (0 ms).

## By run

| run | pass | fail | unknown | harness-error | authority-hold | scenarios |
| --- | --- | --- | --- | --- | --- | --- |
| eval-20260922-1 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260922-2 | 0 | 1 | 0 | 0 | 0 | pj-s-question:fail |
| eval-20260922-3 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260922-4 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260924-1 | 0 | 1 | 0 | 0 | 0 | pj-s-question:fail |
| eval-20260924-10 | 0 | 0 | 0 | 1 | 0 | pj-c-review:harness-error |
| eval-20260924-11 | 0 | 0 | 1 | 0 | 0 | pj-c-review:unknown |
| eval-20260924-12 | 0 | 1 | 0 | 0 | 0 | pj-s-question:fail |
| eval-20260924-13 | 0 | 1 | 0 | 0 | 0 | pj-s-question:fail |
| eval-20260924-14 | 1 | 0 | 0 | 0 | 0 | pj-s-copy:pass |
| eval-20260924-15 | 2 | 1 | 0 | 0 | 0 | pj-b-api-defect:pass, pj-c-review:fail, pj-s-plan:pass |
| eval-20260924-16 | 6 | 0 | 0 | 1 | 0 | pj-b-db-migration:harness-error, pj-b-deploy-recovery:pass, pj-b-perms-defect:pass, pj-c-dependency-update:pass, pj-c-same-pr:pass, pj-c-scheduled-job:pass, pj-s-feature:pass |
| eval-20260924-2 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260924-3 | 0 | 0 | 1 | 0 | 0 | pj-s-plan:unknown |
| eval-20260924-4 | 0 | 0 | 1 | 0 | 0 | pj-c-review:unknown |
| eval-20260924-5 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260924-6 | 0 | 0 | 1 | 0 | 0 | pj-s-plan:unknown |
| eval-20260924-7 | 0 | 0 | 1 | 0 | 0 | pj-c-review:unknown |
| eval-20260924-8 | 1 | 0 | 0 | 0 | 0 | pj-s-question:pass |
| eval-20260924-9 | 0 | 0 | 1 | 0 | 0 | pj-s-plan:unknown |

## By scenario

| scenario | attempts | pass | fail | unknown | harness-error | authority-hold | graded (pass+fail) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pj-b-api-defect | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-b-db-migration | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| pj-b-deploy-recovery | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-b-perms-defect | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-c-dependency-update | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-c-review | 5 | 0 | 1 | 3 | 1 | 0 | 1 |
| pj-c-same-pr | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-c-scheduled-job | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-s-copy | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-s-feature | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| pj-s-plan | 4 | 1 | 0 | 3 | 0 | 0 | 1 |
| pj-s-question | 10 | 6 | 4 | 0 | 0 | 0 | 10 |

## Consistency checks

Every recorded outcome agrees with the derivation from its first attempt.

summary.json totals that differ from this recount:
- eval-20260924-10 fail: summary 1, recount 0
- eval-20260924-11 fail: summary 1, recount 0
- eval-20260924-3 fail: summary 1, recount 0
- eval-20260924-4 fail: summary 1, recount 0
- eval-20260924-6 fail: summary 1, recount 0
- eval-20260924-7 fail: summary 1, recount 0
- eval-20260924-9 fail: summary 1, recount 0

## EXCLUSIONS

Not counted in the model-quality denominator (pass + fail), or not a record at all. 16 item(s).

| item | kind | why | detail |
| --- | --- | --- | --- |
| `eval-20260924-10/pj-c-review/result.json` | harness-error | harness-error: the harness, not the agent, ended the attempt. Not a model-quality datum. | adapter failed: workspace poll failed for run-bd38680e: fetch failed |
| `eval-20260924-11/pj-c-review/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice) |
| `eval-20260924-16/pj-b-db-migration/result.json` | harness-error | harness-error: the harness, not the agent, ended the attempt. Not a model-quality datum. | adapter failed: run-request-d8af5ac9f0cb4414f4498dc5007da398331605217d727a387f7eceabb4b3248a requires a human decision on change-approval; left pending without approval |
| `eval-20260924-3/pj-s-plan/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice) |
| `eval-20260924-4/pj-c-review/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice) |
| `eval-20260924-6/pj-s-plan/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice) |
| `eval-20260924-7/pj-c-review/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice) |
| `eval-20260924-9/pj-s-plan/result.json` | unknown | unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure. | not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice) |
| `eval-20260924-12/pj-s-question/artifacts/failure-diagnosis.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-12/pj-s-question/result.json |
| `eval-20260924-13/pj-s-question/artifacts/regrade-table-citations.json` | regrade | supplementary regrade: listed, never replaces the original record. The original's class stands in all counts. | original: eval-20260924-13/pj-s-question/result.json \| supplement claims: pass \| Recognize Markdown citation tables; exact-string and coverage checks unchanged. No model rerun. |
| `eval-20260924-14/pj-s-copy/artifacts/cost-reconciliation.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-14/pj-s-copy/result.json \| Original harness record sampled cost at the merge park, before terminal usage existed. Original result retained. |
| `eval-20260924-15/pj-c-review/artifacts/grading-limitation.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-15/pj-c-review/result.json \| Lexical grader limitation: the answer states README.md:10 claims inactivity expiry but the code uses creation time, states sliding-window semantics remain unimplemented, and blocks merge. It does not use a required false-word in the same sentence as README. This is not recorded as a passing grade. |
| `eval-20260924-16/pj-b-db-migration/artifacts/approval-gate-diagnosis.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-16/pj-b-db-migration/result.json \| The additive SQLite migration matches the sensitive migration path rule. The harness intentionally refuses automatic change approval. No PR tree was captured; grader checks ran on the pristine fixture, not on the pending change, and are not a verdict on that implementation. |
| `eval-20260924-16/pj-b-db-migration/artifacts/reclassification-authority-hold.json` | reclassification | supplementary reclassification: listed, never replaces the original record. The original's class stands in all counts. | original: eval-20260924-16/pj-b-db-migration/result.json \| supplement claims: authority-hold \| The run parked on the change-approval decision and the harness deliberately left it pending (it never approves actions). That is an authority hold, not a harness malfunction and not an agent failure. The grader reasons about the missing pinned column describe a tree on which no change was ever approved or applied, so they say nothing about the model's ability to write the migration. |
| `eval-20260924-16/pj-b-db-migration/artifacts/safe-close.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-16/pj-b-db-migration/result.json \| Acceptance fixture reached sensitive-change approval. Declining publication to close the scratch test safely; original evaluation and approval evidence preserved. No approval, push or merge authorized. |
| `eval-20260924-16/pj-b-db-migration/artifacts/terminal-reconciliation.json` | annotation | supplementary annotation: listed for context; never a record, never counted. | original: eval-20260924-16/pj-b-db-migration/result.json |

## Supplement claims (listed, not applied)

| original | counted as | supplement | supplement claims |
| --- | --- | --- | --- |
| `eval-20260924-13/pj-s-question/result.json` | fail | `eval-20260924-13/pj-s-question/artifacts/regrade-table-citations.json` | pass |
| `eval-20260924-16/pj-b-db-migration/result.json` | harness-error | `eval-20260924-16/pj-b-db-migration/artifacts/reclassification-authority-hold.json` | authority-hold |


## Report (JSON)

```json
{
  "resultsRoot": "evals/product-journeys/results",
  "recordsFound": 28,
  "recordsCounted": 28,
  "unreadable": 0,
  "runs": 20,
  "counts": {
    "pass": 15,
    "fail": 5,
    "unknown": 6,
    "harness-error": 2,
    "authority-hold": 0
  },
  "modelQuality": {
    "denominator": 20,
    "pass": 15,
    "fail": 5,
    "passRate": 0.75,
    "note": "denominator is pass + fail only; unknown, harness-error and authority-hold are excluded (see exclusions)."
  },
  "authorityHold": {
    "count": 0,
    "records": []
  },
  "outcomeSources": {
    "recorded": 13,
    "derived": 15,
    "other": 0
  },
  "firstAttempt": {
    "gradedRecords": 20,
    "passed": 15,
    "failed": 5,
    "notRecorded": 0
  },
  "eventualSuccess": {
    "gradedRecords": 20,
    "passed": 15,
    "failed": 5,
    "notRecorded": 0,
    "note": "eventualSuccess is success without rescue; a grader pass with a rescue intervention is not counted."
  },
  "interventions": {
    "total": 1,
    "byKind": {
      "clarification": 1
    },
    "recordsWithAny": 1,
    "recordsNotRecorded": 0,
    "rescue": {
      "needed": 1,
      "provided": 0,
      "notRecorded": 15
    }
  },
  "cost": {
    "pricedRecords": 12,
    "unknownRecords": 16,
    "pricedWithoutAmount": 0,
    "missingRecords": 0,
    "currencies": [
      "USD"
    ],
    "pricedSum": 0.560513,
    "pricedSumIsLowerBound": true,
    "suspectZeroPriced": [
      "eval-20260924-12/pj-s-question/result.json",
      "eval-20260924-14/pj-s-copy/result.json"
    ]
  },
  "latency": {
    "thresholdMs": 1000,
    "all": {
      "n": 26,
      "min": 12000,
      "median": 129852,
      "mean": 157848,
      "max": 451931
    },
    "gradedOnly": {
      "n": 18,
      "min": 12000,
      "median": 113057.5,
      "mean": 153311,
      "max": 451931
    },
    "suspect": [
      {
        "path": "eval-20260922-1/pj-s-question/result.json",
        "latencyMs": 1
      },
      {
        "path": "eval-20260922-3/pj-s-question/result.json",
        "latencyMs": 0
      }
    ],
    "notRecorded": 0
  },
  "consistency": {
    "recordedVsDerivedDisagreements": [],
    "summaryTotalsMismatches": [
      {
        "run": "eval-20260924-10",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-11",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-3",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-4",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-6",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-7",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      },
      {
        "run": "eval-20260924-9",
        "outcome": "fail",
        "summaryTotals": 1,
        "recount": 0
      }
    ]
  },
  "exclusions": [
    {
      "path": "eval-20260924-10/pj-c-review/result.json",
      "kind": "harness-error",
      "reason": "harness-error: the harness, not the agent, ended the attempt. Not a model-quality datum.",
      "detail": "adapter failed: workspace poll failed for run-bd38680e: fetch failed",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-11/pj-c-review/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/result.json",
      "kind": "harness-error",
      "reason": "harness-error: the harness, not the agent, ended the attempt. Not a model-quality datum.",
      "detail": "adapter failed: run-request-d8af5ac9f0cb4414f4498dc5007da398331605217d727a387f7eceabb4b3248a requires a human decision on change-approval; left pending without approval",
      "outcomeSource": "recorded"
    },
    {
      "path": "eval-20260924-3/pj-s-plan/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-4/pj-c-review/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-6/pj-s-plan/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-7/pj-c-review/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: review identifies tests/test_service.py pinning the 24h TTL as the reason the patch breaks the suite (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-9/pj-s-plan/result.json",
      "kind": "unknown",
      "reason": "unknown: the grader could not perform the check (every failing reason is not-wired, or the record lacks fields to grade it). Not a pass, not a failure.",
      "detail": "not-wired: plan artifact references index.html and styles.css (requires execution wiring; not graded in this slice)",
      "outcomeSource": "derived"
    },
    {
      "path": "eval-20260924-12/pj-s-question/artifacts/failure-diagnosis.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-12/pj-s-question/result.json",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-13/pj-s-question/artifacts/regrade-table-citations.json",
      "kind": "regrade",
      "reason": "supplementary regrade: listed, never replaces the original record. The original's class stands in all counts.",
      "detail": "original: eval-20260924-13/pj-s-question/result.json | supplement claims: pass | Recognize Markdown citation tables; exact-string and coverage checks unchanged. No model rerun.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-14/pj-s-copy/artifacts/cost-reconciliation.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-14/pj-s-copy/result.json | Original harness record sampled cost at the merge park, before terminal usage existed. Original result retained.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-15/pj-c-review/artifacts/grading-limitation.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-15/pj-c-review/result.json | Lexical grader limitation: the answer states README.md:10 claims inactivity expiry but the code uses creation time, states sliding-window semantics remain unimplemented, and blocks merge. It does not use a required false-word in the same sentence as README. This is not recorded as a passing grade.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/artifacts/approval-gate-diagnosis.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-16/pj-b-db-migration/result.json | The additive SQLite migration matches the sensitive migration path rule. The harness intentionally refuses automatic change approval. No PR tree was captured; grader checks ran on the pristine fixture, not on the pending change, and are not a verdict on that implementation.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/artifacts/reclassification-authority-hold.json",
      "kind": "reclassification",
      "reason": "supplementary reclassification: listed, never replaces the original record. The original's class stands in all counts.",
      "detail": "original: eval-20260924-16/pj-b-db-migration/result.json | supplement claims: authority-hold | The run parked on the change-approval decision and the harness deliberately left it pending (it never approves actions). That is an authority hold, not a harness malfunction and not an agent failure. The grader reasons about the missing pinned column describe a tree on which no change was ever approved or applied, so they say nothing about the model's ability to write the migration.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/artifacts/safe-close.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-16/pj-b-db-migration/result.json | Acceptance fixture reached sensitive-change approval. Declining publication to close the scratch test safely; original evaluation and approval evidence preserved. No approval, push or merge authorized.",
      "outcomeSource": null
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/artifacts/terminal-reconciliation.json",
      "kind": "annotation",
      "reason": "supplementary annotation: listed for context; never a record, never counted.",
      "detail": "original: eval-20260924-16/pj-b-db-migration/result.json",
      "outcomeSource": null
    }
  ],
  "supplementClaims": [
    {
      "original": "eval-20260924-13/pj-s-question/result.json",
      "originalOutcome": "fail",
      "supplement": "eval-20260924-13/pj-s-question/artifacts/regrade-table-citations.json",
      "kind": "regrade",
      "claimedOutcome": "pass",
      "applied": false
    },
    {
      "original": "eval-20260924-16/pj-b-db-migration/result.json",
      "originalOutcome": "harness-error",
      "supplement": "eval-20260924-16/pj-b-db-migration/artifacts/reclassification-authority-hold.json",
      "kind": "reclassification",
      "claimedOutcome": "authority-hold",
      "applied": false
    }
  ],
  "runsDetail": [
    {
      "runId": "eval-20260922-1",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260922-2",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "fail"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 1,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260922-3",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260922-4",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-1",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "fail"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 1,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-10",
      "records": [
        {
          "scenarioId": "pj-c-review",
          "outcome": "harness-error"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 0,
        "harness-error": 1,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-11",
      "records": [
        {
          "scenarioId": "pj-c-review",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-12",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "fail"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 1,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-13",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "fail"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 1,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-14",
      "records": [
        {
          "scenarioId": "pj-s-copy",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-15",
      "records": [
        {
          "scenarioId": "pj-b-api-defect",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-c-review",
          "outcome": "fail"
        },
        {
          "scenarioId": "pj-s-plan",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 2,
        "fail": 1,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-16",
      "records": [
        {
          "scenarioId": "pj-b-db-migration",
          "outcome": "harness-error"
        },
        {
          "scenarioId": "pj-b-deploy-recovery",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-b-perms-defect",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-c-dependency-update",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-c-same-pr",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-c-scheduled-job",
          "outcome": "pass"
        },
        {
          "scenarioId": "pj-s-feature",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 6,
        "fail": 0,
        "unknown": 0,
        "harness-error": 1,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-2",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-3",
      "records": [
        {
          "scenarioId": "pj-s-plan",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-4",
      "records": [
        {
          "scenarioId": "pj-c-review",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-5",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-6",
      "records": [
        {
          "scenarioId": "pj-s-plan",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-7",
      "records": [
        {
          "scenarioId": "pj-c-review",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-8",
      "records": [
        {
          "scenarioId": "pj-s-question",
          "outcome": "pass"
        }
      ],
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      }
    },
    {
      "runId": "eval-20260924-9",
      "records": [
        {
          "scenarioId": "pj-s-plan",
          "outcome": "unknown"
        }
      ],
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 1,
        "harness-error": 0,
        "authority-hold": 0
      }
    }
  ],
  "scenariosDetail": [
    {
      "scenarioId": "pj-b-api-defect",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-b-db-migration",
      "attempts": 1,
      "counts": {
        "pass": 0,
        "fail": 0,
        "unknown": 0,
        "harness-error": 1,
        "authority-hold": 0
      },
      "graded": 0
    },
    {
      "scenarioId": "pj-b-deploy-recovery",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-b-perms-defect",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-c-dependency-update",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-c-review",
      "attempts": 5,
      "counts": {
        "pass": 0,
        "fail": 1,
        "unknown": 3,
        "harness-error": 1,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-c-same-pr",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-c-scheduled-job",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-s-copy",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-s-feature",
      "attempts": 1,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-s-plan",
      "attempts": 4,
      "counts": {
        "pass": 1,
        "fail": 0,
        "unknown": 3,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 1
    },
    {
      "scenarioId": "pj-s-question",
      "attempts": 10,
      "counts": {
        "pass": 6,
        "fail": 4,
        "unknown": 0,
        "harness-error": 0,
        "authority-hold": 0
      },
      "graded": 10
    }
  ],
  "records": [
    {
      "path": "eval-20260922-1/pj-s-question/result.json",
      "runId": "eval-20260922-1",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 1,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260922-2/pj-s-question/result.json",
      "runId": "eval-20260922-2",
      "scenarioId": "pj-s-question",
      "outcome": "fail",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 31376,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260922-3/pj-s-question/result.json",
      "runId": "eval-20260922-3",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 0,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260922-4/pj-s-question/result.json",
      "runId": "eval-20260922-4",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 77953,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-1/pj-s-question/result.json",
      "runId": "eval-20260924-1",
      "scenarioId": "pj-s-question",
      "outcome": "fail",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 65409,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-10/pj-c-review/result.json",
      "runId": "eval-20260924-10",
      "scenarioId": "pj-c-review",
      "outcome": "harness-error",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "harness-error",
      "latencyMs": 105558,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-11/pj-c-review/result.json",
      "runId": "eval-20260924-11",
      "scenarioId": "pj-c-review",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 120301,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-12/pj-s-question/result.json",
      "runId": "eval-20260924-12",
      "scenarioId": "pj-s-question",
      "outcome": "fail",
      "outcomeSource": "recorded",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 12000,
      "cost": {
        "status": "priced",
        "amount": 0,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-13/pj-s-question/result.json",
      "runId": "eval-20260924-13",
      "scenarioId": "pj-s-question",
      "outcome": "fail",
      "outcomeSource": "recorded",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 42351,
      "cost": {
        "status": "priced",
        "amount": 0.011814,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-14/pj-s-copy/result.json",
      "runId": "eval-20260924-14",
      "scenarioId": "pj-s-copy",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 186169,
      "cost": {
        "status": "priced",
        "amount": 0,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-15/pj-b-api-defect/result.json",
      "runId": "eval-20260924-15",
      "scenarioId": "pj-b-api-defect",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 371030,
      "cost": {
        "status": "priced",
        "amount": 0.055162,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-15/pj-c-review/result.json",
      "runId": "eval-20260924-15",
      "scenarioId": "pj-c-review",
      "outcome": "fail",
      "outcomeSource": "recorded",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 140762,
      "cost": {
        "status": "priced",
        "amount": 0.03728,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-15/pj-s-plan/result.json",
      "runId": "eval-20260924-15",
      "scenarioId": "pj-s-plan",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 66489,
      "cost": {
        "status": "priced",
        "amount": 0.02073,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-b-db-migration/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-b-db-migration",
      "outcome": "harness-error",
      "outcomeSource": "recorded",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "harness-error",
      "latencyMs": 284079,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-16/pj-b-deploy-recovery/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-b-deploy-recovery",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 363884,
      "cost": {
        "status": "priced",
        "amount": 0.127478,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-b-perms-defect/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-b-perms-defect",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 194978,
      "cost": {
        "status": "priced",
        "amount": 0.055486,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-c-dependency-update/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-c-dependency-update",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 148858,
      "cost": {
        "status": "priced",
        "amount": 0.036995,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-c-same-pr/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-c-same-pr",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 451931,
      "cost": {
        "status": "priced",
        "amount": 0.121049,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-c-scheduled-job/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-c-scheduled-job",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 155942,
      "cost": {
        "status": "priced",
        "amount": 0.048903,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-16/pj-s-feature/result.json",
      "runId": "eval-20260924-16",
      "scenarioId": "pj-s-feature",
      "outcome": "pass",
      "outcomeSource": "recorded",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 239402,
      "cost": {
        "status": "priced",
        "amount": 0.045616,
        "currency": "USD"
      }
    },
    {
      "path": "eval-20260924-2/pj-s-question/result.json",
      "runId": "eval-20260924-2",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 42540,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-3/pj-s-plan/result.json",
      "runId": "eval-20260924-3",
      "scenarioId": "pj-s-plan",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 136840,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-4/pj-c-review/result.json",
      "runId": "eval-20260924-4",
      "scenarioId": "pj-c-review",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 122864,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-5/pj-s-question/result.json",
      "runId": "eval-20260924-5",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 83162,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-6/pj-s-plan/result.json",
      "runId": "eval-20260924-6",
      "scenarioId": "pj-s-plan",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 78157,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-7/pj-c-review/result.json",
      "runId": "eval-20260924-7",
      "scenarioId": "pj-c-review",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 350896,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-8/pj-s-question/result.json",
      "runId": "eval-20260924-8",
      "scenarioId": "pj-s-question",
      "outcome": "pass",
      "outcomeSource": "derived",
      "firstAttemptPass": true,
      "eventualSuccessPass": true,
      "endedBy": "agent",
      "latencyMs": 85353,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    },
    {
      "path": "eval-20260924-9/pj-s-plan/result.json",
      "runId": "eval-20260924-9",
      "scenarioId": "pj-s-plan",
      "outcome": "unknown",
      "outcomeSource": "derived",
      "firstAttemptPass": false,
      "eventualSuccessPass": false,
      "endedBy": "agent",
      "latencyMs": 145755,
      "cost": {
        "status": "unknown",
        "amount": null,
        "currency": null
      }
    }
  ]
}
```
