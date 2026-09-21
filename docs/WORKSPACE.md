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

**Verify environment with a real run** launches a scan through the normal
model/budget/approval path. Ship independently executes the configured test
command and records it as Environment tests; the agent inspects the environment
and reports problems. No test command means disabled, never passed. The scan
cannot publish changes. Preparation commands may install dependencies or start
services, but Ship does not automatically provision arbitrary databases/secrets.

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
