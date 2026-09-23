# Retention — what Ship deletes (nothing) and what it bounds

Stated 2026-09-23. The decided stance, the numbers Ship does bound by itself,
and the scale envelope installs are supported at. `[docs/capacity.md](capacity.md)`
is the companion document for load; this one is about stored history.

## The stance

**Ship never automatically deletes user data.** Run and event history
retention is the operator's storage policy, not Ship's — the same line
[DEPLOY.md](DEPLOY.md) already carries in its audit-trail section: *"Retention
is your storage's, not Ship's: the export reads the same durable event logs
the runs are made of, and nothing prunes them."* A deployment grows until you
archive, export (`teploy-ship audit --format json`) and prune it yourself.

What this means concretely:

- Every run's event log is append-only and lives forever in the store
  (Nucleus volume, or `TEPLOY_SHIP_STATE` in file mode).
- Exports read those logs; they never truncate them.
- There is no TTL, no rotation job, and no config flag that prunes history —
  by design, because the logs are also the audit record and the replay source
  (UPGRADING.md §3: a run's log is what a replay consumes).

## What Ship does bound by itself

These bounds exist to keep reads and surfaces cheap. **None of them deletes
user data** — they cap indexes, lists and derived records; the underlying
runs and events stay in the store.

| Bound | Value | What it caps | Where |
|---|---|---|---|
| Incident index | 200 records | The `/incidents` list. Older incident records stay in the store but leave the list. | `src/incidents.ts:81` (`INCIDENTS_LIMIT`) |
| Schedule digest history | 10 entries shown, 20 stored | Digest entries per schedule (one per settled occurrence). Oldest stored entries are dropped when the store cap is exceeded — these are derived records, not run logs. | `src/workflow-schedules.ts:128` (`DIGEST_LIMIT`), `:131` (`DIGEST_STORE_LIMIT`) |
| Attention queue | 50 rows | The `/attention` page (one row per item needing a human). The page says when it truncated; the underlying decisions live on their own pages. | `web/src/lib/attention.server.ts:52` (`ATTENTION_CAP`) |
| Fleet registry prune | workers unseen for 24 h | Worker rows in the fleet registry. A worker that stopped heartbeating is retired from the registry after a day — the registry is live state, not history, and would otherwise grow forever on a replaced-container fleet. | `src/worker.ts:1786` (`retentionMs = 24 * 60 * 60 * 1000`) |

## Supported history scale

Measured live: **250 runs / 12,696 events** on the reference deployment
(2026-09-22, `docs/capacity.md`'s method — measured, not projected; the
history digest was checked byte-identical across deployments that day).

**Initial supported envelope: 10x that — 2,500 runs / ~125k events.
UNMEASURED.** This is a target pending a measurement pass at that scale, not
an observed result; nothing has been run at 2,500 runs, and list/stream
latency at that size is exactly what the probe below exists to measure before
the envelope is claimed. Treat 250/12.7k as the only measured point.

## The measurement probe

`scripts/measure-history.mjs` measures a store's runs-list latency, per-run
event stream latency and total counts, and writes a dated JSON record. It
opens the same store the CLI opens (file via `TEPLOY_SHIP_STATE`, Nucleus via
`NUCLEUS_URL` — connecting exactly as the CLI does, including its at-connect
migration check) and reads **every run's event log**, so run it against a
restored copy or off-peak:

```sh
node scripts/measure-history.mjs --store nucleus --confirm   # guidance in --help
```

When a pass at 2,500 runs exists, replace the UNMEASURED marker above with
the measured numbers and the date.
