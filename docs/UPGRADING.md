# Upgrading Ship

Ship is self-hosted, so upgrading it is your operation, not ours. This document
is the procedure, the one hazard that is specific to Ship, and what rollback
can and cannot undo.

Web and worker share an image but can overlap during a rolling deployment.
Read the storage-format notes below before allowing mixed versions. Schema
migrations are **forward-only**. Another upgrade hazard is a **durable run
that was enqueued under the old code and is replayed by a worker running the
new code**. Everything below is about making that safe.

---

## 1. Before you upgrade

- [ ] **Read the release notes for migrations.** Migrations are forward-only
      (`src/migrations.ts` has no `down` step and none is planned). A rollback
      returns the *code*, never the *schema*.
- [ ] **Ask whether this build is safe to deploy right now**:
      `teploy-ship preflight`. It exits non-zero when an in-flight run's
      recorded step sequence differs from the build you are about to ship, so
      it belongs in the deploy script, not in your memory. See §3 and §3a.
- [ ] **Check for in-flight runs**: `teploy-ship runs`. Anything not in a
      terminal state will be resumed by the new worker. See §3.
- [ ] **Back up the store if it is Nucleus.** Ship's entire history — every
      run's event log, which is also its audit record — lives there.
- [ ] **Note the current version**, so rollback has a target:
      `docker ps --format '{{.Names}}'` on the host shows `ship-web-<sha>`.

## Deterministic setup verification

New Project setup checks record `environmentCheckOnly: true` and a setup-prefix
fingerprint. They run checkout, preparation and configured tests, then finish
without a model or publication. Existing environment-check runs retain their
recorded agent-backed path. An old worker sees a fingerprint mismatch for the
new path and holds it; deploy matching web and workers before inviting checks.
Completed check steps can replay to the final result after their sandbox has
been released. This proves recorded checks, not continued service availability.

## Repository identity storage

Projects now use the full clone URL (scheme, host, port and repository path) as
identity. Same-named repositories on different hosts can have separate policies.
Ambiguous short names are refused; use the full URL in links, API calls and CLI
commands. Connect URL-less legacy projects explicitly before launching new work.

The first project read imports `ship_projects` into `ship_projects_v2`, together
with a transaction marker. File stores snapshot `projects.json` into
`projects-v2.json` under a lock. The old source remains intact; v2 becomes
authoritative and deleted projects are never re-imported. Malformed unbound
legacy records remain inspectable/removable; new writes require valid names.

Stop all old web, worker and direct CLI project writers before the first import.
Take a consistent backup, restore it into an isolated engine, run
`scripts/check-project-identity.mjs` with `SHIP_ISOLATED_CHECK=1`, then check
restart persistence and parked-run preflight. Start matching new web/worker
images together. Old writers cannot see v2 changes. After accepting new project
edits, rollback requires reconciliation or a compatible build; restoring an
older snapshot would lose those edits. Retain both tables/files.

New runs record `repositoryScopeVersion: 2` for memory and index scope. Old
recorded inputs retain their prior keys and workflow steps. Historical results
and notes are attributed only when their original run proves the clone origin.
Unattributed notes remain in Knowledge. Historical spend buckets have no run ID,
so their missing origin components are not guessed; exact-origin cost-per-merge
is unavailable when matching legacy spend remains. New spend uses full URLs.
Use a full URL for global `OBSERVE_REPO`, or an explicit per-project service
mapping; new runs refuse ambiguous global mappings. Existing parked inputs keep
their recorded mapping.

## Intake primary-key storage

New Nucleus intake requests use `ship_tasks_v2`, whose task IDs have an enforced
primary key. IDs are derived from the deduplication key and generation, so a
paused writer and a retry cannot create separate tasks. Dismissed webhook tasks
can start a new generation; team request IDs remain consumed after dismissal.
The existing `ship_tasks` table is retained, read alongside the new table, and
updated in place for existing tasks. Run inputs and workflow steps do not change.

This requires a coordinated first rollout: stop all old web, worker and direct
CLI intake writers, take and rehearse the store backup, then start the new web
and workers together. Do not mix old intake writers with the new version.
Old binaries cannot see new-table requests. After accepting new requests,
rollback requires a compatible reader or an explicit data reconciliation;
restoring the earlier backup would discard later accepted work. Do not silently
restore it. Record the cutover and retain both tables.

`scripts/check-intake-concurrency.mjs` exercises paused insertion, simultaneous
claims, legacy records and concurrent reopening against an isolated engine.
It requires `SHIP_ISOLATED_CHECK=1` and an explicit `NUCLEUS_URL`; it creates and
removes only uniquely named proof records. Check restart persistence and parked
run preflight on a restored copy before the first production cutover.

## Revision launch coordination

Revision intents can carry `reviewParent`. The matching launch publisher must
claim that parent's merge decision for the child, record cancellation, then
publish the child. A durable `revision:<child-id>` decision token supports retry
without reopening merge approval. No recorded workflow input or step changes.

Stop old web and worker writers before enabling this build; an older worker
cannot honor the new intent prerequisite. Deploy the matching processes together,
using the backup/preflight procedure below. Do not downgrade with pending revision
intents or held revision decisions. Fix forward or explicitly reconcile them.
`scripts/check-revision-recovery.mjs seed` followed by an isolated engine restart
and `verify <printed-id>` checks persistence, competing claims and publication.
Never run the mutating proof against production.

## Durable launch acceptance

The launch journal adds `ship_launches`, `ship_launch_chunks` and
`ship_launch_commits`. Large immutable intents are chunked and checked against
their digest. SQL transactions publish metadata, scheduling and the commit
receipt together; start events are reconciled separately. Accepted pending
intents are repaired by the worker. Metadata uses a bounded display summary to
fit Nucleus inline rows; the complete request remains in the accepted intent and
event log. Do not mix old and new launch writers during
this first rollout: older binaries neither recover accepted pending intents nor
understand the new intake table. Stop/drain writers, back up, rehearse and start
matching web/worker builds. Pending intents and post-cutover requests must be
reconciled before any downgrade; restoring an old snapshot is not a lossless
rollback after new work has been accepted.

An interrupted intake claim without an accepted journal entry stays held and
appears in the Inbox. An authorized retry keeps its original run ID. Do not
manually reset claims or release budget holds while acceptance is uncertain.
`scripts/check-launch-recovery.mjs` exercises real-engine races and rollback;
`scripts/check-launch-restart.mjs` seeds an accepted intent and verifies it after
restarting an isolated engine. These scripts require explicit isolated-test
configuration and never start a model worker.

## 1b. Upgrading past the B5 release

Three behaviour changes land together. None touches an in-flight run — every
one of them is resolved at enqueue and materialised into the run input, so runs
already in the log replay exactly as they were recorded.

**Test commands are now detected.** A repo with no explicit `testCommand` used
to fall straight through to the worker's `SHIP_TEST_COMMAND`. It now gets a
command inferred from its own root (package.json `scripts.test`, a Makefile
`test:` target, `go.mod`, `Cargo.toml`, pytest config), and `SHIP_TEST_COMMAND`
becomes the last resort under that. **On a multi-repo worker this is what you
want** — one `go test ./...` was wrong for every repo but one. If you were
relying on the worker-wide command reaching a repo whose tree says something
else, set that repo's command explicitly on the Projects page (an explicit
entry always wins) or set `SHIP_TEST_DETECT=0`.

Detection makes a small number of read-only API calls to your forge at enqueue,
using the same credential and the same allowlist as a clone. An origin your
allowlist does not name is not contacted.

**Sandbox images now live in this repo.** If your worker's
`SHIP_SANDBOX_IMAGE` names an image you built by hand, it keeps working —
nothing renames or removes an image. To move onto the reproducible ones, run
`images/build.sh` **on the server** and point `SHIP_SANDBOX_IMAGE` at
`ship-sandbox-go:dev`. `build.sh` also tags `ship-sandbox-harness:dev`, which
is the name existing workers carry, so a rebuild under that tag is a drop-in
replacement. **It will move you from Go 1.24 to Go 1.25**, which is the point:
on 1.24 every Go pull request arrived marked `tests: failed`.

**Projects have a `harness` field.** Absent means "inherit `SHIP_HARNESS`",
which is what every existing record does, so nothing changes until you set one.
Setting it to `claude-code` or `opencode` requires the sandbox image that repo
boots to already carry the binary — build it with
`images/build.sh --harness <id>`. Nothing installs a harness at run time.

## 1c. Upgrading past the upgrade-fence release

The release that adds §3a changes one thing about the *first* deploy of it and
nothing about any later one.

`teploy-ship preflight` will refuse, reporting every run in flight as
`unrecorded`. That is correct: those runs were enqueued before the fence
existed, so their logs carry no fingerprint and nothing can be said about them.
Either wait for them to drain, or deploy with `--allow-unrecorded` after reading
§3's table yourself, as you would have had to before.

The **worker** does not hold those runs. A run with no recorded fingerprint is
executed exactly as it was before — the fence's own arrival must not be the
outage. From the next enqueue onward every run carries a fingerprint and
preflight answers properly.

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
teploy-ship preflight || exit 1      # §3a — refuses when a run in flight would be held
teploy deploy
```

Migrations run at store connect (`runtime.ts:247`), so the first process up
brings the schema forward. A `setNX` lock with a TTL means exactly one process
across the fleet migrates; the others skip and proceed rather than waiting.

**The Nucleus engine is a separate concern.** It is a pinned accessory and it
does not move with a Ship deploy. Upgrade it deliberately and separately:

Before a WAL-format upgrade, pause Ship's web and worker writers, stop Nucleus,
and archive its complete data directory. Verify the archive and rehearse the
upgrade on an isolated restored copy, without starting a worker against that
copy. Compare run histories and parked-run preflight results, then exercise
database writes. Update the accessory image pin in `teploy.yml` as well as the
running engine. Keep writers stopped during the live migration and verification.

**v1.1.1 upgrades the WAL to format v2 on first open.** Retain a full pre-upgrade
archive: the engine's `mvcc.wal.v1` copy can be retired on the next clean open.
Rollback requires restoring that archive with the previous matching image;
changing only the image tag is insufficient. Allow the migration to finish
without restart-looping. This release's startup banner still says v1.0.2, so
verify the deployed image rather than the banner.

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

**§3a is what stops that happening by accident.** A run now records a
fingerprint of its expected step sequence at enqueue, and a worker that does not
agree with it HOLDS the run instead of replaying it. The rest of this section is
still the model you need to reason with — the guard turns "permanently
unrunnable" into "paused; roll back or drain", which is the difference between
losing work and waiting.

**Therefore, a change is safe to deploy with runs in flight if and only if it
does not alter the step sequence of a run already enqueued.** In practice:

| change | safe with runs in flight? | what enforces it (§3a) |
|---|---|---|
| A new step gated on a **run-input** flag absent from old logs | **Yes** — old runs have no such flag, so the step never appears | The fingerprint's per-step gate. An old run does not admit the new step, so its print does not move and it is not held. |
| A new step added **unconditionally** | **No** — old logs lack it | **Fingerprint.** Every in-flight run's print moves; `preflight` exits 1 and the worker holds each run instead of breaking it. |
| Renaming an existing step | **No** | **Fingerprint**, same as above. |
| Reordering two steps | **No** | **Fingerprint** when the step's call site moves in the source; the **NondeterminismError backstop** when it does not (a swap of two helper invocations). |
| Changing a **threshold that decides which turn a run terminates on**, when that threshold is read from config rather than from the recorded input | **No** — a tighter threshold returns early and leaves steps unconsumed | Not the fingerprint: the step sequence is unchanged, so nothing static can see it. The **materialise-at-enqueue rule below** is what prevents it, and the **NondeterminismError backstop** is what catches it if the rule is broken. |
| Anything outside the workflow function (web routes, docs, intake) | Yes | Nothing needs to: the step sequence does not move, so no print changes and no run is held. |
| Editing a step's BODY, its comments, or its formatting | Yes | Same — the fingerprint is over step names and their order, never over the code inside them. |

This is why every optional feature — `recovery`, `settle`, `requireEdit`,
`preview`, `telemetry`, `tests`, `critic` — is **materialised into the run
input at enqueue** rather than read from worker config at execution time. It is
not a style choice; it is the mechanism that makes upgrades survivable. If you
add a feature, follow the same pattern (`runtime.ts`, `enqueueRun`).

**If you must ship a step-sequence change**, drain first:

```sh
teploy-ship preflight            # says which runs this build cannot replay
teploy-ship runs                 # wait until nothing is mid-flight
teploy-ship cancel <run-id>      # or cancel what you are willing to lose
```

Cancelling settles a run at its next step; a cancelled run's work is not lost,
it simply stops.

## 3a. What enforces §3

Until 2026-08-27 §3 was a rule you had to remember. Nothing stopped a deploy
mid-run, and a run whose sequence had moved simply threw on every tick with
nobody told. Three things enforce it now.

### The step-sequence fingerprint

At enqueue, a run records a **fingerprint of the step sequence its own input
admits** (`src/step-fingerprint.ts`). Before executing a run, the worker
recomputes that fingerprint under the running build. If the two differ the run
is **held** — parked as waiting, visible in the inbox, its log untouched —
rather than replayed into a `NondeterminismError`.

The fingerprint is the hash of the workflow's step names, **in source order,
filtered to the ones the run's recorded input admits**. That last clause is why
it is usable day to day: this codebase adds input-gated steps constantly, and a
fingerprint without gates would hold every run in flight on every such deploy,
which is how a control gets ignored.

Three facts about it worth knowing before you trust it:

- **It is deliberately conservative.** Source order stands in for execution
  order, so moving a helper function within `durable.ts` moves the print even
  though replay is unaffected. That is a false hold, and a false hold is
  cheap — see "clearing a hold" below. A missed break is not cheap.
- **It has one known blind spot.** A reordering achieved by swapping two
  helper *call sites* leaves both steps where they were in the source. The
  backstop below covers that.
- **It is not stored in the run input.** It rides on the `run-started` event
  beside the input (`data.stepFingerprint`). The recorded input is what gates
  step presence, so a fingerprint stored there would change how in-flight runs
  replay — the fence would have caused the failure it exists to prevent. The
  engine ignores keys on that event other than `workflow` and `input`.

**The declared step table cannot go stale.** `WORKFLOW_STEPS` is asserted in
`step-fingerprint.test.ts` against the sequence statically extracted from the
compiled `durable.js` and `harness-external.js`. Add, rename, reorder or remove
a step and the test fails until the table is updated — and whoever updates it
has to answer, per step, which input field admits it.

### The NondeterminismError backstop

Whatever the fingerprint misses, the engine still catches on replay. The worker
now treats a `NondeterminismError` out of a run the same way it treats a
fingerprint mismatch: the run is held. It used to be logged and left due, so a
diverged run was re-attempted every five seconds forever and no surface said so.

### Preflight

```sh
teploy-ship preflight            # exit 0 = safe, exit 1 = a run would be held
teploy-ship preflight --json     # the same as an object
```

Reports every run in flight and whether this build replays it. A run enqueued
**before the fence existed** records no fingerprint, so nothing can be said
about it: those count as unsafe, and `--allow-unrecorded` is how you say you
know. That is awkward exactly once — on the deploy that introduces the fence,
when every run in flight predates it.

Note the asymmetry, because it is the honest one: a run with no recorded
fingerprint makes *preflight* refuse, but it does **not** make the worker hold
the run. Holding them would make the fence's own arrival the outage.

### Clearing a hold

A hold is a fact about two builds, not about the run, and the run is untouched:
its log is intact and its next execution attempt recomputes the fingerprint
from scratch.

- **Roll back** (`teploy rollback`) and the worker releases the hold by itself
  on its next sweep — you do not have to remember which runs to resume.
- **`teploy-ship resume <run-id>`** re-checks immediately. Under the same build
  that held it, it will simply be held again; nothing is lost by trying.
- **`teploy-ship cancel <run-id>`** if you are willing to give the run up.

Nothing about a hold is written to the event log. An `event-waiting` is a cursor
event, so recording the hold there would itself change the sequence the hold
exists to protect.

## 3b. Shutdown: what a deploy actually interrupts

`teploy deploy` replaces the containers, so the worker gets a SIGTERM. Two
separate waits, with two separate reasons:

| phase | env | default | why that number |
|---|---|---|---|
| settle | `SHIP_SHUTDOWN_SETTLE_S` | 30 | Completion bookkeeping — spend settlement, the outbox flush, the meta write. Single store round trips behind a 4-attempt/500ms retry, so ~30s covers one store hiccup and there is nothing to gain past it. **This is the wait that matters**: a run's cost reaching the ledger is the only part of a shutdown the next worker cannot redo. |
| drain | `SHIP_DRAIN_TIMEOUT_S` | 0 | How long to wait for executing RUNS. Zero on purpose. |

The drain default is zero for three reasons, and none of them is "runs are
unimportant":

1. **A durable run is safe to interrupt.** Its log is on disk, another worker
   replays it, and at most the step in flight is re-executed.
2. **The bound is not ours to pick.** The container runtime SIGKILLs the
   process at its stop grace — docker's default is 10 seconds — so any default
   larger than that is fiction. The number is only real if the deployment's
   `stop_grace_period` matches it, which is a per-deployment fact. If you want
   the worker to actually drain, raise **both**, to the same value.
3. **Waiting for a natural boundary is not available.** A durable run cannot be
   suspended cooperatively: suspending means recording an event, and recording
   one the replay does not expect is precisely the nondeterminism this whole
   section is about. So "let it finish its current turn and stop" cannot be
   built without changing the workflow engine's contract.

The way to deploy without interrupting anything is `preflight` and a drain
*before* the deploy, not a longer wall-clock guess during it. The shutdown names
every run it interrupts and says what happens to it.

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
  The fence is symmetric and covers this too — a run whose fingerprint the
  rolled-back build does not recognise is held rather than broken — but its
  fingerprint was recorded at ENQUEUE, so it names the build that enqueued the
  run, not the one that last extended its log. A run enqueued before the
  upgrade, partly replayed under it, then rolled back, is a case only the
  `NondeterminismError` backstop catches. It is still held rather than lost.

So the honest rule: **rollback is safe when the version you are leaving added
only additive migrations and no step-sequence changes.** When it did either,
rolling back is a restore-from-backup operation, not a `teploy rollback`.

**Worked example — actor attribution (migrations 004 and 005).** Both are
additive column adds via rename-aside, and the actor is recorded on a run's
*metadata* rather than in its recorded workflow input, so no step sequence
changes and no in-flight run replays differently. That makes it safe to deploy
with runs already queued, and safe to roll back: older code ignores the extra
columns, and the aside tables (`ship_docs_004`, `ship_tasks_005`) still hold the
pre-migration rows. This is the shape to copy — attribution *could* have been
put in the run input, and that one decision is the difference between an
ordinary upgrade and a restore-from-backup.

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
teploy-ship preflight                             # nothing got held by the deploy
```

A `HOLDING` line in the worker log, or a `would break` row from `preflight`
after the deploy, means a run was enqueued by a build this one cannot replay —
see §3a for what to do about it. Nothing is lost either way; the run's log is
untouched.

A worker that cannot reach its store logs `tick failed (store unreachable?)`
and **fails closed on policy reads**, so it will not auto-launch anything while
degraded. That is by design: a worker unsure of its policy launches nothing.
