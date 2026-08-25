# Teploy Ship

Teploy's autonomous coding agent — a **CodeAct brain** built entirely on
the Neutron primitives. Self-hosted AI dev team: issues in, pull
requests out, on your own servers.

The agent acts by writing code, not by emitting structured tool-call
JSON: each turn it thinks, then runs one fenced code block (bash or
Python) in a sandbox, observes the real output, and iterates until the
task is done. This is the CodeAct strategy (per OpenHands' evidence),
implemented against Teploy's own stack rather than ported.

```sh
teploy-ship run "write fib.py that prints 8 Fibonacci numbers and run it"
# local workspace by default; --sandbox <url> --sandbox-token <t> for teploy-sandbox
```

## The CLI — teploy-ship

```sh
teploy-ship run "fix the failing test"      # live: streamed output, y/N prompts on dangerous actions
teploy-ship run --durable "big refactor"    # parks on approvals, survives exits and crashes
teploy-ship runs                            # list durable runs
teploy-ship approve run-1a2b3c4d            # approve a parked action — the run continues
teploy-ship deny run-1a2b3c4d "not in prod" # deny with a reason — the agent adapts
teploy-ship eval --suite hard --repeats 2   # the benchmark harness
```

Live runs stream thoughts (dim), actions (bold), and observations to the
terminal; the default approval policy flags destructive/network/privilege
actions for an interactive y/N (`--yes` or `--headless` for CI; `--json`
for machine output). Every run ends with a cache-aware token summary.

Durable runs execute as workflows over a file-backed event log
(`~/.local/state/teploy-ship`, override `TEPLOY_SHIP_STATE`): a parked
run holds zero processes; `approve`/`deny`/`resume` continue it in a new
invocation — replay skips completed work, so nothing re-runs. With
`--sandbox`, parks snapshot the workspace so the run survives container
TTLs too. Config defaults live in `~/.config/teploy-ship/config.json`
(model, sandboxUrl, sandboxToken, sandboxImage); set `AI_GATEWAY_URL` +
`AI_GATEWAY_KEY` to route all model calls through teploy-gateway.

## Self-hosting

**First time? [docs/QUICKSTART.md](docs/QUICKSTART.md)** — nothing to a pull
request that carries its test result, in about ten minutes, skipping everything
you do not need to see the loop work.

The full bring-up — dashboard + worker + Nucleus via one `teploy
deploy`, webhook wiring, the default-deny sandbox, embeddings, and the
security model — is in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

Upgrading a running install — including the one hazard specific to Ship, a
durable run enqueued under old code and replayed under new — is in
**[docs/UPGRADING.md](docs/UPGRADING.md)**. Read it before deploying a new
version with runs in flight.

## Models

Ship is model-agnostic by architecture — two adapter shapes,
Anthropic-compatible and OpenAI-compatible, direct or through a gateway
you run, with your credentials and no markup. It is validated and
prompt-tuned on GLM. Other families run; how well varies, and we publish
what we measured rather than what we assume.

**[docs/MODELS.md](docs/MODELS.md)** is the canonical statement: what the
routing seam actually guarantees, every model we have measured with its
sample size and confidence interval, and the one known cross-family
limitation. Read it before quoting a number from anywhere else.

## Preview deploys

Ship owns a deployer, so a run does not have to stop at the pull request. With
`SHIP_PREVIEW_DIR` set on the worker and `SHIP_PREVIEW=1`, a run that opens a PR
also builds that branch's image and puts it on a temporary URL, then comments
the link on the PR:

    teploy build --json                        # an image of THIS branch
    teploy preview deploy <branch> --ttl 24h --image <tag>

`SHIP_PREVIEW_DIR` must be a clone of the repository being fixed: Ship fetches
the run's branch into a detached worktree beside it and builds there, so the
preview serves the code in the pull request rather than whatever commit your
checkout is sitting on. Your checkout is never moved.

Both commands run **on the worker host**, never in the agent's sandbox: the CLI
holds the credentials that reach your servers, and the sandbox executes
model-authored commands. `teploy deploy` is never invoked — a preview must not
be able to reach production. A preview that fails is reported on the pull
request and never fails the run.

## A pull request that carries its evidence

When a run deploys a preview or reads telemetry, the results go into the pull
request **body** — the thing a reviewer reads first and merge automation
parses — as one Verification section between HTML markers:

    ## Verification

    Preview: https://preview-fix-login.example.com
    Running `api-build-abc1234`, expires 2026-08-21T09:00:00Z.

    | api | before | after |
    |---|---|---|
    | requests | 1000 | 900 |
    | errors | 50 (5.00%) | 9 (1.00%) |
    | p95 | 200ms | 150ms |

Pushing to the branch again replaces that section rather than adding a second
one, and anything written around it — including a reviewer's own notes — is
left alone. If the body cannot be read or updated, the section is posted as a
comment instead.

The tests line is produced by **Ship**, not the agent: with `SHIP_TESTS=1` and
`SHIP_TEST_COMMAND`, the suite runs in the workspace after the agent stops and
before the push, so "tests passed" describes the code that became the PR. An
agent's own account of its testing is exactly the claim the verified-finish gate
exists because models get it wrong.

A failing suite still publishes the pull request, marked, with its output — a
real fix alongside an unrelated red test is still worth a human's attention. A
suite that could not be *run* (missing command, dead container, timeout) is
reported as "not run", never as failed.

## Telemetry on the pull request

`SHIP_TELEMETRY=1`, plus `OBSERVE_URL`, `OBSERVE_READ_TOKEN` and
`OBSERVE_SERVICE` on the worker, and a run that opens a PR also reads the
affected service's RED metrics from Observe over two adjacent windows and posts
the comparison — requests, errors, error rate, p95, p99, Apdex.

The credential is an Observe **share token**: GET-only, pinned server-side to
its own site, revocable. Ship reads one aggregate endpoint and no trace
payloads.

**It refuses to report a verdict off thin traffic.** Below `OBSERVE_MIN_REQUESTS`
in either window the comment says "not enough data to compare" and shows the
raw counts instead. A preview environment serves almost nothing, so that is the
common case, and a confident percentage computed from nine requests would look
like proof while being noise. Where a comparison *is* reported, it is labelled
correlation — other deploys and traffic mix are not controlled for.

## The stack it stands on

| Layer | Provides |
|---|---|
| `@neutron-build/ai` | model calls (`generateText`), streaming, retries |
| `@neutron-build/agents` | the `AgentExecutor` contract — `LocalExecutor` (dev) or `SandboxExecutor` (teploy-sandbox daemon) |
| `teploy-sandbox` | isolated, disposable containers the agent works inside |

The whole path is validated end-to-end: brain → SandboxExecutor → live
sandbox daemon → real container → output fed back → agent finishes on
it.

## The loop (M1)

1. System prompt establishes the CodeAct protocol (one action/turn,
   observe before continuing, finish with a `finish` block).
2. `generateText` → the model's response (reasoning + one code block).
3. Parse the action; run bash directly or write Python to a file and run
   it (real tracebacks, persisted scripts).
4. Feed the observation (exit code, stdout, stderr, truncated) back.
5. Repeat until `finish`, the step budget, an abort, or an error.

Filesystem state persists between actions; process/Python-variable state
does not (a persistent kernel is a later milestone).

## Durable runs and approval gating

`durableAgent()` returns a `@neutron-build/workflow` workflow: every model
call and every command is a recorded step, so a crashed run replays
completed turns from the log and continues — no re-calling the model, no
re-running commands. Actions classified `"required"` (see
`defaultApprovalPolicy` — destructive/network/privilege commands) **park
the run** on an approval event; deliver `{ approved }` to
`approvalEvent(turn)` to resume. A human gate costs nothing while
pending.

```ts
import { durableAgent, defaultApprovalPolicy } from "teploy-ship";
const wf = durableAgent({ model, executor: sandboxProvider, approveAction: defaultApprovalPolicy });
// run it with @neutron-build/workflow's executeRun / Scheduler; a dangerous
// action → status "waiting"; deliverEvent(store, runId, approvalEvent(n), { approved: true }) resumes.
```

The live `runAgent()` loop takes the same `approveAction` policy with an
inline `onApprovalRequest` resolver.

**Honest limitation:** sandboxes have a TTL, so a run that parks longer
than its container lives finds it reaped on resume. True multi-day
durability of the sandbox *filesystem* needs snapshots (teploy-sandbox
M3); until then this gives crash-recovery within a run and approvals that
resolve within the container's lifetime.

## Team policies: authority, auto windows, required reviewers

Three rules make Ship usable by a team rather than one operator. All three
live in one store (`src/governance.ts`), edited on the dashboard's
**Policies** page, over `/api/policies` (bearer token, JSON), or with
`teploy-ship policy …`. Per-source ignore/propose/auto and budgets stay on
**Sources**.

**Authority** — which roles and which named users may `approve` (decide a
parked run, launch a proposed task, start a run), set a source to `auto`,
`steer` or cancel a run, or change `policies`. Deny by default: a role not
named in a grant is refused, and an unknown role string is a viewer. The
defaults reproduce the plain RBAC contract (editor approves and steers,
admin sets auto and edits policy); narrow or widen per action, or name a
single user regardless of role. Enforced server-side on every dashboard
mutation and API route, not in the UI. The CLI is not gated — a shell on
the worker holds the state directory and every credential already.

```
teploy-ship policy authority approve --roles admin --users release-bot
```

**Auto windows** — outside its window an `auto` source behaves as
`propose`: the task waits in the Inbox instead of launching unattended at
03:00. One window for all sources (`*`) or one per source; wall clock in
the zone given, so DST is the zone's problem; `end` before `start` runs
overnight. The worker checks the window at every sweep and claims nothing
outside it. Nothing about a window is read at execution time, so it is
recorded on the run's metadata rather than its input.

```
teploy-ship policy window set --days mon-fri --start 09:00 --end 18:00 --tz Europe/Berlin
teploy-ship policy window check --source forgejo
```

**Required reviewers** — per repository (owner/name, the same key the
evidence store uses), the reviewers and teams every pull request Ship opens
there must request. Resolved at **enqueue** and copied into the run input,
because it adds a recorded step (`repo-reviewers`) and a replay must request
the reviewers the log was written under. Forgejo and GitHub take the same
call; a request the forge refuses (not a collaborator, no such team) is the
step's recorded outcome and the pull request still opens.

```
teploy-ship policy reviewers set owner/name --users alice,bob --teams core
```

## Recovery and memory (agent quality infrastructure)

Two of the levers that make an agent actually finish tasks — built as
tunable, testable machinery (patterns informed by OpenHands):

- **Stuck detection** (`recovery.ts`): repeated-identical-action loops and
  consecutive-failure thrashing are detected; the agent is nudged to
  change course, and a run that keeps looping past `maxNudges` aborts
  rather than burning the whole step budget.
- **Context condensation** (`memory.ts`): when the conversation outgrows a
  char budget, the middle turns are summarized (via an injected
  summarizer — an LLM call in production) while the system prompt, the
  task, and recent turns stay verbatim. Keeps long runs inside the
  model's window.

Both are wired into `runAgent` (`recovery` / `condense` options, or
`false` to disable) and are the substrate future tuning adjusts.

## Evals — making quality measurable

The harness that turns tuning from guessing into measuring. A task
carries a prompt, optional workspace `setup`, and a **`verify`** that runs
*after* the agent stops and decides pass/fail on its own — the agent's
"finish" claim is never trusted, so an agent that says "done" without
doing the work scores FAIL.

```sh
teploy-ship eval --model anthropic/claude-sonnet-5 --repeats 3
```

```ts
import { runEval, checkCommand, builtinSuite } from "teploy-ship";
const report = await runEval({ tasks: builtinSuite, model, repeats: 3 });
// report.passRate, per-task PASS/FAIL, steps, duration
```

Each attempt runs in a fresh, isolated workspace; `repeats > 1` gives
pass@k. The `builtinSuite` is a tiny starter benchmark (fizzbuzz,
sum-file, fix-a-bug) whose checks are themselves tested (a correct
solution passes, a wrong one fails). This is where the remaining agent
quality gets closed: change a prompt or action, run the suite, keep what
moves the number.

**Honest status:** the machinery is built and tested with scripted
models; the actual pass rate requires running the suite against a real
model (API cost + time), which hasn't been done yet. The harness makes
that a measurement, not a guess.

## Optional: security scan gate (future, not core)

The same output-gating shape as eval `verify` can host an **opt-in security
scan** of the agent's diff/artifact before the result is accepted or merged —
so Ship is an agent whose output is security-checked when you want it. Pair an
AI heuristic pass (secrets, obvious injection/auth patterns, plain-English
findings) with deterministic scanners (Trivy/Grype/OSV-scanner) for CVE and
image coverage; treat it as a flag-or-block gate, not a silver bullet — LLMs
miss deep logic flaws. Concept salvaged from the archived `penscanai` idea.

## Status

M1–M4: the CodeAct loop, durability + action approval, recovery +
context condensation, and the eval harness + starter benchmark — all on
the Neutron/Teploy stack, all tested. Next: run the suite against a real
model for a baseline, then grow the benchmark and tune against it; a
persistent execution kernel, a structured file-editor action, and
sandbox snapshots.

