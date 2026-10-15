# Migrating ship's store: Nucleus → PostgreSQL (infra-home)

Moves the live instance's data off `ship-nucleus` (v1.1.1) onto a
`ship-postgres` accessory. The catalog default already flipped; this aligns
prod with it and ends ship's dependency on Nucleus.

`scripts/migrate-store.mjs` does the copy: every table it finds (minus
engine internals and the derived code-index cache), plus per-run event
streams (best effort, so `explain` keeps history). KV locks/claims are
TTL-transient and start empty. The old Nucleus volume is never touched —
rollback is a config revert.

## Prerequisites (blocking)

1. The postgres-store code (uncommitted at the time of writing — see
   AUDIT_OPEN.md 2026-10-14) is committed and deployed: `teploy deploy`
   builds the image ON the server from this directory, so the new code must
   be what's synced. Verify on the server: the deployed binary accepts
   `--store postgres` before touching data.
2. Rehearsal (do this first, ~10 min on any Docker host incl. infra-home):

   ```sh
   docker network create rehearse
   docker run -d --name nuc --network rehearse -e NUCLEUS_ALLOW_NO_AUTH=1 \
     -e NUCLEUS_ALLOW_INSECURE_CLUSTER=1 -e NUCLEUS_ALLOW_INSECURE_REPLICATION=1 \
     ghcr.io/neutron-build/nucleus:v1.1.1 start --port 5432 --cluster-port 5433 --data /data --max-memory 512
   docker run -d --name pg --network rehearse -e POSTGRES_PASSWORD=pw \
     -e POSTGRES_USER=ship -e POSTGRES_DB=ship pgvector/pgvector:0.8.0-pg17
   # load a few ship-shaped rows into nuc (ship_docs, ship_migrations, a
   # PK'd table, one STREAM_XADD), then:
   docker run --rm --network rehearse -v "$PWD":/w -w /w \
     -e FROM_URL=postgres://nucleus@nuc:5432/nucleus?sslmode=disable \
     -e TO_URL=postgres://ship:pw@pg:5432/ship?sslmode=disable \
     node:22 node scripts/migrate-store.mjs
   ```

   Expect exit 0 and matching counts. Tear down with `docker rm -f nuc pg`.

## The teploy.yml change (apply at migration time)

Replace the `nucleus` accessory and store flags:

```yaml
processes:
  web: web --store postgres --port 7460
  worker: worker --store postgres --interval 5

accessories:
  postgres:
    image: pgvector/pgvector:0.8.0-pg17
    port: 5432
    memory: 1g
    env:
      POSTGRES_DB: ship
      POSTGRES_USER: ship
      POSTGRES_PASSWORD: secret:SHIP_DB_PASSWORD
    volumes:
      pgdata: /var/lib/postgresql/data

env:
  NUCLEUS_URL: postgres://ship@ship-postgres:5432/ship?sslmode=disable
  PGPASSWORD: secret:SHIP_DB_PASSWORD
```

The `nucleus:` accessory block stays in place initially (rollback path);
remove it after the burn-in period. Set the password once:

```sh
teploy secret set SHIP_DB_PASSWORD=<generated>   # openssl rand -base64 24
```

## Order of operations

1. **Backup the old store** (belt and braces — the migrator never writes to
   it, but the volume archive is the restore path):
   `teploy accessory backup nucleus` (generic archive — engine-aware dumps
   do not apply to Nucleus).
2. **Stop writers**: stop the ship web + worker containers. The old nucleus
   accessory keeps running (the migrator reads it).
3. **Apply the teploy.yml change and deploy.** If the app boots against the
   empty store before you stop it again, that is harmless (its migration
   ledger inserts duplicates the copy will add; the app reads the ledger
   into a Set). Stop the web+worker containers once the postgres accessory
   is up.
4. **Run the migrator** from the repo root on infra-home (or any machine,
   but the teploy network is on infra-home):

   ```sh
   docker run --rm --network teploy -v "$PWD":/w -w /w \
     -e FROM_URL=postgres://nucleus@ship-nucleus:5432/nucleus?sslmode=disable \
     -e TO_URL=postgres://ship:<SHIP_DB_PASSWORD>@ship-postgres:5432/ship?sslmode=disable \
     node:22 node scripts/migrate-store.mjs
   ```

   Exit 0 = every table's count matches the source.
5. **Restart the app** (`teploy deploy` again reconciles) and verify:
   dashboard runs list matches pre-migration, task queue intact, intake
   policies present, `teploy-ship explain <old-run-id> --store postgres`
   still replays history.
6. **Burn-in**: keep the nucleus accessory (stopped or running) and its
   volume for ≥14 days, then remove the accessory block and volume.

## Rollback

Revert the teploy.yml store flags to `--store nucleus` and redeploy — the
old store is intact and untouched. Writes made to postgres after cutover do
NOT flow back (no reverse sync); the further past migration you are, the
more rollback costs. Decide within the burn-in window.
