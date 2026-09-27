# Quickstart — your first tested pull request

This is the shortest honest path from nothing to *a pull request Ship opened,
carrying the test result that proves it*. It skips the gateway, the sandbox
daemon and webhooks — all of which are worth having and none of which you need
to see the loop work.

`docs/DEPLOY.md` is the full deployment and security model. Read it second.

**What you need before you start**

- A Linux box you can `ssh` into, with Docker. Ship brings up three containers
  (web, worker, and a Nucleus store) and idles at roughly 200 MB.
- The `teploy` CLI on your machine: `brew install useteploy/tap/teploy`
  (macOS). On Linux, take the binary from a
  [release](https://github.com/useteploy/teploy-cli/releases/latest)
  (`teploy_linux_amd64.tar.gz`; verify against the release's `checksums.txt`)
  and put it on your PATH.
- Node 22, pnpm 10 and git on the machine you run the install from — Ship's
  `dist/` and `web/dist/` are built there, not on the server
  (`corepack enable && corepack prepare pnpm@10 --activate`).
- A model key. An Anthropic API key works as-is. A key for an
  Anthropic-COMPATIBLE endpoint (z.ai's GLM route) works too, wired
  differently — see "Model keys that are not Anthropic's" below.
- A git token for the repository you want Ship to work in — a Forgejo access
  token or a GitHub PAT with `repo` scope.
- `ssh` to the server working from this machine, with the server's keys in
  `known_hosts` for **every** key type: teploy may negotiate ECDSA where your
  own `ssh` used ED25519, and refuses the mismatch. `ssh-keyscan <server-ip>
  >> ~/.ssh/known_hosts` (no `-t`) covers it.

---

## The whole thing, in one command

```sh
git clone <your-ship-remote> teploy-ship && cd teploy-ship
./install.sh --host 203.0.113.10 --user root --allow https://github.com/your-org mybox
# an Anthropic-compatible endpoint instead of Anthropic:
#   ./install.sh ... --model-url https://api.z.ai/api/anthropic --model glm-5.3 mybox
```

It provisions the server, generates `SHIP_WEB_TOKEN` / `SHIP_SESSION_SECRET` /
`SHIP_WEBHOOK_SECRET`, asks for the two values only you can supply (a forge
token and a model key), builds Ship, and deploys. It builds the sandbox images
only when a sandbox daemon is installed — nothing else uses them, and they were
three quarters of the install's wall clock. `--allow` is the forge origin your
token may be sent to; without it every repository is refused until you add a
project on the dashboard. Skip to step 5.

Measured on a clean box (2026-09-24, one 2-cpu container as laptop and
server): `install.sh` took 18 minutes, 13.6 of them building the sandbox
images it now skips without a daemon; the first run on a small repository
took under a minute from enqueue to pull request. The install without sandbox images has
not been timed end to end yet.

The rest of this page is the same thing by hand, for when you want to see each
piece.

---

## 1. Register the server

```sh
teploy server add mybox 203.0.113.10 --user root          # or edit ~/.teploy/servers.yml
teploy setup 203.0.113.10 --name mybox                    # installs Docker + Caddy if absent
```

## 2. Get Ship

```sh
git clone <your-ship-remote> teploy-ship && cd teploy-ship
pnpm install && pnpm run build
(cd web && pnpm install && pnpm run build)
```

**Both builds are required.** The image copies `dist/` and `web/dist/` rather
than building from source on the server, so a missing `web/dist` fails the
deploy rather than degrading it.

Then make the config yours — **from `teploy.example.yml`, not the repo's own
`teploy.yml`**, which is the maintainer's production shape (gateway, sandbox
host, host-bind mounts; stripping it by hand is ~13 edits and the first one
missed crash-loops the worker):

```sh
cp teploy.example.yml teploy.yml     # then change the lines marked CHANGE
teploy validate                      # parses it and checks the server
```

The example is the minimal shape: web, worker and the Nucleus store, tests on,
no sandbox. The 2026-09-24 rerun deployed it with only the CHANGE lines edited
and got a verified pull request from it.

## 3. Set the secrets

Never in `teploy.yml`. From the repo directory:

```sh
teploy secret set \
  SHIP_WEB_TOKEN="$(openssl rand -hex 32)" \
  SHIP_SESSION_SECRET="$(openssl rand -hex 32)" \
  SHIP_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY="sk-ant-…" \
  SHIP_GIT_TOKEN="<your git token>"
```

Keep `SHIP_WEB_TOKEN` — it is your dashboard login.

### Model keys that are not Anthropic's

An Anthropic key needs `ANTHROPIC_API_KEY` and nothing else. For an
Anthropic-compatible endpoint, set the key as `AI_GATEWAY_KEY` instead and put
these in `teploy.yml`'s `env:` (the example carries them commented out):

```yaml
AI_GATEWAY_URL: https://api.z.ai/api/anthropic
SHIP_MODEL: glm-5.3                    # UNPREFIXED: the endpoint gets it verbatim
SHIP_ANTHROPIC_WIRE_PREFIXES: glm      # speak Anthropic's wire to ids starting glm
```

Verified live on 2026-09-23 and 2026-09-24. `ANTHROPIC_BASE_URL` is **not**
read — setting it sends your key to api.anthropic.com (`invalid x-api-key`) —
and `SHIP_MODEL: anthropic/glm-5.3` reaches z.ai as `anthropic/glm-5.3`
(`Unknown Model`). `install.sh --model-url` writes exactly this shape.

### One server-side step

teploy creates the `ship-data` volume's host directory owned by root, and
Ship's image runs as uid 1000. Without a sandbox daemon every run's workspace
lives there, so every run would die at its first step (`EACCES … /data`):

```sh
ssh root@203.0.113.10 'mkdir -p /deployments/ship/volumes/ship-data && chown 1000:1000 /deployments/ship/volumes/ship-data'
```

`install.sh` does this for you; the worker warns at boot if it was missed.

## 4. Deploy

```sh
teploy deploy
```

This builds the image on the server, starts the Nucleus accessory, health-checks
the web process, and only then stops the old containers. Roughly two minutes on
a first run, fifteen seconds after that.

The dashboard is now at `http://<server>:7460`, and `ingress: host` publishes it
**directly on that port with no TLS**. Firewall it:

```sh
ufw allow from 100.64.0.0/10 to any port 7460   # Tailscale-only, for example
```

## 5. Give it something to do

The dashboard is the natural first surface: open `http://<server>:7460`, sign
in with `SHIP_WEB_TOKEN`, and compose the task on the Inbox — the project,
its settings and its approvals are all right there.

From a terminal, the same ask is one command, run INSIDE the worker
container — it has the deployment's store, token and settings, and the image's
entrypoint is `node /app/dist/cli.js` (there is no `teploy-ship` on its PATH):

```sh
ssh root@203.0.113.10 'docker exec $(docker ps -qf name=ship-worker) node /app/dist/cli.js \
  enqueue "The failing test in parser_test.go describes the bug. Fix it." \
  --repo https://github.com/your-org/your-repo --store nucleus'
```

It answers with the run id and a `tests:` line saying which suite the run will
run (or that it will run none, and why). A bare `teploy-ship enqueue` on your
laptop writes to the CLI's LOCAL file store — the deployment's worker never
sees it. The store is not published outside the server's docker network, on
purpose; `--store nucleus --nucleus-url …` from elsewhere needs a route to it
(a second worker does this — `teploy-ship join`), and such an enqueue inherits
the evidence asks the deployment's worker published at boot.

That queues a durable run. A worker picks it up within a few seconds; the
same `docker exec … node /app/dist/cli.js` prefix runs these:

```sh
teploy-ship runs --store nucleus                  # what exists, and its state
teploy-ship explain <run-id> --store nucleus      # what happened, and what to do about it
```

`explain` is the one to reach for when a run does not do what you expected. It
reads the run's event log and answers in operator terms — where it stopped, and
the next action — rather than handing you three hundred events.

**What you should see:** a run reaching `completed`, and a pull request on your
repository whose body carries the agent's summary. Total cost for a small,
well-specified fix is a few cents.

## 6. Make the pull request carry evidence

The step that makes Ship different from a code generator: **Ship runs your test
suite itself, after the agent stops and before the push**, and puts the result
in the pull request body. The agent's own account of its testing is not used —
models get that wrong, which is why the check exists.

`teploy.example.yml` and `install.sh` already set `SHIP_TESTS=1`; the first
run above carries a Verification section when the repo's suite can run where
the run executes. Without a sandbox daemon that is the worker container, which
has node, npm and git and nothing else: a JavaScript suite runs, a Go or Python
suite reports "not run" (never "failed") until the sandbox daemon and its
images are in (`docs/DEPLOY.md` — the sandbox daemon). To turn it on by hand:

```sh
teploy secret set SHIP_TESTS=1
teploy deploy
```

You usually do not have to type the command at all. With no per-repo entry,
Ship reads the repo's root at enqueue and infers the suite — `package.json`
`scripts.test` (with the install the fresh clone needs), a Makefile `test:`
target, `go.mod`, `Cargo.toml`, pytest config. `SHIP_TEST_COMMAND` is the
last resort under that, not the first choice.

Two things to get right:

- Whatever command runs must be runnable **in the sandbox image**
  (`SHIP_SANDBOX_IMAGE`). `pnpm test` against a Go image reports "not run" —
  correct, and useless. `images/build.sh` builds `ship-sandbox-go:dev` and
  `ship-sandbox-node:dev`; pick per repo on the Projects page.
- Repos whose suite the guess gets wrong get their own command, keyed by repo,
  and an explicit entry always wins:

  ```sh
  teploy-ship evidence set tyler/my-go-repo --test-command "go test ./..."
  teploy-ship evidence set tyler/my-ts-repo --test-command "pnpm test"
  teploy-ship evidence set tyler/my-ts-repo --observe-service my-ts-svc  # if Observe watches it
  ```

  A repo with a `testCommand` gets its suite run even where `SHIP_TESTS` was
  never set: the config is the ask.

  The same record is the dashboard's **Projects** page (`/projects`): adding a
  repo there allows it (no `SHIP_REPO_ALLOWLIST` edit), picks the sandbox
  image its runs boot (a Go repo and a pnpm repo can share one worker), picks
  which harness edits its tree, and sets its test command. `teploy-ship project
  set <clone-url> --image ship-sandbox-node:dev --test-command "pnpm test"` is
  the CLI form; `evidence set` writes the same record.

Enqueue another task and the pull request now carries a Verification section:

```
## Verification

Tests: **passed** — `go test ./...`, 0s.

Run by Teploy Ship after the agent stopped, not reported by the agent.
```

A failing suite still publishes the pull request, marked failed with its output
and captioned that the failure may or may not be caused by the change. A suite
that could not be *run* is reported as "not run", never as "failed" — a killed
suite did not fail, it never finished.

---

## Where to go next

| you want | read |
|---|---|
| Webhooks, so issues become runs without you typing | `docs/DEPLOY.md` — intake sources |
| A sandbox with default-deny egress for untrusted tasks | `docs/DEPLOY.md` — the sandbox daemon |
| Preview deploys and telemetry on the pull request | `docs/DEPLOY.md` — `SHIP_PREVIEW_*`, `OBSERVE_*` |
| Which models actually work, with numbers | `docs/MODELS.md` |
| Upgrading this install later | `docs/UPGRADING.md` — **read before your second deploy** |
| A second box: another worker, or another sandbox host | `docs/DEPLOY.md` — `teploy-ship join` |

## If it does not work

The four common cases are below; **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**
is the consolidated operator guide (worker holds, store blips, known_hosts,
sandbox TTLs, firewall ports).

**The run sits in `waiting`.** It parked on an approval. `teploy-ship explain
<run-id>` names what it asked for; approve from the dashboard or with
`teploy-ship approve <run-id>`.

**The run never starts.** `teploy-ship explain <run-id>` says whether any
worker is alive. Two causes: the worker is up but cannot reach its store
(`docker logs ship-worker-<sha>` shows `tick failed (store unreachable?)` — a
worker unsure of its policy launches nothing, deliberately), or the worker
exits at boot and docker restarts it forever (`docker ps -a` shows
`Restarting`; the log names the check, usually `a sandbox URL is set but no
token`).

**"repository not allowed".** `SHIP_REPO_ALLOWLIST` does not cover the origin
you passed. This is the guard working, not a bug.

**The pull request has no Verification section.** A worker wired for none of the
evidence legs adds nothing to the body rather than printing "not tested, not
deployed, not measured" — that would train you to skip the section that
sometimes carries the real thing. Check `SHIP_TESTS=1`, and that the repo has a
command: detection needs one of `package.json` `scripts.test`, a Makefile
`test:` target, `go.mod`, `Cargo.toml` or pytest config at the root, otherwise
set one on the Projects page.

The installer builds from `teploy.example.yml` in a private temporary context,
then applies its generated `teploy.install.yml`. It does not inherit the
maintainer's production mounts, preview destinations, or integration settings.
The temporary context is removed when the installer exits. Re-run the installer
to update that installation; do not run `teploy deploy -d install` against the
repository's maintainer configuration. The manual path uses the example as your
own `teploy.yml`.
