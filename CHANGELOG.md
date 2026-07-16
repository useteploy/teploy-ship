# Changelog

All notable changes to Teploy Ship are recorded here.

## v0.1.0 — 2026-07-15

First public release.

### What Ship is

A self-hosted coding agent: point it at a task and it plans, edits, runs, and reviews in a real workspace. Acts by writing and running code (the CodeAct strategy) rather than emitting structured tool-call JSON — each turn it thinks, runs one fenced Bash or Python block in a sandbox, observes the real output, and iterates. Self-host the dashboard and worker, bring your own model keys, and keep your code on your own infrastructure.

### Core loop

- CodeAct execution: think → act (one code block) → observe → repeat, against a persistent kernel that keeps variables alive across turns within a run.
- Durable runs: workflow state survives restarts and crashes; a run can park on an approval gate and resume exactly where it left off, without repeating completed model calls or shell commands.
- Configurable approval policy: live runs prompt on dangerous actions by default; durable runs park for review. Destructive/network/privilege-affecting actions are the ones gated.
- Loop and thrashing detection: repeated identical actions or repeated failures trigger a nudge, then an escalation to abort rather than burning an unbounded number of turns.
- Recovery and memory: oversized histories condense the middle turn range and keep the head + recent context; per-repo notes and a playbook (`SHIP.md`, `.ship/playbook.md`, or `AGENTS.md`/`CLAUDE.md`) persist lessons across runs on the same repo.

### Task intake

- Signed GitHub and Forgejo issue webhooks propose tasks from a `ship`-labeled issue; a follow-up `issue_comment` on an open PR proposes a review/steer task on the same run.
- Slack and Linear intake: an `@ship` mention or a labeled Linear issue creates a task the same way; run notifications (parked, failed, PR opened) post back with a link to the run.
- A CI-failure webhook (`workflow_run`/`check_run`) on a `ship`-authored PR proposes an auto-fix task with the failure log attached, closing the review loop without a human re-triggering it.
- Every automated launch path is bounded by daily launch count, concurrency, and per-source spend caps; a policy-read failure fails closed (no launch) rather than open.

### Repository work

- For repository tasks, Ship works from a `ship/run-<id>` branch, commits as it goes, and opens a pull request once its diff is non-empty — never force-pushes, never touches `main` directly.
- Per-repo codebase indexing: a repo run refreshes a chunked, embedded index of the codebase into Nucleus vector storage after clone, and the agent gets a `search` action to query it mid-run.
- Plan preview (opt-in per run) and mid-run steering: a run can pause for plan review before touching anything, and a dashboard operator can inject guidance into a running or parked run.

### Model and infrastructure

- Configurable model routing: Anthropic or OpenAI directly, or any OpenAI-compatible gateway (self-hosted or otherwise) — you choose the endpoint and hold the credentials.
- Sandboxed execution via `teploy-sandbox`, with a default-deny egress policy — a run can reach its git host, its model gateway, and package registries, and nothing else.
- Prompt-injection mitigations: untrusted issue/PR/repo content is framed explicitly as data, not instructions; a guardrail pass flags injection-shaped content in the run timeline; the approval gate stays in front of network/push actions regardless of what repo content says.
- Secrets are scoped per run source rather than dumped wholesale into the sandbox environment.
- Runs, spend, and audit-relevant events can forward to a self-hosted Teploy Observe instance.

### Self-hosting

- One `teploy deploy` brings up the dashboard, the worker, and a Nucleus store as a Teploy app — see [docs/DEPLOY.md](docs/DEPLOY.md) for webhook wiring, the sandbox, embeddings activation, and the full security model.
- Ships as a multi-arch (`amd64`/`arm64`) GHCR image (`ghcr.io/useteploy/teploy-ship`), built from source with no dependency on any unpublished package — `pnpm install && pnpm run build` works from a clean clone.

### Known gaps

- Multi-user auth/RBAC, SSO, and an IDE integration are deliberately deferred — see the project roadmap for the reasoning. Single-token auth is the current model; fine for solo/small self-hosting, not yet a team product.
