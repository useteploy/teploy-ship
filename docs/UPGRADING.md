# Upgrading Ship

Ship is self-hosted, so upgrading it is your operation, not ours. This document
is the procedure, the one hazard that is specific to Ship, and what rollback
can and cannot undo.

**The short version.** Web and worker ship in one image and move together, so
the classic split-version problem does not arise. Schema migrations are
**forward-only**. The real hazard is neither of those: it is a **durable run
that was enqueued under the old code and is replayed by a worker running the
new code**. Everything below is about making that safe.

---

## 1. Before you upgrade

- [ ] **Read the release notes for migrations.** Migrations are forward-only
      (`src/migrations.ts` has no `down` step and none is planned). A rollback
      returns the *code*, never the *schema*.
- [ ] **Check for in-flight runs**: `teploy-ship runs`. Anything not in a
      terminal state will be resumed by the new worker. See §3.
- [ ] **Back up the store if it is Nucleus.** Ship's entire history — every
      run's event log, which is also its audit record — lives there.
- [ ] **Note the current version**, so rollback has a target:
      `docker ps --format '{{.Names}}'` on the host shows `ship-web-<sha>`.

## 2. The upgrade

Ship is deployed as one teploy app with two processes:

```yaml
processes:
  web: web --store nucleus --port 7460
  worker: worker --store nucleus --interval 5
```

Both come from the same image, so `teploy deploy` replaces them together and
they are never at different versions. **This is the whole of the worker/web
version-skew policy**: there is no skew to manage, and you should not deploy
them as separate apps in order to create some.

```sh
# from a checkout of the release you want
pnpm run build && (cd web && pnpm run build)
teploy deploy
```

Migrations run at store connect (`runtime.ts:247`), so the first process up
brings the schema forward. A `setNX` lock with a TTL means exactly one process
across the fleet migrates; the others skip and proceed rather than waiting.

**The Nucleus engine is a separate concern.** It is a pinned accessory and it
does not move with a Ship deploy. Upgrade it deliberately and separately:

```sh
teploy accessory upgrade nucleus ghcr.io/neutron-build/nucleus:vX.Y.Z
```

Expect the engine to be unavailable while it replays its WAL — on a store with
~750k rows that has been observed at ~50 seconds, during which it reports
`health: starting` and **refuses connections**. The worker logs
`ECONNREFUSED` and `ENOTFOUND` through that window and recovers by itself.
Confirm recovery with `docker logs --since 30s`, not by reading the errors
still sitting in the buffer.

## 3. The hazard that is specific to Ship: in-flight durable runs

A durable run is an **event log that is replayed**, not a process that is
resumed. When a worker picks up an unfinished run, it re-executes the workflow
function and matches each `ctx.step` against the steps already recorded.

That means **a run enqueued under old code can be replayed by new code**, and
if the new code's step sequence differs from what the log contains, the replay
does not merely fail — `leftoverCursorEvent()` raises a `NondeterminismError`
which `executeRun` **throws rather than records**. The run becomes *permanently
unrunnable* rather than failed.

**Therefore, a change is safe to deploy with runs in flight if and only if it
does not alter the step sequence of a run already enqueued.** In practice:

| change | safe with runs in flight? |
|---|---|
| A new step gated on a **run-input** flag absent from old logs | **Yes** — old runs have no such flag, so the step never appears |
| A new step added **unconditionally** | **No** — old logs lack it |
| Renaming an existing step | **No** |
| Changing a **threshold that decides which turn a run terminates on**, when that threshold is read from config rather than from the recorded input | **No** — a tighter threshold returns early and leaves steps unconsumed |
| Anything outside the workflow function (web routes, docs, intake) | Yes |

This is why every optional feature — `recovery`, `settle`, `requireEdit`,
`preview`, `telemetry`, `tests`, `critic` — is **materialised into the run
input at enqueue** rather than read from worker config at execution time. It is
not a style choice; it is the mechanism that makes upgrades survivable. If you
add a feature, follow the same pattern (`runtime.ts`, `enqueueRun`).

**If you must ship a step-sequence change**, drain first:

```sh
teploy-ship runs                 # wait until nothing is mid-flight
teploy-ship cancel <run-id>      # or cancel what you are willing to lose
```

Cancelling settles a run at its next step; a cancelled run's work is not lost,
it simply stops.

## 4. Rollback

```sh
teploy rollback                  # returns the previous container and image
```

**What rollback restores:** the application code, both processes together.

**What it does not restore:**

- **The schema.** Migrations are forward-only. Rolling back to a version that
  predates a migration leaves the newer columns in place. That is usually
  harmless — the old code ignores them — but a migration that *rewrote* or
  *removed* data is not undone, and nothing will warn you.
- **Runs that have already replayed under the new code.** Their logs contain
  the new code's steps. Rolling the code back can make those logs
  unreplayable in the same way described in §3, with the direction reversed.

So the honest rule: **rollback is safe when the version you are leaving added
only additive migrations and no step-sequence changes.** When it did either,
rolling back is a restore-from-backup operation, not a `teploy rollback`.

## 5. A trap in the migration runner, worth knowing

`migrate()` decides whether a migration is needed by calling `m.needed(db)`, and
**a migration reported as not-needed is still written to the ledger as
applied**. That is correct when the probe is correct, and catastrophic when it
is not: the schema stays broken, the log says success, and the ledger then
blocks any corrected build from retrying.

This has happened once already. The probe used a `SELECT`, and **Nucleus
answers a `SELECT` of an unknown column with NULL rather than an error**, so all
three migrations reported themselves unnecessary and were recorded as applied
against a schema that had never been changed.

If you write a migration for a Nucleus-backed store, probe **write-shaped**:

```sql
UPDATE t SET c = c WHERE 1=0     -- errors on an unknown column; SELECT does not
```

`hasColumns()` in `src/migrations.ts` exists for exactly this and should be
preferred over hand-rolled probes.

## 6. Verifying an upgrade

```sh
curl -fsS localhost:7460/ -o /dev/null && echo "web ok"
docker logs ship-worker-<sha> --since 60s        # a clean tick, no store errors
teploy-ship runs                                  # in-flight runs progressing
```

A worker that cannot reach its store logs `tick failed (store unreachable?)`
and **fails closed on policy reads**, so it will not auto-launch anything while
degraded. That is by design: a worker unsure of its policy launches nothing.
