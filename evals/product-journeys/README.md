# Product journey acceptance

Use `../product-fixtures/customer-directory` as the baseline of a private,
disposable repository. It has a browser form, HTTP API, SQLite persistence and
three baseline tests. It is a test fixture, not a production starter.

Exercise the actual Ship UI and worker, recording run IDs, repository revisions,
interventions and results. Start with these distinct outcomes:

1. Ask how adding a customer works. Independently check factual claims; a
   completed run or empty findings array is not a correctness grade.
2. Request a search plan and stop before implementation. Confirm no PR is opened.
3. Request only the button wording change from “Add contact” to “Save customer”.
   Approve its plan, inspect the actual PR diff, and run the grader below against
   a checkout of the PR's exact head. The diff must contain only that replacement.
4. Approve the verified scratch PR through Ship. Confirm the forge actually
   reports it merged; do not infer this from an accepted UI decision.
5. Request customer search from the merged default branch. Grade name/email
   matching, empty/no-match behavior, literal wildcards, preserved data, stale
   responses and saving under an active filter independently of agent-authored tests.
6. Seed a separate PR changing the search predicate from OR to AND. Verify it
   fails the independent grade, then request a read-only PR review. Check that
   findings identify the regression at the recorded head and leave it unchanged.
7. Request a same-PR correction. Grade the new exact head, verify the old review
   is visibly out of date, and distinguish an updated PR from a merged result.

The wording grader requires Python 3 and Playwright with Chromium installed:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  node evals/product-journeys/check-customer-directory.mjs /path/to/pr-checkout
```

An optional third argument sets the expected button text (`Add contact` grades
baseline behavior). Add `--search` after that label to also grade search API semantics, browser filtering/clearing, and delayed stale responses. The unchanged baseline fails this search grade, serving as a negative control. It starts the app on a dynamically assigned loopback port,
submits the form through Chromium, reloads the page, reads SQLite independently,
and checks two viewport widths and browser errors. Screenshots and the database
are retained under a reported temporary directory; `SHIP_EVAL_ARTIFACTS` can
select its parent. Run only trusted fixture revisions on the local machine.

Separately verify preparation/test receipts and configuration drift, approval
restrictions, timer deduplication and pause, worker restart behavior, PR revision
and fresh-head review. Keep mocked checks, local UI fixtures, real worker runs
and independent grades distinguishable. These scenarios do not establish
competitor parity, general app correctness, writable workspace support or a
verified production deployment/rollback loop.
