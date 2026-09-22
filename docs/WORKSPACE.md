# Working in Ship

Ship keeps the shared Teploy navigation, typography and colors. The run page
organizes each task into Conversation, Review, Changes, Verification, Files and Activity. Review keeps the
conversation and composer beside the evidence; live updates preserve typed drafts.

## Simple team requests

In the Inbox, choose a connected project and describe what you need in everyday
language. **Make a change**, **Ask a question**, **Make a plan**, and **Review
work** state the expected result. Questions, plans and reviews use scan mode;
Ship does not publish changes for those tasks. A plan is a deliverable you can
then discuss or turn into a separate change request. This differs from the
native harness's optional approval pause before implementation.

Editors can **Send for approval** without execution authority. These requests
stay proposed even on an automatic project; an authorized teammate must approve
and start them. Recent requests link to the launched task. Viewers can follow
work but cannot submit requests. The project supplies the environment, agent,
permissions and budget; teammates do not enter infrastructure settings.

Starter workflows include updating wording, understanding a feature and exploring
an idea. Drafts are retained in the current browser tab. Task pages summarize
what needs attention, fold execution metadata and older messages, and keep the
follow-up composer outside the scrolling history.

## A normal task

1. Open **Projects → Project setup**. Register the repository, choose an image
   or inherit the worker default, and specify tests or leave detection enabled.
   New projects propose incoming work and require a person to authorize merges.
   Registering an existing repository preserves its settings.
2. Read the setup checks. A configured image is not proof it can start; a
   successful storage ping is not proof Git credentials or model access work.
   Use the linked read-only review to verify the worker's execution path.
3. Choose a workflow from the Inbox or Projects. Built-in templates cover bug
   fixes, features, repository reviews, tests and dependency updates. People
   with the policies grant can create, edit and delete shared templates.
4. Review the prefilled instructions and repository, then launch. Workflow
   selection itself does not execute anything. Reviews use scan mode.
5. Open the run. Conversation shows recorded progress, delivered instructions,
   questions and decisions. New messages to a steerable run arrive at its next
   checkpoint; the pending indicator distinguishes queued from delivered.
6. Review Changes and Verification. Activity retains detailed command output
   and the recorded-step index.
7. On a completed, failed or cancelled run, start a follow-up. Earlier requests
   and results remain in the conversation (up to 20 runs of context). Choose
   the existing PR or current default branch. The worker checks PR state before
   launch, then checks again at checkout; a closed or merged PR requires the
   default-branch choice. This starts a fresh sandbox, with bounded conversation
   context and the PR branch’s code, not a resumed terminal or browser session.
8. While a PR task page is open, Ship requests worker refreshes at most every
   30 seconds (60 seconds after errors). **Refresh from forge** also reads the PR’s current head, reviews, commit statuses
   and GitHub check runs through the worker. The timestamp is explicit. A changed
   head warns that this run’s recorded verification belongs to an older commit.
   These reads never grant merge authority or substitute for verification gates.
9. **Files** reads tracked file names and committed content at the available
   sandbox’s HEAD. It is a bounded inspector, not an editor. Expired sandboxes
   report unavailability; uncommitted changes remain in recorded diff snapshots.

## Environment setup

Project setup can save a repeatable preparation command and timeout (up to
15 minutes). Every newly enqueued run records this configuration and runs it
inside the sandbox after checkout and before the agent. A failed command stops
execution with a recorded outcome. The same setup applies to additional attempts.
Existing runs keep their recorded configuration and step fingerprints.

**Verify environment** launches a deterministic check through the worker's
normal authorization and admission path. It clones the repository, runs saved
preparation and test commands, records the actual results, then releases the
sandbox. It makes no model calls and publishes no changes. Missing or failing
tests cannot produce a successful verification. Use a separate review request
when you want an agent to investigate a failure.

The setup-only behavior is recorded in new run inputs. Older environment checks
keep their original agent-backed behavior, and an older worker holds new checks
rather than accidentally running them as paid scans. Preparation commands may
install dependencies or start services, but Ship does not automatically
provision arbitrary databases or secrets.

## Scheduled workflows

Workflows supports hourly, daily and weekly schedules. Schedules copy the
selected template’s instructions; later template edits do not alter them.
Occurrences enter the Inbox through the normal deduplicated intake path.
Source/project policies decide whether they remain proposed or auto-launch,
with existing budgets, admission and auto windows. Read-only and plan-review
modes survive both manual and automatic launch. Pause/resume and recent scheduled
work are visible in the UI. Downtime coalesces missed intervals into one current
occurrence instead of a catch-up burst. This is interval scheduling, not cron or
a dependency-graph automation builder.

## Evidence, precisely

New published runs record a bounded diff snapshot inside the existing
`repo-push` result, alongside its commit SHA. No workflow step was added.
Older runs may have only intermediate critic/attempt snapshots, or none.
Snapshots retain their step name and time; the forge remains authoritative for
subsequent PR changes. Large snapshots are partial and marked accordingly.

Verification is derived from recorded outcomes, never an agent's assertion
that tests passed. Missing checks say **not recorded**. The page includes test
output, preview/PR links, screenshot attachments and short browser recordings.

A `.ship/flow.mjs` script may record WebM files into its output directory.
Ship collects up to two recordings smaller than 4 MiB each, hashes them and
stores them for authenticated review. Playwright needs its video encoder in the
sandbox; the example prompt falls back to screenshots in older images.
The worker stores PNG/WebM artifacts independently of the forge, keyed by
SHA-256. File deployments use the state directory; Nucleus deployments use a
separate chunked table with integrity-checked reads. Authenticated Ship routes
serve images and video byte ranges. Set SHIP_PUBLIC_URL for usable artifact
links in PR bodies; otherwise links are relative within Ship. If storage fails,
the Forgejo attachment path remains a fallback. No artifact retention deletion
is automatic in this version. Capture still requires a working encoder in the
sandbox; browser-flow success is distinct from video delivery.

## Settings

Account settings affect the current person; project overrides affect a
repository; deployment defaults configure the worker. Existing runs retain
materialized inputs. Connections offers bounded health checks against installed
service addresses, without forwarding credentials, following redirects or
performing model inference. These checks test the dashboard's network path,
not the worker's. Detailed deployment values remain read-only.

## Comparison used for this work

Checked against official product documentation on 2026-09-19. These are product
patterns and documented capabilities, not measured claims about coding quality.

| Reference | Pattern applied in Ship | Remaining distinction |
|---|---|---|
| [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools) | Conversation beside organized changes, verification and execution history; linked follow-ups | Ship does not embed a full IDE or offer direct remote terminal/browser takeover. |
| [Devin playbooks](https://docs.devin.ai/product-guides/creating-playbooks) | Shared editable workflows, review before launch | Templates support interval schedules through the existing intake policies; no general DAG builder. |
| [Vorflux](https://vorflux.com/docs) | Project preparation, plan review, visible PR evidence and browser recordings | Setup runs declared preparation commands and independent tests; arbitrary-stack provisioning still requires configuration. |
| [OpenHands](https://hub.openhands.dev/blog/new-in-agent-canvas-august-2026) | Keep the conversation, recorded changes and review outcome together | No OpenHands engine is embedded; Ship retains its own durable execution and harnesses. |
| [Sparkles](https://sparkles.dev/) | Simpler team task intake, reusable requests, visible progress and PR handoff | This does not add hosted infrastructure, a large connector marketplace, or new agent harnesses. |

Full interactive IDE/terminal/browser takeover, automatic merge reconciliation,
arbitrary-stack environment provisioning, broader connector coverage and a
controlled head-to-head coding evaluation remain distinct work. Live forge
reads refresh while the task page is open; they do not automatically merge or rewrite
recorded verification. No full product
parity claim is made by this usability pass.

At merge review, requesting changes starts a linked run on the open PR and
cancels the old pending merge decision without closing the PR. Read-only
investigations leave that decision pending. Both require the existing
approval and steering grants.

Plan approval currently requires the native harness. External adapters start
work immediately; launches that explicitly request unsupported plan approval
are rejected instead of silently skipping it. External scan prompts request
findings and verification results, with no edited-tree deliverable.

A repeatable read-only production browser check is available as
`scripts/workspace-browser-check.mjs`. Provide `SHIP_URL`, `SHIP_WEB_TOKEN` and
`SHIP_TEST_RUN`, with Playwright installed (or `PLAYWRIGHT_MODULE` pointing to
its entry module). It checks eighteen desktop/tablet/mobile pages, hydration,
live JSON and unsent-draft retention without launching or approving runs.

Environment verification records a fingerprint of project setup. Project setup
shows a verified receipt only when the matching run completed and independently
recorded passing environment tests and preparation (when configured). Changing
relevant project settings marks the receipt stale. This does not attest to later
worker credential, image or service changes; re-run verification after those.

New runs check restored snapshots for a valid Git checkout before the agent
continues, and check the origin for non-PR tasks. Fork PR identity remains the
forge resolver's responsibility. This guards missing/wrong checkouts; it does not
prove every uncommitted byte survived. Existing run inputs retain old behavior.

## Project identity compatibility

Projects currently use an owner/repository key with an explicit clone URL.
Requests must match that URL's origin, protocol and port. Ship refuses a second
forge's same-named repository instead of borrowing the first project's settings.
Multiple same-named repositories across forges are not supported yet.

If a legacy project reports an identity conflict, open Projects using its
owner/repository name and set its correct clone URL. Existing run histories
remain readable and parked runs retain their recorded inputs. Do not delete a
project to resolve a conflict without first checking its settings and references.

## Retrying a team request

Team requests submitted for approval keep a request ID with the browser draft.
A retry of unchanged content returns the original request, including one that
was dismissed. Editing the draft creates a new request ID. Direct “Start task”
and follow-up launch recovery are separate work; do not assume these have the
same retry guarantee yet. File-store deployments support one server process;
use Nucleus for a shared deployment.


## Proportionate planning

See [One task, proportionate workflow](ADAPTIVE_WORKFLOW.md). Small changes still
need scope, an approach and verification. Project settings can require the native
plan-approval checkpoint for all new change tasks, including follow-ups and
automations; a task cannot disable that requirement. Questions, plans and reviews
remain read-only intentions. Existing runs retain their recorded checkpoints.


## Retrying an interrupted launch

If starting a task loses its response, return to the Inbox and retry the saved
draft. Its submission identity is retained, so the retry opens the original
accepted run. Editing the draft starts a new request. Already completed runs
are not restarted by retrying their submission.

An approved intake request that has not produced a visible run appears under
“Starting or awaiting recovery”. An authorized teammate can retry its launch;
Ship keeps the original run identity. The worker automatically finishes
publication of durably accepted launches. A retry does not bypass project plan
requirements, and pending/unknown acceptance is not represented as completion.

Follow-up messages also retain their request ID, task type, target and plan
choice with the draft. Retrying an accepted follow-up returns its existing run;
changing the request creates a new ID. Reusing an ID with different content is
refused. Current launch authority is still required on every retry.

A change requested at merge review records its replacement intent durably. Ship
holds that decision for the specific revision and records cancellation before
scheduling the revision. The worker can resume this handoff after a crash. A
competing merge/revision that already owns the decision prevents the child from
starting; Ship reports that conflict instead of overriding it. Such conflicting
accepted intents remain held for operator diagnosis; automatic reassignment or
abandonment is not implemented. This is not an atomic transaction with the forge,
and does not resolve ambiguous external push/merge outcomes.

## Recovery and live inspection

The Inbox links to **Launch recovery** for people with current launch authority.
This lists accepted direct, intake and follow-up launches that have not finished
publication, including corrupt records and replacement-review parents. Pages are
bounded to 100 entries with a cursor. Retry publishes the original accepted
intent; it never creates a new task or overrides a competing review decision.
Permanent conflicts remain held for investigation. Unknown external push, merge,
deployment and notification outcomes still need their own reconciliation.

**Files → Inspect live changes** reads tracked edits against HEAD and untracked
file names from the latest recorded workspace, including a restored handle.
It does not read untracked contents or grant terminal/editor access. Output is
bounded and redacted, with partial results labelled. It is an observation while
the agent may still be writing, not a consistent checkpoint. Background PR reads
no longer replace the displayed inspection. The recovery disclosure shows
recorded snapshots/restores and repository validation without asserting that a
snapshot still exists or that warm-volume edits are recoverable.

## Preview revision and recovery boundaries

New pushed-change previews fetch the exact recorded commit into an isolated
Git ref and worktree. Concurrent builds cannot overwrite FETCH_HEAD or remove
one another's checkout. The preview slot includes a hash of branch and revision,
so a later revision gets a different slot. Verification shows the recorded commit
and image tag. An image tag is not an immutable image digest or a production
release receipt. Preview slots expire under the configured CLI TTL.

Regression recovery removes that revision's preview; it cannot roll back the
main app merely because a preview was deployed. Old recovery receipts without
an immutable preview identity are held for inspection in the legacy rollback
step. The production rollback helper requires an explicit retained version and
never falls back to the mutable “previous” release.

Still required for production promotion: independently bind the repository and
trusted deployment configuration to a destination; capture the exact artifact
digest, deployed version and retained recovery version; bind an approval to those
identities; reconcile uncertain CLI outcomes before retrying; verify the deployed
revision and health, then demonstrate recovery on a scratch target. The UI does
not yet offer production promotion or a writable workspace takeover.
