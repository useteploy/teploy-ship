# Backing up and restoring Ship's store

Ship's entire history — every run's event log, which is also its audit record,
plus intake, spend and the code index — lives in the Nucleus engine's data
directory. This is the procedure for copying it, proving the copy, and — when
you actually need it — restoring it. It is checked in as
`scripts/ship-backup.sh` so it is the same procedure every time, not shell
history in a handoff doc.

`scripts/ship-backup.sh` has four subcommands — `backup`, `verify`,
`restore`, `rehearse` — and two invariants that are the product:

- **It never deletes or overwrites a backup.** Retention is yours. Backups
  are kept forever unless you delete them yourself; there is no automation
  for deletion and none will be added.
- **It never restores onto the live store.** `restore` only unpacks into an
  empty, isolated directory and refuses any target that is — or contains —
  `$SHIP_ROOT/accessories/nucleus/nucleus-data`. A real recovery is a
  deliberate, writers-stopped operation you perform by hand, not something a
  script offers as a flag.

## When to back up

Before any state-changing cutover: an upgrade, a Nucleus engine image bump
(WAL-format upgrades especially — see [UPGRADING.md](UPGRADING.md) §2), a
storage migration, or any coordinated rollout that stops writers. If you are
about to do something that could require rolling the store back, take the
archive first; `teploy rollback` returns code, not data.

## The commands

```sh
# on the server, from a checkout of this repo
SHIP_ROOT=/deployments/ship

# 1. coordinated stop: ship web + worker writers, and the engine
docker ps --format '{{.Names}}'          # note ship-web-<sha>, ship-worker-<sha>, ship-nucleus
docker stop ship-web-<sha> ship-worker-<sha> ship-nucleus

# 2-4. archive + sha256 sidecar + manifest, then verify (checksum + gzip -t)
scripts/ship-backup.sh backup --label pre-upgrade
#    -> /deployments/ship/_backups/pre-upgrade-<date>/nucleus-data-full.tgz
#       (+ .sha256 sidecar + manifest.txt next to it)

# 5. restore rehearsal: isolated unpack + isolated nucleus + preflight proof
SHIP_BIN=/path/to/teploy-ship scripts/ship-backup.sh rehearse \
  /deployments/ship/_backups/pre-upgrade-<date>/nucleus-data-full.tgz

# 6. start web and worker again (teploy deploy, or docker start)
```

`backup` refuses to run while any `ship-*` container is still running and
prints the exact `docker stop` line it expects; re-run it with
`--i-stopped-writers` once the stop has happened. The flag is an attestation,
and it exists because joined workers are systemd units this box's docker
cannot see — only you can say the writers are really stopped. A tar of a
live store is not a backup; it is a corrupt archive with a backup's name.

`--dry-run` prints the plan and writes nothing.

Environment: `SHIP_ROOT` (default `/deployments/ship`), `SHIP_BACKUP_DIR`
(default `$SHIP_ROOT/_backups`), and for `rehearse` only: `SHIP_BIN`
(default `teploy-ship`), `SHIP_NUCLEUS_IMAGE`, `SHIP_REHEARSE_TIMEOUT_S`.

## What the archive contains

The complete engine data directory (`accessories/nucleus/nucleus-data`):
durable run event logs, intake tables, spend ledger, code index vectors —
everything Nucleus persists. The manifest beside it records date, hostname,
archive size, sha256, script version, and the ship containers (names +
images) docker knew about, so a future restore knows which engine image the
data belongs with.

## What it deliberately does not contain

- **Docker images.** Rollback history for code lives in the registry /
  server's image store (`teploy rollback` returns the previous container and
  image). The backup carries data only — but the manifest names the engine
  image the data was taken under, because a Nucleus rollback is
  restore-archive-with-matching-image, not an image swap (see the pin notes
  in `teploy.yml`).
- **Worker sandbox volumes.** Per-run sandbox workspaces and the warm clone
  cache are rebuildable and not part of the store's history.

## The rehearsal (step 5) — proof, not faith

An unverified backup is a hope. `rehearse` unpacks the archive into an
isolated directory under `$SHIP_BACKUP_DIR/rehearsals/`, starts an isolated
Nucleus container against the copy (same no-auth posture as the accessory,
loopback-only published port, with the engine image discovered from the
`ship-nucleus` container or passed via `--image`), waits out WAL replay, and
runs `teploy-ship preflight --store nucleus` against it — which reads run
counts and step fingerprints from the restored copy. It then removes ONLY
the proof container it created and its own rehearsal directory. Existing
backups are never touched.

If preflight cannot read the restored store, the rehearsal fails with the
engine's logs — that archive is not proven, and you find out now, not during
a recovery.

## Restoring for real

`rehearse` proves the archive. A real recovery is:

1. Stop writers and the engine (the same coordinated stop as a backup).
2. Move the live data directory aside — never delete it until the restored
   store has been proven.
3. `scripts/ship-backup.sh restore <archive> --into <fresh-dir>` and point
   the engine's volume at `<fresh-dir>/nucleus-data`, or place the data back
   by hand — the script deliberately offers no "restore over the live dir"
   path.
4. Bring the engine up with the **matching image** (the manifest names it),
   then web and worker.

## Retention

Backups are kept forever unless you delete them. The script will never
delete, overwrite, or prune one — a second `backup` with the same label on
the same day refuses rather than replaces. If you want a retention policy,
that is a decision you implement and own outside this tool.

## Upgrade coupling

Upgrades and engine bumps have their own runbook — [UPGRADING.md](UPGRADING.md) —
including when a backup is mandatory (forward-only migrations, WAL format
changes) and what rollback can and cannot undo. This document is the how of
the archive itself; that one is the when and the around it.
