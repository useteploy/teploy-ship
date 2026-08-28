# Scan mode — read-only runs that report findings

A scan run reads a repository and reports what is wrong with it. It opens no
pull request, pushes no branch, and writes nothing anyone has to review. Its
deliverable is a list of findings recorded on the run.

    POST /api/runs/scan
    Authorization: Bearer $SHIP_WEB_TOKEN
    Content-Type: application/json

    {"repo": "https://forge.example/tyler/teploy-cli"}

    202 {"run":"run-1a2b3c4d","mode":"scan","repo":"…","findings_url":"/api/runs/run-1a2b3c4d/findings"}

Read the result back when the run finishes:

    GET /api/runs/run-1a2b3c4d/findings

    200 {
      "run": "run-1a2b3c4d", "mode": "scan", "status": "completed",
      "collected": true, "found": true,
      "findings": [
        {
          "title": "database password hardcoded in the settings script",
          "severity": "high",
          "file": "scripts/settings.d/infra.sh",
          "line": 378,
          "detail": "POSTGRES_PASSWORD is assigned a literal and read by the container at boot, so the credential is in git history for every clone.",
          "fix": "read it from the environment and fail closed when unset"
        }
      ],
      "notes": []
    }

The same findings are on the run page under **Scan findings**.

## The finding shape

| field | required | notes |
|---|---|---|
| `title` | yes | one line naming the defect |
| `severity` | yes | `low` \| `med` \| `high`; anything unrecognised becomes `med` rather than losing the finding |
| `file` | yes | repo-relative path. **A finding without one is dropped** — an unlocated finding cannot be checked, cannot be deduplicated and cannot become a task |
| `detail` | yes | what is wrong and how the scan established it |
| `line` | no | 1-based, when the finding is about a specific one |
| `fix` | no | what to do about it |

At most 25 findings per scan; extras are dropped with the reason recorded in
`notes`. Duplicates (same file, same title) collapse. `notes` is worth reading:
a silently shortened findings list is how a scan lies by omission.

Three states a caller should tell apart:

- `collected: false` — the run has not reached its findings step (still running,
  or it failed first).
- `collected: true, found: false` — the run finished without emitting a findings
  array at all. This is a harness or model failure, not a clean repository.
- `collected: true, found: true, findings: []` — the scan looked and reported
  nothing. A real answer.

## What makes a scan safe

Not the prompt. On 2026-08-26 seven nightly scans ran under a prompt that asked
them not to change any tracked file; five pushed code anyway, including an
invented `nginx.conf`, a 385-line lockfile regeneration, and a doc comment
claiming input validation that was never implemented. Every one of those pull
requests had to be closed by hand.

So the enforcement is in the run, not in the request:

- **The publish gate does not run.** `publishIfRepoRun` returns on its first
  line for a scan (`src/durable.ts`), before any step — no commit, no push, no
  pull request, no forge API call, no test run, no change-class park. There is
  one guard and every call site goes through it, including the failure-path
  rescue.
- **Edits are refused in the loop.** ```edit and ```create never reach the
  executor; the agent gets an observation telling it to record what it would
  have changed as a finding's `fix`.
- **The remote is credential-free.** It has been since the clone
  (`setupRepo` in `src/git.ts`), so the agent could not push even if it tried.
- **The mode is on the recorded run input**, not read from config at execution
  time. That is what makes it a fact about the run rather than a decision a
  worker makes while replaying one — and it is required for replay safety in
  both directions, because scan mode both adds a step (`scan-findings`) and
  removes several.

A scan also suppresses, at enqueue, every feature that is about a change:
`tests`, `testsFeedback`, `telemetry`, `preview`, `changeClass`, `requireEdit`,
`plan`, `critic` and multi-harness attempts. Asking for them on a scan is
ignored rather than honoured.

## Why the findings are not a file

The MVP asked the agent to write `.teploy-agent/findings.json`. That path is
refused by `validateActionPath` (`src/actions.ts:65`), git-excluded by
`setupRepo` (`src/git.ts:141`) and listed as never-publishable
(`src/publish-policy.ts:62`) — the only path excluded from a pull request was
also the only path the agent may not write. Three of the seven scans parked on
`cat > .teploy-agent/findings.json` waiting for an approval nobody gave.

Any other path in the tree has the opposite problem: a scan publishes nothing,
so a file written there is discarded with the sandbox.

Findings therefore come out of the agent's own finish block and are recorded as
a step. They are in the event log before the sandbox is disposed of, they
survive a replay without a round trip, and there is no path anywhere that can
refuse them.

## Scans from Akiroo

A room agent in Akiroo can ask a question of a repository (L7). It queues an
outbox row of kind `scan`, which the worker collects on the same pull as
`task` and `decision` rows:

    kind: "scan"
    payload: { "repo": "<https clone url>", "question": "<text, up to 4000 chars>",
               "ref": "room-scan:<id>", "model"?: "<id>" }

Ship checks the repo against the allowlist (external trust, like a task row)
and enqueues a `mode: "scan"` run with `source: "akiroo"`, the question as the
task, and `origin: { source: "akiroo", dedupeKey: "akiroo:<ref>", workItemRef:
<ref> }` on the recorded input. **No issue is opened** — a scan is a question,
not a work record, and a question does not need a durable row on the forge.

The row is acked whatever happened. A refusal (repo not allowed, malformed
payload, daily budget spent) is logged with the row id and nothing else; there
is no refusal webhook, because a refusal has no run id to sign a payload on.
Akiroo expires a scan nobody picked up after thirty minutes.

When the run settles, the signed run webhook carries `origin.work_item_ref =
room-scan:<id>`, `mode: "scan"` and a `findings` block — `{ found, findings,
errors, summary }`, where `summary` is the run's final write-up truncated to
8000 chars. The block is bounded so the whole payload stays under 64 KB:
finding `detail`/`fix` text is clipped, then trailing findings are dropped,
and either shortening is recorded in `errors`. The full list is always at
`/api/runs/<id>/findings`. See `docs/DEPLOY.md`, "Connecting Ship to Akiroo".

## Cost

Scans are budgeted like everything else, and — as of this change — the budget is
enforced when the run is **enqueued**, not only when the intake sweep launches
one. `POST /api/runs/scan` returns **429** with the source, the budget and the
committed total once the day's allowance is spent; a cron should treat that as
back-off, not as an error to retry.

Default source is `scan`, so scan spend is capped, reported and reasoned about
separately from ordinary work. Set a per-source cap on the Policies page, or
`SHIP_DAILY_BUDGET_USD` for the global default.

For reference, the seven unbounded prompt-only scans of 2026-08-26 cost $24.15
in one night — roughly $3.45 per repository — and produced nothing.
