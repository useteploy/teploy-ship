# Framework upgrade to 0.3.2

This branch is staged until the upstream core 0.3.2, CLI 0.3.2 and create 0.1.9
packages are published. Do not deploy with old locks or replace registry URLs
with a developer's local source paths.

After the upstream release is reviewed and available:

```sh
node scripts/refresh-framework-locks.mjs
pnpm --dir web install --frozen-lockfile
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
pnpm --dir web test
pnpm --dir web run build
node scripts/audit-deployment.mjs
```

Review `web/pnpm-lock.yaml` and `deploy/package-lock.web.json`: core and CLI
must resolve to 0.3.2, CLI's create dependency must resolve, and production npm
must retain the web security overrides. The refresh command stages resolution
in temporary directories and changes neither lock when publication is absent.
It does not publish a package, push an image or deploy.

Lock publication uses verified sibling temporary files, original-byte backups
and a durable `.framework-lock-refresh/journal.json`. Each replacement is a
rename; the pair is **not atomic**. Do not run installs, builds or deployment
concurrently with refresh, and run only one refresh/recovery process at a time.
A replacement failure restores the original pair. If restoration fails, the
command exits with retained recovery material and its location; do not delete
that directory or the `*.framework-refresh-new` / `*.framework-refresh-restore`
sibling files.

After an interruption or retained-recovery error, stop the previous process,
leave the locks unused, and run from the same checkout:

```sh
node scripts/refresh-framework-locks.mjs --recover
```

Recovery needs no registry access. Before the durable completion record it
verifies backups and restores both original lock bytes, even if both replacements
had finished. After `complete.json` was durably recorded, it verifies the
completed pair and finishes cleanup instead. A pending directory blocks a new
refresh before registry commands. Review both locks after recovery, then rerun
the normal refresh and consumer validation. If recovery fails (for example,
missing/corrupt journal or backup, changed completed locks, or another I/O error),
retain all material, repair the filesystem issue and retry. Do not install or
deploy a mixed pair. For corrupt/missing evidence, manually compare the journal's
SHA-256 values and available originals with independently saved trusted locks;
restore the **entire** original pair and verify both before an operator removes
the recovery marker. Never infer successful recovery from one lock alone.

Run the isolated publication fault tests with
`node --test scripts/framework-lock-publication.test.mjs`.


Build the candidate with `teploy build` and run
`bash scripts/smoke-image.sh IMAGE` on the Docker host. Retain the exact tested
image identity and the old version/image from `teploy status --json`. Before
replacing an existing installation, follow [UPGRADING.md](UPGRADING.md): stop
all writers together (including joined workers), take and verify a backup with
`scripts/ship-backup.sh`, rehearse the candidate against its isolated copy and
retain history counts/digests plus fingerprint preflight output. Old job workers
must stop before new binaries start. Do not change feature flags during this
framework rollout.

Deploy only the reviewed, tested image with `teploy deploy --image IMAGE`.
Keep the gateway and existing Nucleus version unchanged. Invalidate any fronting
proxy/CDN cache entries for the dashboard's document/data URLs; a new `Vary`
header does not repair an old cache entry. Reload with a fresh browser session
and then exercise navigation followed by hard reload in the same session.

```sh
curl -fsS -D - -o /dev/null "$SHIP_URL/login"
curl -fsS -D - -o /dev/null -H 'Accept: application/json' \
  -H 'X-Neutron-Data: true' "$SHIP_URL/login"
```

The first response must be HTML and the second JSON. Both must contain
`Vary: Accept, Accept-Language, X-Neutron-Data, X-Neutron-Routes` (other fields
may also be present) and `Cache-Control: private, no-store`. Repeat navigation,
reload, login/logout and an authenticated dashboard read with an operator's
session; do not paste credentials into reports. Confirm waiting decisions and
history remain intact and monitor worker admission/lease errors.

If acceptance fails, stop every new writer before `teploy rollback --to OLD_VERSION`
and invalidate caches again. Preserve the live store and both image identities.
Framework-only rollback should not require restoring a store; if schema or
history compatibility fails, rehearse the verified backup in an isolated directory
and use the established coordinated restore procedure. Never unpack a backup
over the live store. Recheck HTML/JSON behavior, health and waiting-run history
before restarting old workers.
