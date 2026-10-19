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

- **Ordinary runs.** A child is an ordinary durable run — since the 2026-10-17
  live finding, an ordinary **SCAN** run, read-only by construction (below).
  It carries `parentRunId` (conversation lineage, `task-session.ts`) and
  therefore the parent's `taskRootRunId`, so it appears in the thread-chain
  API for free (`web/src/lib/thread-chain.server.ts` admits any run whose
  recorded `taskRootRunId` is the chain's anchor — verified, no web change
  made).
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
  (`SHIP_DELEGATE` — on unless explicitly turned off since 2026-10-18 —
  materialised at enqueue, suppressed on
  scans — a scan holds no publish authority to hand down).
- `repo=` and `path=` are scope HINTS, not authority: `repo=` is accepted only
  when it names exactly the parent's own repository (a workspace run cannot
  grant one at all); `path=` is prepended to the child's task text as a scope
  hint. The model cannot pick a target the parent does not already own.

## Children are READ-ONLY (2026-10-17 live finding)

Production soak A4 (run-request-1032fa9d…): a change-journey parent delegated
two children, and each child — an ordinary change run with the parent's gates
copied — edited files, opened its OWN draft PR (#3, #4) and parked at
approve-merge, so the parent's delegate-wait blocked until a human approved
each child's merge; then the parent redid both files in a THIRD PR. Delegation
was switched off in production until this was fixed. The v1 semantics that
fix it:

- **A delegated child is ALWAYS a scan**, materialised at enqueue
  (`mode: "scan"` rides the child's recorded input; `enqueueRun` additionally
  forces scan for any `delegateChild` run — enforcement, never cooperation).
  A scan edits nothing (```edit/```create refused in the loop), pushes
  nothing, opens no pull request (its publish gate is disabled), and owes no
  plan review, change-class verdict or merge decision. The child's
  deliverable is the CONTEXT TRANSFER itself — findings, answers and proposed
  changes as patch text in its summary. **The parent stays the only writer
  and produces the single PR.**
- **A child never parks on a human decision.** The ask action is not offered
  (enqueue suppresses `ask` for children) and a stray ```ask block is refused
  BY NAME (`DELEGATE_CHILD_ASK_REFUSED`) in the loop; an approval-required
  action is denied automatically with the reason recorded
  (`DELEGATE_CHILD_APPROVAL_REFUSED`). Pure functions of the recorded input,
  so replay refuses identically.
- **The parent's wait is bounded** (`SHIP_DELEGATE_WAIT_MS`, default 30
  minutes): a child that never reaches a terminal event yields an honest
  "child did not finish" transfer (status `timeout`) instead of an infinite
  park. The bound is decided INSIDE the wait step, so the recorded result —
  never a recomputed clock — is what replay reads.

Replay safety: the child mode is materialised at ENQUEUE (it is part of the
child's input), the parent's step sequence and step names are unchanged (the
wait step's result gains the `timeout` variant on the same name, which
fingerprints do not hash), and flag-off stays byte-identical. The one
accepted exposure: a PRE-FIX child log that actually contains an ask or
approval park would now replay into a NondeterminismError — but the flag is
off in production precisely because those children (the soak's) misbehaved,
they are all terminal, and a terminal log is never re-executed.

## Gates: a child is never more privileged than its parent

The spawn reads the parent's RECORDED input and copies: `trust` (an external
parent spawns external children) and the declared network tier
(`sandboxNetwork`; the external-task downgrade in `sandboxOverridesOf` applies
to the child exactly as it did to the parent), plus the spend `source` so the
cap sees delegation without a second ledger. Nothing change-shaped is copied —
the `plan` flag is not (a child that cannot edit owes no plan review), and the
scan mode forces off change-class, the merge gate, auto-merge, requireEdit and
the suite ladder at the child's own enqueue. The child additionally carries
`delegateChild: true`, which (a) suppresses the delegate flag at enqueue even
under `SHIP_DELEGATE=1`, (b) makes the loop REFUSE a ```delegate block from a
child with a clear message — one level only, v1 — and (c) suppresses `ask`,
per the read-only rule above. A child that cannot proceed without an answer may end
with ```finish needs-input and the question as the body (DT4): the run
completes with `output.needsInput`, the parent's transfer has status
`needs-input`, and the parent's observation says what the child asked and
that it is not waiting. The child's ```ask stays refused and nothing parks; the
parent decides whether to answer by delegating again, ask its own operator, or
proceed.

## Bounds

- `SHIP_DELEGATE_MAX` (default 2, hard) children per TASK ROOT, counted from
  the root's delegation ledger — a config-store record (`SHIP_DELEGATION_<root>`)
  holding one entry per claimed child with its lineage (parent run, turn,
  child run id, task). Same-process claims serialise under `withFileLock`;
  cross-process, the deterministic child id plus the launch journal is the
  boundary, exactly coordination.ts's honesty note.
- `SHIP_DELEGATE_WAIT_MS` (default 30 minutes, ceiling 6 hours): how long the
  parent's wait may poll before recording the honest "child did not finish"
  transfer. 0 is honoured — one poll, then give up. Unset or garbage is the
  default; anything above the ceiling clamps to it.
- Child cost cap (DT3): with `SHIP_MAX_RUN_COST_USD` set, each child records
  `maxRunCostUSD` = min(per-run cap, parent cap minus the parent's spend so
  far, priced from its recorded steps inside the spawn step). The child's loop
  takes min(its worker's cap, that) — narrow only. A parent with nothing left
  is refused (`budget-insufficient`); a target the share cannot afford is
  refused by the policy's own budget check. Serial children of a parked parent
  bound a tree at about parentCap + N x childCap; parallel children or depth 2
  still need the reservation ledger (C8).
- Idempotency: an entry keyed (parentRunId, turn) makes a re-run delegate step
  (crash before the step recorded) REPUBLISH its own child rather than spawn a
  second — the step re-derives the same entry and the same derived run id.

## Delegate targets (DT2)

A parent may name WHERE its child runs: ```delegate target=<id>. The id is an
entry in an allowlist — `SHIP_DELEGATE_TARGETS` (deployment: id -> harness +
model) intersected with the project's optional `delegateTargets` — never a
free-form model string. The intersection is materialised into the parent's
input at enqueue (`delegateTargets`, offered in the prompt), and the spawn
re-checks it against today's lists, so an operator can only narrow a running
task. A target is a new destination for the task's data, so the spawn runs the
routing policy's data-class gate (`checkCandidate` in model-routing.ts, i.e.
`whyNot`: destination and retention first) whatever `SHIP_MODEL_ROUTING` is:
picking a child's model is a selection, not a mid-run switch, so it needs no
tool-call journal and no `fallbackOn` trigger. Fail closed, every refusal named
(`delegate-targets.ts` lists them): no policy file loaded refuses every target;
an external harness must run the model the deployment configures for it and
call its provider at the policy entry's destination host. The admitted child
records `delegateTarget` (the decision) and `model` (DT1: the native loop
resolves the adapter per run and prices on it), and a `selection` segment is
appended to `ship_model_segments`. Without `target=` nothing changes.

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
   output read off its log. A child that never terminates yields the honest
   `timeout` transfer (status `timeout`, our own statement that the child did
   not finish — decided inside the step, so replay returns the recorded
   transfer at the same poll). The parent's next turn receives it as an
   observation ("Delegated run <id> finished (completed): …" / "… timed out:
   …"), scrubbed and truncated like any command output. Replay returns the
   recorded transfer without touching the child — the child has its own log
   and is never re-run. (A scan child never opens a PR, so `pr` stays absent
   on children spawned after 2026-10-17; the field survives for pre-fix
   logs.)
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
