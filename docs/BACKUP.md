# Backing up and restoring Ship's store

Ship's entire history — every run's event log, which is also its audit record,
plus intake, spend and the code index — lives in its store: the `postgres`
accessory (`--store postgres`, production since 2026-10-14) or, on older
installs, the Nucleus engine's data directory. This is the procedure for
copying it, proving the copy, and — when you actually need it — restoring it.
It is checked in as `scripts/ship-backup.sh` so it is the same procedure every
time, not shell history in a handoff doc.

The script works out which store the install uses: the running writers' own
`--store` args first (what the store actually IS), then
`$SHIP_ROOT/teploy.yml` (or `SHIP_TEPLOY_YML`), then which accessory
containers and data dirs are present. Signals that disagree — a burn-in box
holding both — are a refusal, never a guess; pass `--store nucleus|postgres`
(or `SHIP_STORE`) to say it yourself.

`scripts/ship-backup.sh` has four subcommands — `backup`, `verify`,
`restore`, `rehearse` — and two invariants that are the product:

- **It never deletes or overwrites a backup.** Retention is yours. Backups
  are kept forever unless you delete them yourself; there is no automation
  for deletion and none will be added.
- **It never restores onto the live store.** `restore` only unpacks into an
  empty, isolated directory and refuses any target that is — or contains —
  `$SHIP_ROOT/accessories/nucleus/nucleus-data` or the postgres data dir; a
  pg_dump archive restores only into a NEW scratch postgres container, never
  the `ship-postgres` accessory. A real recovery is a deliberate,
  writers-stopped operation you perform by hand, not something a script
  offers as a flag.

## When to back up

Before any state-changing cutover: an upgrade, a Nucleus engine image bump
(WAL-format upgrades especially — see [UPGRADING.md](UPGRADING.md) §2), a
storage migration, or any coordinated rollout that stops writers. If you are
about to do something that could require rolling the store back, take the
archive first; `teploy rollback` returns code, not data.

## The commands — postgres store (production)

```sh
# on the server, from a checkout of this repo
SHIP_ROOT=/deployments/ship

# 1. online, consistent backup: pg_dump -Fc runs INSIDE ship-postgres (docker
#    exec, unix-socket auth, no password handled) — no writer stop needed
scripts/ship-backup.sh backup --label pre-upgrade
#    -> /deployments/ship/_backups/pre-upgrade-<date>/ship-pg.dump
#       (+ .sha256 sidecar + manifest.txt with per-table row counts)

# 2. verify: checksum + PGDMP header + pg_restore --list
scripts/ship-backup.sh verify /deployments/ship/_backups/pre-upgrade-<date>/ship-pg.dump

# 3. rehearsal: scratch postgres (same image), pg_restore, table set and every
#    row count must equal the manifest, then teploy-ship preflight --store postgres
SHIP_BIN=/path/to/teploy-ship scripts/ship-backup.sh rehearse \
  /deployments/ship/_backups/pre-upgrade-<date>/ship-pg.dump
```

`pg_dump` reads one transaction snapshot, so the archive is consistent while
web and worker keep writing — that is why this path asks for no stop. The
manifest's row counts are read back FROM THE ARCHIVE (pg_restore renders its
data and the script counts the rows per table), so they describe exactly what
the archive holds, not a separate query that raced the writers. A pg_dump that
fails removes only its own just-created output dir, so the label+date slot is
not occupied by a broken archive.

`--cold` is the other postgres shape: a tar of the pgdata bind dir
(`pgdata-full.tgz`, discovered from the accessory's mount, default
`$SHIP_ROOT/accessories/postgres/pgdata`). It has the nucleus rule — it
refuses while any `ship-*` container runs, the `ship-postgres` engine
included — and its rehearsal boots a scratch postgres on an isolated copy and
counts every table (a cold manifest has no counts to compare against, and the
copy keeps the live cluster's roles, so preflight is not run on it). This is
the manual pattern the 2026-10-16 soak used, now checked in.

Postgres environment: `SHIP_PG_CONTAINER` (default `ship-postgres`),
`SHIP_PG_DB` / `SHIP_PG_USER` (default: the container's `POSTGRES_DB` /
`POSTGRES_USER`), `SHIP_PG_DATA_DIR` (cold source), `SHIP_PG_IMAGE` (scratch
image; default: the manifest's `pg-image`, else the live container's image).

## The commands — nucleus store

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
(default `$SHIP_ROOT/_backups`), `SHIP_STORE` (skip detection), and for
`rehearse` only: `SHIP_BIN` (default `teploy-ship`), `SHIP_NUCLEUS_IMAGE`,
`SHIP_REHEARSE_TIMEOUT_S`.

## The CLI commands: `snapshot` and `restore-check`

The producer and the verifier are also first-class CLI commands, with the
same invariants and the same archive shape — a backup taken with either tool
verifies with both:

```sh
teploy-ship snapshot [--label NAME] [--ship-root DIR] [--backup-dir DIR]
                     [--dry-run] [--i-stopped-writers] [--json]
teploy-ship restore-check <archive> [--json]
```

- `snapshot` writes the identical `<label>-<date>/nucleus-data-full.tgz` +
  `.sha256` sidecar + `manifest.txt` under `SHIP_BACKUP_DIR` (flags
  `--ship-root`/`--backup-dir`, env `SHIP_ROOT`/`SHIP_BACKUP_DIR`, same
  defaults as the script). It refuses while `ship-*` containers run unless
  you attest the coordinated stop with `--i-stopped-writers`, never
  overwrites an existing backup dir, and never deletes anything — except its
  own partial output when a production fails, so a failed tar does not
  occupy the label+date slot forever. Retention stays yours.
- `restore-check` verifies an archive WITHOUT unpacking it: sha256 sidecar
  (in `sha256sum -c` form — the sidecar must travel with its archive),
  full-stream gzip integrity, and the tar content listing, failing on
  absolute or `..` paths that would escape an unpack target. It is integrity
  only: it says plainly that no engine has booted on the archive and points
  at `scripts/ship-backup.sh rehearse` as the restore proof.

Store coverage: `snapshot` is the nucleus tar only — on a postgres-store
install it refuses and points at `scripts/ship-backup.sh backup`.
`restore-check` verifies any of the tar archives (`nucleus-data-full.tgz`,
the cold `pgdata-full.tgz`); a `ship-pg.dump` is not gzip, so verify it with
`scripts/ship-backup.sh verify`.

The unpack (`restore --into` an empty isolated dir) and the rehearsal stay
in the script, deliberately: they are the steps that touch a live recovery,
and a shell script an operator reads line by line is the right shape for
them.

## What the archive contains

Postgres (`ship-pg.dump`): a custom-format `pg_dump` of the ship database —
schema, every table's rows, the `vector` extension declaration the code index
needs. The manifest records store, method, container, image (restore with the
matching pgvector build), server version, database, user, archive size,
sha256, and every table with its row count. The cold `pgdata-full.tgz` is the
whole cluster directory, rooted at `pgdata/`.

Nucleus: the complete engine data directory (`accessories/nucleus/nucleus-data`):
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

## The rehearsal — proof, not faith

An unverified backup is a hope.

For a `ship-pg.dump`, `rehearse` starts a NEW scratch postgres container
(the manifest's image, loopback-only port, a random password), runs
`pg_restore --exit-on-error` into it, and then requires the restored set of
tables to equal the manifest's and every table's `count(*)` to equal the
manifest's count — one mismatched table fails the rehearsal and names it.
When a `teploy-ship` is on PATH (or `SHIP_BIN`) it also runs `teploy-ship
preflight --store postgres` against the copy; without one it says the counts
were the proof. It removes only its own proof container, pass or fail.

For a nucleus archive, `rehearse` unpacks the archive into an
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

`rehearse` proves the archive. `restore <ship-pg.dump>` puts the dump into a
NEW scratch postgres container (loopback port, random password printed),
checks it against the manifest and leaves it running for inspection — remove
it yourself with `docker rm -f`. A real postgres recovery is:

1. Stop web and worker (the accessory keeps running).
2. Keep the current database: take a fresh `backup` first, even of a store
   you believe is bad.
3. Restore into the accessory by hand, deliberately — e.g. `docker exec -i
   ship-postgres pg_restore --clean --if-exists --no-owner -U ship -d ship <
   ship-pg.dump` — the script offers no "restore over the live store" path.
4. Start web and worker; check the dashboard's run list against the
   manifest's counts.

A real nucleus recovery is:

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
