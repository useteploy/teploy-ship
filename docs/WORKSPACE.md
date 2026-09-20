# Working in Ship

Ship keeps the shared Teploy navigation, typography and colors. The run page
organizes each task into Conversation, Changes, Verification and Activity.

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
7. On a completed, failed or cancelled run, start a follow-up. It is a new,
   linked run with the previous request and result, governed by current project
   configuration and budgets. If the prior PR has not been recorded as merged
   or closed, the follow-up targets that PR. A forge-side closure may still
   prevent checkout; Ship does not claim that recorded PR status is live status.

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
attempts to attach them to the PR. Playwright needs its video encoder in the
sandbox; the example prompt falls back to screenshots in older images.
Forgejo supports the attachment API. GitHub does not expose an equivalent API
used by Ship: capture receipts survive in the event log, but no playable asset
is claimed when upload is unavailable or fails. Videos render only when an
attachment URL exists. Browser-flow success is distinct from video delivery.

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
| [Devin playbooks](https://docs.devin.ai/product-guides/creating-playbooks) | Shared editable workflows, review before launch | Templates are instructions; this does not add a general automation scheduler. |
| [Vorflux](https://vorflux.com/docs) | Project preparation, plan review, visible PR evidence and browser recordings | Setup reports actual checks; it does not claim autonomous provisioning of arbitrary application stacks. |
| [OpenHands](https://hub.openhands.dev/blog/new-in-agent-canvas-august-2026) | Keep the conversation, recorded changes and review outcome together | No OpenHands engine is embedded; Ship retains its own durable execution and harnesses. |
| [Sparkles](https://sparkles.dev/) | Simpler team task intake, reusable requests, visible progress and PR handoff | This does not add hosted infrastructure, a large connector marketplace, or new agent harnesses. |

Full interactive IDE/terminal/browser takeover, live forge synchronization,
arbitrary-stack environment provisioning, broader connector coverage and a
controlled head-to-head coding evaluation remain distinct work. No full product
parity claim is made by this usability pass.
