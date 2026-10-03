# Capability inventory — 2026-10-03

Evidence record for first-batch item 1 of the [programme](SHIP_RELEASE_PROGRAMME_2026-09-21.md), at origin/main `796066d`. It describes what the source and docs show, not measured quality. It was compiled by a read-only subagent sweep of the repository; the maintainer spot-checked the default model (`src/model-id.ts:13`), the native-only plan-review refusal (`src/runtime.ts:1271`, `src/harness-external.ts:475`), the steering gap below, and the recorded run-input fields. Everything else is unverified beyond that sweep. Line numbers drift; treat them as pointers.

## Models

- Default `zai/glm-5.3`. Precedence: `--model` > `SHIP_MODEL` > config file > default. Anthropic-wire prefixes (`anthropic/`, `zai/`, `zai-coding-plan/`) use the Anthropic client; everything else uses the OpenAI-compatible client, through `AI_GATEWAY_URL`/`AI_GATEWAY_KEY` when set.
- Priced: Anthropic, OpenAI, Gemini, DeepSeek and `glm-5.3`. Local prefixes (`ollama/`, `local/`, `lmstudio/`, …) are priced at zero (the hardware cost is not counted). Unknown hosted models are priced at the highest rate.
- Evidence: `glm-5.3` 35/50 on a seeded SWE-bench Lite subset with a bare configuration, not the product path; `glm-4.6` 18/50; `claude-haiku-4-5` 1/9 on a hand-picked set (5 produced no patch; prompts were tuned against GLM only); `claude-sonnet-5` 3/3 and 6/6 on small in-house suites ("saturated, low n"). No eval evidence for any OpenAI-shaped model, Gemini, DeepSeek, Opus or any local runtime.

## Harnesses

`HarnessAdapter` has `id`, `version`, `isolated` and `run()`. **There is no declared-capabilities structure**; capabilities below are inferred.

| | native | claude-code | opencode |
| --- | --- | --- | --- |
| Plan review | yes | refused | refused |
| Mid-run steering | yes | none (see below) | none (see below) |
| Approval parks | yes (snapshot/restore) | none; auto-approves in sandbox | none; auto-approves in sandbox |
| Recovery / stuck detection | yes | none found | none found |
| Accounting | step-level, priced | unpriced under OAuth token | unpriced when cost reported as 0 |

Pinned binaries: `@anthropic-ai/claude-code` 2.1.246, `opencode-ai` 1.18.23, baked into the sandbox image. Selection: `SHIP_HARNESS`, overridden by the project and by an explicit option; recorded as `{id, version}` on every run.

**Found and fixed in this batch:** every run records `steer: true` and the run page offered a steer box on that flag alone, but external adapters read only `prompt`. A note sent to an external-harness run was stored, reported as sent, and never read. The offer and the route now consult `src/harness-capabilities.ts`. Plan review had an explicit refusal; steering had none.

## Environments

Local (`LocalExecutor`, not isolated: strict approval policy, and externally-sourced tasks refuse to run there) or sandbox (`ExecutorProvider`: create/attach, snapshot/restore, writable-workspace lease). Network tiers none / allowlist (default) / open; tasks from outside are downgraded to a restricted network. Sandbox pool places on the least-loaded healthy host with a 30 s unhealthy cooldown; a placed run cannot move. Preparation is one per-project command (≤8000 chars, 1–900 s). Warm volumes are per-repo templates, repo non-PR runs only, degrading to cold. Previews fetch the exact commit into a revision-specific slot with CLI TTL. Preview network reach is an open item in `AUDIT_OPEN.md` (teploy-cli).

## Entry points

- CLI: run/runs/preflight/explain/enqueue/evidence/project/policy/audit/resume/approve/deny/answer/cancel/inbox/fix/join/worker/web/support/eval.
- Web pages: inbox/launch, runs, run detail, projects, policies, workflows, reviews, sources, knowledge, spend, fleet, attention, recovery, incidents, coordination, setup, settings, account. Unauthenticated: health and bulletin pages only. SSE events stream. HMAC webhooks: forgejo, github, linear, slack, observe. JSON: run scan/decide/promote/rollback-delivery/findings/workspace, policies, incidents intake, artifacts.
- Intake: forgejo/github (review events, failed CI on `ship/…` PRs), linear (needs `ship` label), slack (`repo:<url>` token), observe (alert → incident proposal), workflow schedules, team requests, Akiroo. Policy per source `ignore | propose | auto`, default off; dedupe key per task.
- Schedules: interval only (60–44,640 minutes), once per slot, **no catch-up after downtime**, not timezone-aware.
- Lifecycle API: `docs/HTTP_CLIENT.md`; explicitly dashboard-compatible endpoints, "not a versioned general SDK". `requestId` is the idempotency key.

## Authority

Action approval policy is heuristic (open item `teploy-ship-04`). Roles admin/editor/viewer; grants approve/auto/steer/policies, deny by default; the CLI is deliberately not gated by them. Auto windows and reviewers per source/repo. Project authority `propose | send | auto_trivial | auto_normal`, capped by the verification ladder. `requirePlanReview` is a floor a per-run flag cannot lower. Park events: `plan-approval`, `change-approval`, `approve-merge` (wire name Akiroo depends on). Publish gate blocks forbidden paths, secret patterns, symlinks, submodule pointers. Delivery records are fenced state machines (`proposed → approved → executing → confirmed | unknown | failed | held`), execution off without `SHIP_DELIVERY_DIR`.

## Stored records

Runs are an event log plus `RunMeta`; `run-started` carries the full recorded input. Task lineage is `parentRunId` and `taskRootRunId`. Launch intents and dispositions, intake claims (primary-key v2 table) and projects are described in `src/launch-journal.ts`, `src/intake.ts`, `src/projects.ts`; storage changes are rename-aside migrations, seven so far. **No persisted requirements, acceptance criteria or plan-version field exists** anywhere (run meta, run input, intake task, launch intent, project); the only trace is an operator-edit flag on a plan decision in the event log. `src/task-record.ts` (this batch) projects the contract from existing records without storing anything new.

## Gaps this inventory surfaces

- No declared harness capability contract (S13); only steering is now enforced from a table.
- External harnesses have no recovery, approvals or steering, and cost may be unpriced.
- Schedules have no catch-up, timezone or event triggers (S16).
- Model evidence is concentrated on GLM; nothing for OpenAI-shaped or local models (S13, S23).
- Requirements, acceptance criteria, waivers and plan versions are not stored (S03).
