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
teploy-agent run "write fib.py that prints 8 Fibonacci numbers and run it"
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
import { durableAgent, defaultApprovalPolicy } from "teploy-agent";
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
teploy-agent eval --model anthropic/claude-sonnet-5 --repeats 3
```

```ts
import { runEval, checkCommand, builtinSuite } from "teploy-agent";
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

## Note

Depends on unpublished local `@neutron-build/*` packages via pnpm
`link:`. Publish those (or switch to workspace resolution) before
building this repo on another machine.
