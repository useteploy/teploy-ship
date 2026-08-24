# Quickstart — first pull request in about ten minutes

This is the shortest honest path from nothing to *a pull request Ship opened,
carrying the test result that proves it*. It skips the gateway, the sandbox
daemon and webhooks — all of which are worth having and none of which you need
to see the loop work.

`docs/DEPLOY.md` is the full deployment and security model. Read it second.

**What you need before you start**

- A Linux box you can `ssh` into, with Docker. Ship brings up three containers
  (web, worker, and a Nucleus store) and idles at roughly 200 MB.
- The `teploy` CLI on your machine: `brew install useteploy/tap/teploy`.
- An Anthropic API key. Any supported model works; this uses the default.
- A git token for the repository you want Ship to work in — a Forgejo access
  token or a GitHub PAT with `repo` scope.

---

## 1. Register the server

```sh
teploy server add mybox --host 203.0.113.10 --user root   # or edit ~/.teploy/servers.yml
teploy setup -s mybox                                     # installs Docker + Caddy if absent
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

Point `teploy.yml` at your server — change `server: smoke` to `server: mybox`,
and `user:` to your ssh user.

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

Two edits to `teploy.yml` for this minimal shape:

- **Delete `AI_GATEWAY_URL`.** With it set, Ship routes model calls through
  teploy-gateway; without it, it calls Anthropic directly with the key above.
- **Set `SHIP_REPO_ALLOWLIST`** to the origins Ship may clone from, e.g.
  `https://github.com/your-org`. `SHIP_GIT_TOKEN` carries no host of its own,
  so without an allowlist a repository URL is **refused** rather than handed
  the token. That is deliberate: the URL in a webhook or an issue body is
  attacker-controlled.

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

```sh
teploy-ship enqueue "The failing test in parser_test.go describes the bug. Fix it." \
  --repo https://github.com/your-org/your-repo
```

That queues a durable run. A worker picks it up within a few seconds:

```sh
teploy-ship runs                    # what exists, and its state
teploy-ship explain <run-id>        # what happened, and what to do about it
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

```sh
teploy secret set SHIP_TESTS=1 SHIP_TEST_COMMAND="go test ./..."
teploy deploy
```

Two things to get right:

- `SHIP_TEST_COMMAND` is the worker-wide default, and must be runnable **in
  the sandbox image** (`SHIP_SANDBOX_IMAGE`, default `golang:1.24`). `pnpm
  test` against a Go image reports "not run" — correct, and useless.
- Repos with different suites get their own command, keyed by repo — the same
  worker can run `go test ./...` for one and `pnpm test` for another:

  ```sh
  teploy-ship evidence set tyler/my-go-repo --test-command "go test ./..."
  teploy-ship evidence set tyler/my-ts-repo --test-command "pnpm test"
  teploy-ship evidence set tyler/my-ts-repo --observe-service my-ts-svc  # if Observe watches it
  ```

  A repo with a `testCommand` gets its suite run even where `SHIP_TESTS` was
  never set: the config is the ask.

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

## If it does not work

**The run sits in `waiting`.** It parked on an approval. `teploy-ship explain
<run-id>` names what it asked for; approve from the dashboard or with
`teploy-ship approve <run-id>`.

**The run never starts.** The worker fails closed when it cannot reach its
store: `docker logs ship-worker-<sha>` shows `tick failed (store unreachable?)`.
A worker unsure of its policy launches nothing, deliberately.

**"repository not allowed".** `SHIP_REPO_ALLOWLIST` does not cover the origin
you passed. This is the guard working, not a bug.

**The pull request has no Verification section.** A worker wired for none of the
evidence legs adds nothing to the body rather than printing "not tested, not
deployed, not measured" — that would train you to skip the section that
sometimes carries the real thing. Check `SHIP_TESTS=1` **and**
`SHIP_TEST_COMMAND` are both set.
