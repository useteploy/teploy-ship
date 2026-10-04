# The support bundle (`teploy-ship support`)

When something is wrong and a vendor (or future you, on a bad day) needs to see
it, there was no safe thing to send: the raw event logs carry everything the
agent ever read, and the config file carries every credential Ship runs on.
`teploy-ship support` assembles the middle ground — a **redacted** diagnostic
bundle that is safe by construction.

```
teploy-ship support [--out DIR] [--log-lines N] [--days N]
```

- `--out DIR` — where to assemble it (default: `./ship-support-<timestamp>`).
  The command writes the directory **and** a `<dir>.tgz` beside it.
- `--log-lines N` — tail lines per container log. Default 200, hard cap 2000.
- `--days N` — restrict the runs summary (rows and counts) to runs created in
  the last N days. Default: no restriction (bounded by the read window, below).

The command prints the bundle path and the redaction counts, and exits 0 even
when parts degrade (no docker, unreachable selfwatch, missing tar) — those
states are recorded as note files inside the bundle instead.

## What the bundle contains

| File | Contents |
| --- | --- |
| `manifest.json` | Date, hostname, Ship version + build fingerprint (the same identity `preflight` prints), node version, process uptime, bundle script version, and the bounds the bundle was assembled with. |
| `versions.json` | Package dependencies as `name@version` only, the pinned teploy CLI version (when the box records one), and the Nucleus **host** — the URL is parsed and only the host is kept, so credentials cannot survive it. |
| `config-summary.json` | The known-safe Ship settings — a fixed **whitelist** of model ids, numbers, booleans, policy maps and URL hosts (`SHIP_MODEL`, `SHIP_MAX_STEPS`, `SHIP_SANDBOX_TTL_SEC`, `SHIP_WARM_PARKS`, `SHIP_PUBLIC_URL` as host, `SHIP_TELEMETRY`, `SHIP_INTAKE_POLICIES`, `SHIP_MIN_FREE_MB`, `SHIP_MAX_CONCURRENT_RUNS`, `SHIP_HARNESS_MODEL`). |
| `runs-summary.json` | Counts by state over the read window, plus the 20 most recent runs: id, state, repo, createdAt, cost when attributed, and a one-line terminal error for failed runs. |
| `selfwatch.txt` | The health snapshot from `src/selfwatch.ts` (queue depth, worker staleness, stuck runs) computed against the same store, plus its warnings. |
| `doctor.json` | The redacted `teploy-ship doctor` report, run at assembly time with the same probes the command uses — live store liveness and clock skew when `NUCLEUS_URL` is set. Degrades to `doctor-unavailable.txt` when the doctor did not run or failed. |
| `backup-receipt.txt` | The manifest of the newest backup under `SHIP_BACKUP_DIR` (default `$SHIP_ROOT/_backups`) — the receipt only; **the archive itself is never part of a bundle**. A note names where it looked when no backup exists. |
| `logs/` | The last `--log-lines` lines of each `ship-*` container (`docker logs --tail`), or a note file explaining why not. |
| `REDACTION-REPORT.txt` | Counts of every redaction the gate performed, by category. |

The runs window is capped at 1000 store rows (the cap is recorded inside
`runs-summary.json` itself, so nobody mistakes a bounded read for all history).

## What it deliberately omits

- **All credential material.** Nothing that matches the repository's own
  secret scanner (`scripts/scan-secrets.mjs`: private keys, AWS keys, GitHub /
  Slack / OpenAI tokens, credentials embedded in URLs), plus userinfo URLs
  (`postgres://user:pass@…` → `postgres://[REDACTED]@…`), bearer tokens, and
  any `TOKEN` / `SECRET` / `KEY` / `PASSWORD` / `CREDENTIAL`-named assignment.
  Every hit is replaced with `[REDACTED:<kind>]` and counted in the report.
- **The store's raw config file.** It is never read, copied or archived by the
  bundle — only the parsed, whitelisted projection in `config-summary.json`.
  A new setting is absent from bundles until it is added to the whitelist, not
  present until someone remembers to exclude it.
- **Full event histories.** Only the bounded runs summary above.
- **File contents from workspaces.** Nothing a run touched is included.

## Running it

Run it **on the host that runs the containers**, with the docker CLI reachable
(the user needs to be in the docker group or equivalent) — that is where
container logs are collectable. It works degraded anywhere else: without
docker, `logs/` contains a note instead; if the store (`--store nucleus` +
`--nucleus-url`, or the default file store) is unreachable, the command fails
rather than emit a bundle that silently lacks its core.

The container-name filter defaults to the `ship-` prefix (the `app:` name in
`teploy.yml`); `--out` can point anywhere writable.

## Checking a fresh install: `teploy-ship doctor`

`teploy-ship doctor [--json] [--out <file>]` checks prerequisites before first
use: Node version, a writable state directory with enough free space, the web
port, `SHIP_WEB_TOKEN` and a model credential (presence only, values never
printed), the `NUCLEUS_URL` shape, store connectivity, and clock sanity.

Every check reports `pass`, `fail` or `unknown`; **unknown is not pass**. The
verdict is `ready` only when all pass, `not-ready` on any fail, `incomplete`
when nothing failed but something could not be established. Exit code is 0 only
for `ready`. Passing the `store-url` shape check does not mean the store was
reached: with `NUCLEUS_URL` set, `store-connectivity` is probed read-only
(`SELECT 1` — the rehearse proof's own liveness question) and `clock` measures
skew against the store's own clock (`SELECT now()`); without a configured store,
or when the engine does not answer a time query, both honestly stay `unknown` —
store CONSISTENCY is deliberately not probed at all, because it cannot be
established read-only while writers run (that proof is a snapshot rehearsal).
`--out` writes the redacted JSON, suitable to attach to a support request.

The snapshot side is now productized: `teploy-ship snapshot` produces the same
archive shape as `scripts/ship-backup.sh backup` (see [BACKUP.md](BACKUP.md)),
and `teploy-ship restore-check <archive>` verifies an archive — sha256 sidecar,
gzip integrity, content listing — without unpacking it. The restore comparison
module (`src/restore-readiness.ts`) still has no command of its own; the
rehearsal (`scripts/ship-backup.sh rehearse`) plus `preflight` remain the
restore proof.

## The support policy shape

Hand the `.tgz` to the vendor. The bundle is safe by construction — whitelist
for config, redaction gate over everything textual, bounded reads — but
**skim it before it leaves**: pattern matching is a reduction, not a guarantee,
and you are the one who knows what your own task titles and repo names are
allowed to say in front of a third party. `REDACTION-REPORT.txt` tells you
what the gate already caught; your eyes are for what it structurally could
not.

Never paste the raw output of `docker logs`, `teploy-ship audit --format json`,
or your config file into a ticket instead — that is exactly the exposure this
command exists to end.
