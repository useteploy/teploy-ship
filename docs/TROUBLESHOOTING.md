# Troubleshooting — symptom, cause, fix

Consolidated 2026-09-23 from the deployment docs and live operational
findings. First stops, in order: `teploy-ship explain <run-id>` (a run's
state in operator terms), `teploy-ship runs`, and the worker log
(`docker logs ship-worker-<sha> --since 10m`).

## Runs

**The run sits in `waiting`.**
It parked on a decision — an approval, a plan review, or a question. Not a
fault. `teploy-ship explain <run-id>` names what it asked for; answer it from
the dashboard, or `teploy-ship approve <run-id>` / `deny` / `answer`.

**The run never starts, and the worker log shows
`tick failed (store unreachable?)`.**
The worker cannot reach its store, and it **fails closed on policy reads** — a
worker unsure of its policy launches nothing, deliberately (auto-launch
especially). Fix the store or the network between them; the worker recovers on
its next tick, no restart needed.

**The run never starts, and `docker ps -a` shows the worker `Restarting`.**
The worker exits at boot on a configuration check and docker restarts it
forever; runs stay queued. `docker logs ship-worker-<sha>` names the check —
on a fresh install usually `a sandbox URL is set but no token`
(`SHIP_SANDBOX_URL` without `SHIP_SANDBOX_TOKEN`: set the token with
`teploy secret set`, or drop the URL to run without a sandbox). `teploy-ship
explain <run-id>` says so too: it reads the worker heartbeats and reports
"no worker is alive" instead of "still running" (fresh-machine pass F15).

**`repository not allowed` on enqueue or launch.**
The origin is not in `SHIP_REPO_ALLOWLIST` / `SHIP_GIT_TOKENS`. This is the
guard working: the URL in a webhook or issue body is attacker-controlled, and
an origin-less token must not go wherever a URL says. Add the origin (or the
full origin→token entry) and redeploy.

**The pull request has no Verification section.**
The worker is wired for none of the evidence legs, and adds nothing to the
body rather than printing "not tested" on every PR. `teploy-ship enqueue`
prints a `tests:` line saying whether the run asked; a CLI enqueue inherits
the ask the deployment's worker published at boot, and `--tests` asks
explicitly. Check `SHIP_TESTS=1` on the deployment, and
that the repo has a test command — detection needs one of `package.json`
`scripts.test`, a Makefile `test:` target, `go.mod`, `Cargo.toml` or pytest
config at the root — else set one on the Projects page
(`teploy-ship evidence set <repo> --test-command …`).

**A run dies with `the sandbox this run recorded … is no longer available`.**
The run's container was reaped mid-run: its TTL expired. Size
`SHIP_SANDBOX_TTL_SEC` for the **longest** run you allow, not the typical one
(worker default `7200` s; floor 600, daemon maximum 86400 — set the daemon max
if your step caps allow long runs). This is not theoretical: on 2026-09-15
three of six recent runs on the reference deployment died this way at 80–160
turns under a 3-hour TTL — a thinking model's turn runs minutes. Details in
DEPLOY.md's `SHIP_SANDBOX_TTL_SEC` row.

## Worker

**The worker logs `holding launches: disk` (or `memory`, or `load`) with
numbers and limits.**
Load-aware admission: the box is too squeezed to start another run safely.
The three reasons, checked in this order (`src/host-load.ts`):

- `disk` — free bytes on the docker root below `SHIP_MIN_FREE_DISK_MB`
  (default 2048), or inodes above `SHIP_MAX_INODE_USED_PCT` (default 95).
  Checked **first** because a full disk breaks the docker daemon for every
  tenant on the box; a module cache is millions of tiny files, so inodes can
  exhaust with tens of GB still free. Free space or raise the limit.
- `memory` — `MemAvailable` below `SHIP_MIN_FREE_MB` (default 600; one run
  plus headroom, from the measured ~350–400 MB per in-flight run). Wait for
  runs to finish, add RAM, or lower the ceiling.
- `load` — 1-minute load per CPU above `SHIP_MAX_LOAD_PER_CPU` (default 1.5).

Nothing is dropped — due runs wait. The hold re-senses on every pass and
clears itself when the box recovers; `0` disables a limit.

**A worker refuses to start on the forge's own box.**
The forge co-location gate (B4): the sandbox egress allowlist permits the
forge by design, so on the forge's machine that permission is a local hop to
every repository and credential it holds. Move the worker to another box, or
set `SHIP_ALLOW_FORGE_COLOCATION=1` knowing what it gives up (the override is
logged on every start). See DEPLOY.md "Forge co-location".

**`[selfwatch] N workers stale: owner@host (age), …` — one aggregated line.**
Workers whose heartbeats stopped (stale past 45 s, `WORKER_STALE_S`). The
normal cause is a replaced-container deploy: the old workers' registry rows
outlive their containers. If the fleet was deliberately replaced, do nothing —
the registry retires workers unseen for over 24 h and the line stops. If a box
you expect to be live is listed, check that worker's process and network.

## Store (Nucleus)

**`[nucleus-pgwire] pool query failed (<owner>), retrying on a connection of
its own: <error>`, then work continues.**
Benign when the retry succeeds: a known upstream fault in the Nucleus pgwire
layer on long-lived connection pools (reported upstream; tracked in the
upstream register). Ship retries the query once on a dedicated connection —
`src/nucleus-pgwire.ts`. One-off occurrences need nothing. If it recurs often
or the worker stops launching runs, restart the worker process and report the
recurrence upstream.

**During a Nucleus upgrade the worker logs `ECONNREFUSED` / `ENOTFOUND` for
tens of seconds.**
The engine replays its WAL on start and refuses connections while it does
(observed ~50 s on a ~750k-row store). The worker recovers by itself. Confirm
with `docker logs --since 30s` rather than the errors still sitting in the
buffer; do not restart-loop it. See UPGRADING.md §2.

**`knownhosts: key mismatch` from the teploy CLI (preview deploys, delivery
execution).**
The `known_hosts` file must carry **every host-key algorithm the connection
may negotiate** — an ed25519-only `known_hosts` reads as exactly this
mismatch even though your key is fine. Add the missing algorithms' keys for
the host (the file must also be readable by uid 1000 in the container). teploy
CLI v0.1.37+ names the missing algorithms in the error; the container image
currently bundles v0.1.36 (Dockerfile `TEPLOY_VERSION` pin), which does not.

## Deploys and upgrades

**After a deploy: a `HOLDING <reason>` line in the worker log, or
`teploy-ship preflight` reports a `would break` run.**
The upgrade fence: a run in flight was enqueued by a build this one cannot
replay (its recorded step sequence differs). Nothing is lost — the run's log
is untouched and it is parked as `waiting`. Fix, in order of preference:
`teploy rollback` (the hold releases itself on the next sweep),
`teploy-ship resume <run-id>` after rolling back, or
`teploy-ship cancel <run-id>` if you will give the run up. See UPGRADING.md
§3a for the model.

**`teploy-ship preflight` refuses with every run in flight `unrecorded`.**
Those runs were enqueued before the fence existed, so nothing can be said
about them. Wait for them to drain, or deploy with `--allow-unrecorded` after
reading UPGRADING.md §3's table yourself. The worker does NOT hold those runs
— only preflight refuses.

## Network and firewall

These are the ports a deployment actually needs (full reasoning in DEPLOY.md):

- `7460` — the dashboard, published directly with no TLS. Firewall it to your
  VPN/tailnet: `ufw allow from 100.64.0.0/10 to any port 7460`.
- `7439` — the sandbox daemon, from the teploy app network only:
  `ufw allow from 172.18.0.0/16 to any port 7439 proto tcp`.
- The sandbox egress proxy, from the sandbox network only. Current daemons
  start a **per-run proxy on an ephemeral port** on the egress bridge's
  gateway (not a fixed 7443), so allow the subnet, not one port:
  `ufw allow from 172.31.99.0/24`. With `teploy setup`'s UFW active and this
  rule missing, every sandbox network call hangs with no error and the run
  fails at `repo-setup`; `teploy-ship explain` reports it as "could not reach
  the forge" (fresh-machine pass F12/F17).

**A run's command fails with `network blocked: <host>`.**
The sandbox egress allowlist refused the host — the run's timeline row and
`teploy-ship explain` carry the remedy. On `allowlist` (the default) SSH
remotes and `git://` cannot work at all (use HTTPS clone URLs) and only ports
80/443 open unless an entry names a port. Widen per repo on the project
record (`teploy-ship project set <repo> --egress-allow …`), not daemon-wide,
unless every project on the host needs it.

**A dependency install fails inside the sandbox (Ruby/Java/PHP/.NET/Elixir).**
The registry is not on the daemon's built-in allowlist. Same fix as above:
per-repo `--egress-allow` entries on the project record.
