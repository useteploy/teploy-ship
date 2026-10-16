# Two-way steering — D2 (S03, S13) design note

Before D2, steering was one-way: an operator note was drained at the top of
each turn (`turn-N-steer`, `src/durable.ts`) and injected as "Operator
steering — adjust course accordingly: …". D2 adds three things on the
**native** loop, behind `SHIP_STEER_REPLY=on` (only `on`; default off;
materialised as `input.steerReply` at enqueue): the agent can reply, each
operator message carries a mode, and an operator can interrupt the action in
flight. claude-code and opencode still refuse steering
(`src/harness-capabilities.ts`); nothing here changes that.

## Decisions

**1. Replies are text in the think step, not a new action or step.** A
```` ```reply ```` block written *before* the turn's action block is the
agent's message into the operator's thread (`parseReply`, `src/actions.ts`).
It is not an `Action` — `parseAction` never returns it — so the action after
it runs as usual and a reply never ends the turn or parks the run. A turn
that is only a reply gets `REPLY_POSTED` as its observation and the loop goes
on (the turn is spent, like any action). A reply after the action block is
discarded with everything else there, the transcript rule `transcriptTurn`
already enforces. Clamped at 4000 characters.

Because the reply is read off the recorded `turn-N-think` result, it is
durable and replay-identical by construction: live, replay and the thread
view (`replyHistory`, `web/src/lib/thread-chain.server.ts`) all parse the same
bytes with the dialect the run's input recorded.

**2. Modes.** `steer` is today's behaviour and the default (an old client
that sends no mode gets exactly it). `queue` is held until the agent's next
**checkpoint**, defined as:

- the top of the turn after a turn in which the agent posted a reply (it has
  surfaced and said where it is), or
- the agent's next ```` ```finish ````: the waiting messages are delivered and
  the finish is held (`FINISH_HELD_FOR_OPERATOR`), so "when you are done,
  also …" is never dropped because the run ended first. Not on the last turn
  (a finish there is honoured unconditionally), and the hold never consumes
  one of the finish gates' own holds.

A queued message is therefore never applied at an ordinary turn boundary —
the negative control in `src/steer-reply.test.ts` pins that three turns of
work without a reply never see it.

**3. Interrupt** (S11 effect vocabulary). Safe points, each claimed under its
own key so a crash-and-rerun of the step re-derives the same answer:

| Where | When it lands | Effect recorded |
| --- | --- | --- |
| `i:<turn>` | top of a turn (nothing running) | `none` |
| `i:<turn>:before` | start of an executable action | `not-done` — the action never runs |
| `i:<turn>:during` | while a python kernel cell runs | cancelled via the kernel's cancel marker (a real SIGINT, wave-3 #38): `unknown` if it raised `KeyboardInterrupt`, `done` if it had already finished |
| `i:<turn>:during` | while a bash command or edit runs | **cannot be cancelled** (no abort in the executor contract): it runs to completion, `done` |
| `i:<turn>:finish` | at a ```` ```finish ```` | holds the finish, `none` |

The before/during protocol runs **inside** `turn-N-exec` (`runInterruptible`,
`src/steer-reply.ts`), so it adds no step; its record rides on the exec result
(`interrupt: { at, effect, notes, cancellable }`). The observation states the
effect in words, and the turn continues with the interruption as an
observation. The poller reads the store every 2 s while an action runs
(`interruptPollMs`).

**4. Impersonation.** Operator messages reach the agent only as user turns
the loop writes ("Operator steering", "Operator message (queued…)",
"Operator interrupt"). On steerReply runs, lines in untrusted observation
text (command output, search hits, look snapshots, a child's transfer) that
imitate those prefixes are re-framed `[tool output, not the operator] …`
(`fenceOperatorLines`), and the prompt says so. The thread view takes
operator notes only from steer/held step results and exec interrupt records,
and replies only from think steps — tool output can produce neither.

**5. Storage.** Plain notes stay in `ship_steer` / `<run>.jsonl`, untouched.
Queued messages and interrupts live in their own table, `ship_steer_held`
(created lazily like `ship_steer`; no migration) / `<run>.held.jsonl`, with
`claimHeld(run, kind, key)` following drain's stamp-then-read idempotency.
A run without the flag never reads the held side.

## Replay semantics

- New steps: `turn-N-held` (every turn, after `turn-N-steer`) and
  `turn-N-finish-held` (at a finish), both admitted by `input.steerReply`
  alone in `WORKFLOW_STEPS`. No pre-D2 input carries the field, so no
  in-flight fingerprint moves (`step-fingerprint.test.ts` pins this).
- Whether `turn-N-held` claims queued messages depends on `repliedLastTurn`,
  re-derived from the replayed think text; a replay asks the same question
  and returns the recorded result without touching the store.
- Store mutations happen inside the steps that record them; a crash between
  the claim and the commit re-claims the same rows under the same key.
- Flag off: the dialect has no `reply`, the prompt has no reply block, no held
  step runs, observations are not re-framed and the exec step calls
  `executeAction` exactly as before (pinned by the equivalence test).

## Surfaces

- Run page: on steerReply runs the composer gains a steer/queue radio
  (default steer) and an "Interrupt current action" button (empty interrupt
  allowed); pending held messages are listed. Flag-off runs render the
  original composer and the page payload carries no new key.
- Route: additive `mode` form field (`steer` | `queue`) and an `interrupt`
  intent; both refused with `STEER_REPLY_UNSUPPORTED_MESSAGE` on runs whose
  recorded input lacks `steerReply`. Same `steer` authority grant.
- Thread API (`SHIP_THREAD_VIEW=on`): notes gain optional `mode` and `effect`;
  runs gain `replies` only when the input admitted them. A flag-off thread
  serialises exactly as before.
- Conversation view: replies read as agent prose, held messages as yours.

## Out of scope / follow-ups

- **Cancelling a running bash command.** Needs an abort on the executor
  contract (`ExecOptions.signal` in `@neutron-build/agents`) and a daemon-side
  kill of the exec's process group, verified against the sandbox daemon; until
  then the honest answer is "ran to completion, effect done". The kernel
  cancel also issues a second exec concurrently with the blocked waiter —
  exercised on `LocalExecutor` in tests, not yet against the live daemon.
- Interrupting the model call itself (an interrupt during think lands at the
  next action's `before` point, or the next boundary).
- Steering through session resume for claude-code (D7) / opencode v2 (D6).
- Multi-participant ordering/conflict handling (S03), Slack thread steering
  (B4), versioned plans.
- A live soak: the flag earns its own one-run flip on the 2026-10-16 pattern
  (programme E5 wave 7).
