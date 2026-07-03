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

## Status

M1: the CodeAct loop, action parsing, bash/python/finish action space,
observation truncation, a CLI, and full-stack validation. Deliberately
thin — the AI SDK owns model calls and the executor owns compute. Next:
durability (wrap runs in `@neutron-build/workflow` so long tasks survive
restarts and approvals park for free), a persistent execution kernel,
context/memory management for long runs, and the eval/recovery tuning
that is the real ~30% of agent quality.

## Note

Depends on unpublished local `@neutron-build/*` packages via pnpm
`link:`. Publish those (or switch to workspace resolution) before
building this repo on another machine.
