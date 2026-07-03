# teploy-agent

Teploy's autonomous coding agent — a **CodeAct brain** built entirely on
the Neutron primitives. *(Working name; the product's real name is a
deliberately-open item.)*

The agent acts by writing code, not by emitting structured tool-call
JSON: each turn it thinks, then runs one fenced code block (bash or
Python) in a sandbox, observes the real output, and iterates until the
task is done. This is the CodeAct strategy (per OpenHands' evidence),
implemented against Teploy's own stack rather than ported.

```sh
teploy-agent run "write fib.py that prints 8 Fibonacci numbers and run it"
# local workspace by default; --sandbox <url> --sandbox-token <t> for teploy-sandbox
```

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

## Status

M1–M2: the CodeAct loop (bash/python/finish, observation truncation, CLI,
full-stack validation against a live sandbox) and durability + action
approval (durable workflow, replay crash-recovery, approval parking, a
dangerous-command policy). Deliberately thin on the brain — the AI SDK
owns model calls, the executor owns compute, the Workflow SDK owns
durability. Next: a persistent execution kernel (Python variables across
actions), context/memory management for long runs, sandbox snapshots for
true multi-day durability, and the eval/recovery tuning that is the real
~30% of agent quality.

## Note

Depends on unpublished local `@neutron-build/*` packages via pnpm
`link:`. Publish those (or switch to workspace resolution) before
building this repo on another machine.
