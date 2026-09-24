# Ship request-path acceptance sweep — 2026-09-24

Twelve scenarios attempted across the real Ship request path and private scratch repositories. This is a single-attempt functional sweep, not the repeated S02 baseline or recovery-probe sign-off.

Original outcomes: **9 pass, 2 fail, 1 harness-error**. The question’s original failure was a citation-table parser defect; its hash-linked supplementary regrade passes. The review remains a lexical failure. The migration’s harness-error is an intentional stop at sensitive-change approval, not an executed implementation failing its grader.

| Scenario | Original record | Interpretation |
| --- | --- | --- |
| pj-s-question | [fail](results/eval-20260924-13/pj-s-question/result.json) | Original fail; exact citations pass supplementary regrade |
| pj-s-plan | [pass](results/eval-20260924-15/pj-s-plan/result.json) | Pass |
| pj-s-copy | [pass](results/eval-20260924-14/pj-s-copy/result.json) | Pass; terminal cost reconciled separately |
| pj-s-feature | [pass](results/eval-20260924-16/pj-s-feature/result.json) | Pass; clarification declined without extra information |
| pj-b-api-defect | [pass](results/eval-20260924-15/pj-b-api-defect/result.json) | Pass |
| pj-b-perms-defect | [pass](results/eval-20260924-16/pj-b-perms-defect/result.json) | Pass |
| pj-b-db-migration | [harness-error](results/eval-20260924-16/pj-b-db-migration/result.json) | Approval gate reached; safely closed without publishing |
| pj-b-deploy-recovery | [pass](results/eval-20260924-16/pj-b-deploy-recovery/result.json) | Pass |
| pj-c-dependency-update | [pass](results/eval-20260924-16/pj-c-dependency-update/result.json) | Pass |
| pj-c-review | [fail](results/eval-20260924-15/pj-c-review/result.json) | Lexical fail; grading limitation documented |
| pj-c-same-pr | [pass](results/eval-20260924-16/pj-c-same-pr/result.json) | Pass |
| pj-c-scheduled-job | [pass](results/eval-20260924-16/pj-c-scheduled-job/result.json) | Pass |

## Boundaries and evidence

- Every ordinary change PR was captured and then denied/closed; no evaluation change was merged. The same-PR fixture intentionally moves its dedicated scratch main as part of setup.
- The migration run was reviewed after the harness stopped, then publication was declined. Terminal read-back confirms `change-rejected`, no `repo-push`, and completion; original grade remains unchanged. No new test approval was left for the owner.
- The question regrade, review limitation, copy-cost reconciliation and migration closure are separate artifacts beside their original records. They do not rewrite history.
- The contact-page run requested missing address details; the harness declined the clarification without supplying extra information. The resulting implementation still passed the independent checks.
- Original six waiting runs were excluded from all test decisions and their event histories remained identical.
- Production during the sweep: a057d03 for the early canaries, ae8f1bb for eval16. Shared-host builds and load contention make latency unsuitable for a controlled performance comparison.

## Still required

Repeated n=3 measurement, interruption/stale-approval/permissions probes, combined two-park live proof, a meaningful S18 producer/consumer fixture, and the final clean timed installation. The review grader’s lexical limitation and the migration’s human-approval path need explicit treatment before quoting a single headline success rate.
