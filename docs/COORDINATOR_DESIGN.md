# The delegate coordinator — S20/S22 vertical slice (design note)

One paragraph, then the seams. A run may spawn bounded CHILD RUNS and consume
their results as first-class context, per the T3-reference row in
`docs/PERCEPTION_INPUT_S12_S13_2026-10-14.md` §4: *delegation results as
first-class CONTEXT TRANSFERS (transfer ids, status, merge-back into the
parent)*. This slice is deliberately minimal and honest: one action, one level
of delegation, one child per action, the existing admission, the existing
budget accounting, and nothing in `mission.ts` (which stays the pure validator
it is — a coordinator satisfying its contract is later work, not this).

## What exists and is reused rather than rebuilt

- **Ordinary runs.** A child is an ordinary durable run: its own log, its own
  parks, its own publish gate. It carries `parentRunId` (conversation lineage,
  `task-session.ts`) and therefore the parent's `taskRootRunId`, so it appears
  in the thread-chain API for free (`web/src/lib/thread-chain.server.ts`
  admits any run whose recorded `taskRootRunId` is the chain's anchor —
  verified, no web change made).
- **The ask/approval park machinery** (`durable.ts`): snapshot before the
  park, sleep-poll while children run, restore after. The engine buffers
  sleeps the same way it buffers delivered events, and the worker's drive loop
  (`worker.ts` `driveOne`) already wakes sleeping runs at their `wakeAt` —
  `completeSleep` before execution. No new wake source, no new sweep.
- **The launch idempotency pattern** (`coordination.ts`): deterministic child
  run ids derived from the task root and an index, a fenced claim record in
  the config store under `withFileLock`, and `enqueueRun`'s launch journal
  turning a retried enqueue into a republish rather than a second run.
- **Admission and spend.** A child is enqueued through `enqueueRun`, so it
  passes the daily budget check at admission, and because it inherits the
  parent's `source`, the worker's ordinary terminal settle lands its cost in
  the same (source, UTC-day) bucket the cap reads. The cap sees delegation
  without a second ledger. Concurrency rides the existing slots, host-load
  floor and per-repo serialization; a parked parent releases its repo lock
  (`driveOne`'s `finally`), so a same-repo child cannot deadlock behind it.

## The action

````text
```delegate path=src/foo
Make the foo parser accept RFC 3339 durations. Add tests.
```
````

- One new `Action` kind: `{ kind: "delegate"; task: string; repo?: string;
  path?: string }`. Parsed like `look`: dialect-gated, so a run whose input
  does not admit the action parses a ```delegate block as `none` — flag-off
  is byte-identical to a pre-feature run, the same equivalence `look` pins.
- Offered in the system prompt only when `input.delegate === true`
  (`SHIP_DELEGATE`, materialised at enqueue, default off, suppressed on
  scans — a scan holds no publish authority to hand down).
- `repo=` and `path=` are scope HINTS, not authority: `repo=` is accepted only
  when it names exactly the parent's own repository (a workspace run cannot
  grant one at all); `path=` is prepended to the child's task text as a scope
  hint. The model cannot pick a target the parent does not already own.

## Gates: a child is never more privileged than its parent

The spawn reads the parent's RECORDED input and copies: `trust` (an external
parent spawns external children), the declared network tier
(`sandboxNetwork`; the external-task downgrade in `sandboxOverridesOf` applies
to the child exactly as it did to the parent), and the `plan` flag (a parent
that owed plan review spawns children that owe it too — each run earns its own
approval; approval state itself is never inherited). The child additionally
carries `delegateChild: true`, which (a) suppresses the delegate flag at
enqueue even under `SHIP_DELEGATE=on`, and (b) makes the loop REFUSE a
```delegate block from a child with a clear message — one level only, v1.

## Bounds

- `SHIP_DELEGATE_MAX` (default 2, hard) children per TASK ROOT, counted from
  the root's delegation ledger — a config-store record (`SHIP_DELEGATION_<root>`)
  holding one entry per claimed child with its lineage (parent run, turn,
  child run id, task). Same-process claims serialise under `withFileLock`;
  cross-process, the deterministic child id plus the launch journal is the
  boundary, exactly coordination.ts's honesty note.
- Idempotency: an entry keyed (parentRunId, turn) makes a re-run delegate step
  (crash before the step recorded) REPUBLISH its own child rather than spawn a
  second — the step re-derives the same entry and the same derived run id.

## The park and the data plane

Inside the native loop, after the ```look branch:

1. `turn-N-delegate-spawn` (recorded step): claim + enqueue the child through
   a `DelegateControl`. The recorded result is the spawn outcome — the child
   run id, or a refusal (cap reached, enqueue refused) that reaches the model
   as an observation, never a step failure.
2. `turn-N-delegate-snapshot`, when the executor supports parks-by-snapshot
   (the ask machinery's `parkCanSnapshot`): the workspace survives the park.
3. `turn-N-delegate-wait` (recorded step, repeated): read the child's terminal
   state; `ctx.sleep` between reads parks the run — the worker's existing
   sleeping-run handling wakes it, releasing the slot and the repo lock for
   the child to use. The step is recorded each poll so replay re-derives the
   same iteration count; the child's log is terminal and immutable by the time
   any pass reads a transfer.
4. The wait step's final recorded result IS the CONTEXT TRANSFER —
   `{ childRunId, status, summary, pr? }`, the child's own run-completed
   output read off its log. The parent's next turn receives it as an
   observation ("Delegated run <id> finished (completed): …"), scrubbed and
   truncated like any command output. Replay returns the recorded transfer
   without touching the child — the child has its own log and is never re-run.
5. `turn-N-delegate-restore`: the ask park's restore half.

`livenessProbeTarget`'s name regexes grow the optional `-delegate` segment so
the C5 probe treats a mid-park parent as restore-pending rather than probing
the container the snapshot already superseded.

## Wiring without the dirty lane

`worker.ts` and `cli.ts` hold uncommitted work and are not touched by this
branch. The `DelegateControl` therefore rides TWO seams, both in files the
lane does not hold dirty:

- `DurableAgentConfig.delegate` — the explicit, test-facing seam (like
  `steer`, `codeSearch`).
- `runtime.ts`'s constructors — `fileRuntime()` / `nucleusRuntime()` build the
  one runtime a process has and register its control in a module-level slot
  (`delegate.ts`); the loop reads the slot only inside the delegate branch, so
  the read happens solely on runs whose input admits the action. The eventual
  one-line `delegate:` field in `worker.ts`'s `durableAgent({...})` config
  replaces the slot with explicit wiring when the lane lands; until then the
  product path works through the registration.

## Out of scope (v1)

Replanning, N-level trees, the ship MCP, cross-box orchestration, any UI
beyond what lineage already gives the thread view. A cancelled parent leaves
its children running (they are ordinary runs; cancelling them is the existing
cancel surface). File-mode `teploy-ship run` has no resident scheduler, so a
delegating run parked on its sleep needs the worker (nucleus) to be woken —
same class of limitation as any parked run there.
