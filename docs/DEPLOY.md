# Self-hosting Teploy Ship

Issues in, pull requests out, on your own box. One `teploy deploy` from
this repo brings up the dashboard, the worker, and a Nucleus store; the
optional gateway and sandbox daemon complete the production shape.

> **Setting Ship up for the first time?** [QUICKSTART.md](QUICKSTART.md) is the
> ten-minute path; this document is the complete model behind it.
>
> **Upgrading an install that already exists?** See
> [UPGRADING.md](UPGRADING.md). Migrations are forward-only and a durable run
> enqueued under old code is replayed under the new one — both have rules.

## What runs where

| Piece | What | How it deploys |
|---|---|---|
| `ship` (web + worker) | dashboard/webhooks + the durable agent executor | `teploy deploy` from this repo (server-side image build) |
| `ship-nucleus` | durable runs, intake, spend, code index | accessory in `teploy.yml` (automatic) |
| `ship-gateway` | BYO-model AI gateway; provider keys never reach ship | `teploy deploy` from `../teploy-gateway` (optional but recommended) |
| `teploy-sandbox` | per-run containers with default-deny egress | systemd service on the host (see below) |
| sandbox images | what a run's container boots | `images/build.sh` on the server (see [Sandbox images](#sandbox-images)) |

## 1. Bring-up

### The one-command path

```sh
./install.sh --host 203.0.113.10 --user root mybox
```

That provisions the server, generates the three secrets nobody should be
copying between installs, asks for the two only you can supply (a forge token
and a model key), builds the sandbox images **on the server**, builds Ship, and
deploys. Roughly ten minutes on a cold box, most of it the sandbox image.

It writes two files, both gitignored: `ship-secrets.env` (mode 0600, real
values) and `teploy.install.yml` (a teploy destination overlay carrying your
server name and the env this box needs). The tracked `teploy.yml` is never
edited — its `env:` block points at the author's own gateway and Observe
instance, and the overlay blanks those.

**Moving to a second host.** Ship's secrets live in teploy's age store *on the
server*: `teploy secret list` opens an ssh connection to read them, so an
install used to have exactly one copy of its own credentials and no way to
stand a second box up from them. That is now two commands:

```sh
./install.sh --export-secrets ship.env --host <old-ip> --user <u> oldbox
./install.sh --secrets-file  ship.env --host <new-ip> --user <u> newbox
```

`ship.env` holds real values. It is chmod 600, gitignored, excluded from the
teploy build context, and yours to delete once the new box is up.

### The manual path

Prereqs on your machine: the `teploy` CLI pointed at your server
(`servers.yml`), Node 22, pnpm, and Docker. The deployment image installs its
Neutron SDK dependencies from the public npm registry.

```sh
# build what the image copies in
pnpm run build && (cd web && pnpm run build)

# secrets (once; injected into web + worker on every deploy)
teploy secret set SHIP_WEB_TOKEN=<dashboard login/bearer>
teploy secret set SHIP_SESSION_SECRET=<signs dashboard sessions>
teploy secret set SHIP_WEBHOOK_SECRET=<webhook HMAC>
teploy secret set SHIP_GIT_TOKEN=<forgejo/gitea deploy token>
teploy secret set SHIP_GITHUB_TOKEN=<github token>        # only for github.com repos
teploy secret set AI_GATEWAY_KEY=<key from teploy-gateway>  # or ANTHROPIC_API_KEY directly

teploy deploy
```

The dashboard is at `<server>:7460` (`ingress: host` — firewall it to
your VPN/tailnet, e.g. `ufw allow from 100.64.0.0/10 to any port 7460`).
Log in with `SHIP_WEB_TOKEN`, then add named accounts (below) so people
stop sharing it.

## 1b. Accounts and roles

`SHIP_WEB_TOKEN` stays valid as an admin master credential and as the API
bearer, but the dashboard is multi-user: named accounts with the canonical
Teploy roles.

| Role | Can |
|---|---|
| `admin` | everything, including managing accounts |
| `editor` | start runs, approve/deny parked runs, change settings |
| `viewer` | read-only |

Create accounts in Settings → Users (Account has self-service password
change). Passwords are scrypt-hashed; sessions are stateless signed
cookies and a local user's role is re-read from the store on every
request, so a demotion takes effect immediately.

### Single sign-on (OIDC)

Optional and off by default. Set `SHIP_OIDC_ISSUER` and
`SHIP_OIDC_CLIENT_ID` and the login page offers an SSO button; Ship acts
as an OpenID Connect relying party (authorization code + PKCE). Password
login stays available as the break-glass path. Register
`https://<your-ship-host>/oidc/callback` as the redirect URI.

| Variable | Default | Description |
|---|---|---|
| `SHIP_OIDC_ISSUER` | _(none)_ | IdP issuer URL (discovery base). Required to enable SSO. |
| `SHIP_OIDC_CLIENT_ID` | _(none)_ | OAuth client ID. Required to enable SSO. |
| `SHIP_OIDC_CLIENT_SECRET` | _(none)_ | OAuth client secret. Omit for a public (PKCE-only) client. |
| `SHIP_OIDC_REDIRECT_URL` | _(derived)_ | Callback URL. Derived from the request Host when unset; set it explicitly behind a proxy that rewrites Host. Must be `.../oidc/callback`. |
| `SHIP_OIDC_SCOPES` | `openid profile email` | Space/comma-separated scopes (`openid` is always included). Add `groups` for group-based role mapping. |
| `SHIP_OIDC_LABEL` | `Single sign-on` | Text on the SSO button. |
| `SHIP_OIDC_USERNAME_CLAIM` | `preferred_username` | Claim used as the username (falls back to `email`, then `sub`). |
| `SHIP_OIDC_ROLE_CLAIM` | `teploy_role` | Claim carrying the role directly (`admin`/`editor`/`viewer`). Checked first. |
| `SHIP_OIDC_GROUPS_CLAIM` | `groups` | Claim listing the user's groups, used when no direct role claim matches. |
| `SHIP_OIDC_ADMIN_GROUP` | _(none)_ | Group whose members become `admin`. |
| `SHIP_OIDC_EDITOR_GROUP` | _(none)_ | Group whose members become `editor`. |
| `SHIP_OIDC_VIEWER_GROUP` | _(none)_ | Group whose members become `viewer`. |
| `SHIP_OIDC_DEFAULT_ROLE` | `viewer` | Role for an authenticated user matching no role claim or group (least privilege). |

### Telling Ship its public address

Ship derives the origin it was reached on to build the OIDC redirect URI and
to decide whether session cookies get the `Secure` attribute.

`X-Forwarded-Proto` and `X-Forwarded-Host` are only believed when
`SHIP_TRUST_PROXY` is set — the shipped `teploy.yml` uses `ingress: host`, so
the web process is published straight at `<server-ip>:7460` with nothing in
front of it, and those headers are whatever the caller typed. Left untrusted,
`X-Forwarded-Proto: http` from any client would be enough to have session
cookies minted without `Secure`.

| Variable | Default | Description |
|---|---|---|
| `SHIP_PUBLIC_URL` | _(none)_ | The external URL Ship is reached at, e.g. `https://ship.example.com`. Authoritative when set — use this behind a proxy in preference to `SHIP_TRUST_PROXY`. Also makes run links in notifications clickable and shows full webhook URLs on `/sources`. |
| `SHIP_TRUST_PROXY` | _(unset)_ | Set to `1` to believe `X-Forwarded-Proto`/`X-Forwarded-Host`. Only set this when a reverse proxy you control is the sole path to Ship. |

If you terminate TLS at a proxy, set one of these — otherwise Ship sees a
plain-HTTP request and will not mark the session cookie `Secure`.

Role resolution order: a recognized `teploy_role` claim wins; otherwise
groups are matched (admin > editor > viewer); otherwise the default role.
SSO users are not stored locally — their role comes fresh from the IdP on
every login, so manage them in your IdP.

### Self-hosted identity providers

Any OIDC provider works. Two are worth calling out because if you already
run Teploy you probably already run one of them, so SSO costs you no new
software.

**Forgejo** (or Gitea) is a full OIDC provider. Its discovery document
advertises `openid profile email groups` and a `groups` claim.

1. Register an OAuth2 application — Site Administration → Applications for
   an org-wide one, or user Settings → Applications for a personal one.
   Set the redirect URI to `https://<your-ship-host>/oidc/callback`.
2. Point Ship at it:

```sh
teploy secret set SHIP_OIDC_ISSUER=https://forgejo.example.com
teploy secret set SHIP_OIDC_CLIENT_ID=<client id>
teploy secret set SHIP_OIDC_CLIENT_SECRET=<client secret>
teploy secret set SHIP_OIDC_SCOPES="openid profile email groups"
teploy secret set SHIP_OIDC_ADMIN_GROUP=platform:owners
teploy secret set SHIP_OIDC_EDITOR_GROUP=platform:deployers
```

- Request `groups` explicitly. It is not in the default scopes, and
  without it no group matches, so every user lands on
  `SHIP_OIDC_DEFAULT_ROLE`.
- Forgejo emits one entry per org (`platform`) and one per team
  (`platform:deployers`). Group comparison is exact and case-sensitive,
  so copy the names as Forgejo spells them.
- Forgejo cannot mint a custom claim, so leave `ROLE_CLAIM` at its
  default and map roles by group.
- Each dashboard needs its own OAuth2 application because the redirect
  URIs differ, but Dash, Observe, and Ship can all map against the same
  orgs and teams.

**OpenBao** also serves OIDC (`identity/oidc/provider`), which is
convenient if you already run it for `teploy secret --provider openbao`.
Create a provider, an assignment, and a client, then use the provider's
discovery URL as the issuer:

```sh
teploy secret set SHIP_OIDC_ISSUER=https://openbao.example.com/v1/identity/oidc/provider/teploy
```

Map roles with a scope template that emits a `groups` array (matched as
above), or one that emits a `teploy_role` string — OpenBao can produce a
custom claim, so the direct role claim is available here and takes
precedence over groups.

## 2. Connect a source

Add a webhook on the repo (or org):

- URL: `http://<server>:7460/hooks/forgejo` or `/hooks/github`
- Secret: the `SHIP_WEBHOOK_SECRET` value (Forgejo: HMAC signature;
  GitHub: `X-Hub-Signature-256`)
- Events: issues, issue comments, **pull request reviews**, **pull request
  review comments**, labels
  - GitHub: `issues`, `issue_comment`, `pull_request_review`,
    `pull_request_review_comment`, `label`
  - Forgejo/Gitea: `issues`, `issue_comment`, `pull_request_comment`,
    `pull_request_review`, `pull_request_review_comment`, `pull_request_label`
    (Forgejo splits an approval out under `pull_request_review_approved` /
    `_rejected`; subscribing to all of them is harmless — Ship drops
    approvals, since an approval is not a request for work)

Then label an issue **`ship`**. Unlabeled events are ignored — the label
is the opt-in. The issue appears in the dashboard inbox as a *proposed*
task; Launch it, or flip the source to **auto** on the Sources page.
Auto is bounded three ways: a daily launch cap, a concurrency ceiling,
and a per-source daily spend budget (`SHIP_DAILY_BUDGET_USD`).

### PR review loop

Any non-`[teploy-ship]` comment, review, or inline review comment on a
followable PR proposes a follow-up task; the run checks out the PR
branch, addresses the feedback, pushes, and replies.

**Followable** means either of:

- the PR carries the `ship` label (exact, case-sensitive), or
- the PR's head branch starts with `ship/` **and lives in the same
  repository** — which is every PR Ship opens, so Ship's own PRs need no
  human labelling.

The same-repository half is not optional. Anyone may open a pull request
from a *fork* whose branch is named `ship/anything`; without that clause
an outsider could self-authorise an agent run driven by their own comment
text, holding the repository's git token. Labelling a fork PR `ship` is
still a deliberate maintainer action and still works.

A batched review ("Request changes" with N inline notes) is delivered as
**N+1 webhooks** — one review plus one per note. Ship coalesces them onto
a single task keyed on the review, so three inline comments produce one
run and one push, not four. An inline comment carries its file, line,
diff side and diff hunk into the task, so the agent gets an address and
not just a complaint.

### Slack and Linear

- **Slack**: create an app with an `app_mention` event subscription
  pointed at `/hooks/slack`, set `SHIP_SLACK_SIGNING_SECRET` (the app's
  signing secret), and invite the bot. `@ship fix the flaky test
  repo:https://…` proposes a task (the `repo:` token binds it to a
  repository; without one it's a workspace task).
- **Linear**: add a webhook for Issue events at `/hooks/linear` with
  `SHIP_LINEAR_SIGNING_SECRET`. Issues labeled `ship` become tasks;
  put `repo:<clone-url>` in the description to bind a repository.
- **Notifications**: set `SHIP_SLACK_WEBHOOK_URL` (an incoming-webhook
  URL) and `SHIP_PUBLIC_URL` — Ship pings the channel when a run parks
  for approval/plan review and when it completes or fails, with a link.

### Connecting Ship to Akiroo

Akiroo is a workspace; Ship is the thing that does the work. The hop
between them runs in **one direction only: Ship pulls.**

Set two variables on the **worker** (both or neither):

```
AKIROO_URL=https://lite.akiroo.com
AKIROO_PULL_TOKEN=ship_pull_…
```

Mint the token once, in Akiroo, under **Settings, Connections, Teploy
Ship, Handing over work**. It is shown exactly once and only ever
compared thereafter; rotating it stops the old one immediately.

**Ship needs only outbound HTTPS. No inbound port, no tunnel, no public
URL, no DNS record.** That is the point of the direction: a worker on a
VPS behind Tailscale, or on a laptop, participates fully. It also means
**Akiroo never holds a forge token** — Ship, which already has the
credential it opens pull requests with, is the one that creates the
issue.

What flows, both ways:

- Someone presses **Send to Ship** on an Akiroo work item. Ship collects
  it on its next sweep (the intake interval, default 5s), opens a
  `ship`-labelled issue on the project's repository, and proposes it —
  under the same dedupe key the forge webhook uses, so the two collapse
  into one task whether or not that repo has a webhook configured.
- The run's outcome goes back as a signed run event (set `SHIP_NOTIFY_URL`
  to Akiroo's `/api/webhooks/teploy_ship/<org>` and `SHIP_NOTIFY_SECRET`
  to that connection's inbound secret). A pull request moves the work item
  to **review** with the link; a failure moves it to **blocked** with the
  reason.
- Approving or denying a **parked run** from Akiroo's queue also travels
  by pull: if Akiroo has no reachable Ship URL configured — the normal
  case — it queues the decision and Ship collects it. A Ship that *does*
  have a public URL gets the decision pushed directly and nothing is
  queued.

Health check with no logs: if Akiroo's Connections card shows queued work
and **Last collected** is not moving, this worker is not polling. Check
the two variables above and that the worker process is up.

### CI auto-fix

Subscribe the repo's webhook to **workflow run** events (same endpoint,
same secret). A failed CI run on one of Ship's own PRs (head branch
`ship/…`) proposes a review task carrying the failure context; the run
reproduces the failure, fixes it on the PR branch, and pushes — deduped
per failing SHA, so one red check is one fix attempt.

## 3. Sandbox (required for tasks that arrive from outside)

The worker starts without one and warns. What it will not do is execute a
task that came from a webhook, a chat message, or an issue body — those
runs fail with the reason on the run.

The approval policy is a list of command regexes, which is a useful prompt
and not a boundary: the same effects are one `node -e`, `nc`, `find -delete`
or `getattr(os, "sys"+"tem")` away, and the agent writes the commands. On
the local executor the blast radius is the host and everything the worker
can reach. So untrusted work needs isolation — but the check belongs on the
run rather than on the process, because a worker that refuses to boot is a
worker whose operator sets the override and never revisits it.

Runs you launch yourself (`teploy-ship run`, `teploy-ship fix`, the
dashboard's new-run form) work unsandboxed. That is a person choosing to
trust their own machine. `SHIP_ALLOW_UNSANDBOXED_INTAKE=1` extends that to
external tasks on a genuinely disposable box.

### The audit trail

`teploy-ship audit` exports the run history as CSV or JSON — what ran, when,
from which intake source, **who asked for it**, **who approved it**, on which
worker, against which repository, what it cost, and what pull request it
opened.

```sh
teploy-ship audit --since 2026-08-01T00:00:00Z --format csv > runs.csv
```

Three columns carry the attribution, and the second is the one people skip:

| column | what it is |
|---|---|
| `actor` | stable id of whoever asked for the run |
| `actorKind` | how that identity was established — `user`, `cli`, `intake`, `unknown` |
| `approvedBy` | stable ids of everyone who granted an approval, in order |

**`actorKind` is not decoration, it is how much the name is worth.**

- `user` — an authenticated dashboard session. For SSO the id is `issuer#sub`,
  never the username, so the row keeps pointing at the *person* after a rename.
- `cli` — `user@host`, attested by the operating system of the machine the
  command ran on. A real operator, vouched for by their box rather than by Ship.
- `intake` — a handle a webhook payload asserted. The delivery signature proves
  the payload came from your forge; it does **not** prove the forge is honest
  about who wrote the issue. Trustworthy to the same degree your forge is.
- `unknown` — nobody could be named. Runs enqueued before attribution existed,
  and CI-triggered runs, where a machine asked and naming the pusher would put a
  real person on a run they never authorised.

`attributable` is `false` for exactly the `unknown` case, so a reader wanting
only accountable actions filters on one column. The footer of a human-readable
export counts them (`3 of 40 name nobody`) rather than printing a blanket
caveat.

**What it still is not:** proof. Ship records who a surface said was acting; it
does not re-verify a webhook's claim about authorship. An auditor should be told
what `actorKind` means, and `intake` rows are as good as the forge that sent
them — no better.

Retention is your storage's, not Ship's: the export reads the same durable
event logs the runs are made of, and nothing prunes them.

Attribution lives on the run's **metadata**, never in the recorded workflow
input. That is deliberate: every field in the input gates which steps a replay
expects, so putting the actor there would change how in-flight runs replay. You
can turn attribution on with runs already in the queue.

### Evidence on a `fix` pull request

`teploy-ship fix` runs the live loop with its own inline publish, so for a
while none of the verification chain was reachable from it: its pull request
body was the agent's summary and nothing else — the agent's own account of its
own work, which is the claim the finish gate exists because models get wrong.

It now attaches the same Verification section the worker does, from the same
code, using the same variables:

| piece | when it runs on `fix` |
|---|---|
| tests | `--tests`, or `SHIP_TESTS=1` — plus `SHIP_TEST_COMMAND`. Run before the push, like the worker. |
| telemetry | whenever the three `OBSERVE_*` variables are set. A read is safe, so configuration is the ask. |
| preview | **`--preview` or `SHIP_PREVIEW=1` AND `SHIP_PREVIEW_DIR`.** Both, deliberately. |

The preview needs the explicit ask because it is the only one that changes the
world: it shells the `teploy` CLI with credentials that reach real servers, and
`fix` typically runs on a laptop where a stale `SHIP_PREVIEW_DIR` should not
quietly deploy anything.

None of it can fail the run — the fix is pushed and the PR is open before any
of this starts. And a surface wired for none of it adds *nothing* to the body,
rather than printing "not deployed, not measured, not tested" on every pull
request, which would train a reviewer to skip the section that sometimes
carries the real thing.

The sandbox daemon gives every run its own container with **default-deny
egress** — an internal bridge with no route out, plus an allowlist proxy
(package registries + GitHub built in) on the bridge gateway.

```sh
# on the server
install -m 0755 teploy-sandbox /usr/local/bin/
systemctl enable --now teploy-sandbox     # unit: serve --addr 0.0.0.0:7439
ufw allow from 172.18.0.0/16 to any port 7439 proto tcp   # teploy app net → daemon
ufw allow from 172.31.99.0/24 to any port 7443 proto tcp  # sandbox net → egress proxy
```

Extend the egress allowlist per host (your git server!) via the unit env:
`SBX_EGRESS_ALLOW=git.internal:3000,.mycorp.dev` — entries are `host`,
`.suffix`, or `host:port`; portless entries open only 80/443.

Point ship at it (in `teploy.yml` env or secrets):
`SHIP_SANDBOX_URL=http://172.18.0.1:7439`, `SHIP_SANDBOX_TOKEN=<token
from /var/lib/teploy-sandbox/token>`, `SHIP_SANDBOX_IMAGE=ship-sandbox-go:dev`
(pick your stack), `SHIP_SANDBOX_NETWORK=egress`. That image is the
worker-wide default: a repo's project record (dashboard Projects page, or
`teploy-ship project set <repo> --image ship-sandbox-node:dev --network egress`)
overrides the image, network and limits for that repo's runs.

<a id="sandbox-images"></a>
### Sandbox images

`images/` is where a run's container comes from. `install.sh` builds them for
you; to build or rebuild by hand, **on the server** (the images must exist on
the machine whose docker daemon creates run containers):

```sh
images/build.sh                       # go + node, every harness baked, :dev
images/build.sh go                    # just the Go image
images/build.sh --harness none node   # a plain pnpm sandbox, native runs only
images/build.sh --tag v3 --harness claude-code go
```

| Image | Carries |
|---|---|
| `ship-sandbox-go:<tag>` | Go 1.25, node 22 + npm, git, python3, plus the declared harnesses |
| `ship-sandbox-node:<tag>` | node 22, pnpm (pinned), build-essential, git, plus the declared harnesses |
| `ship-sandbox-harness:<tag>` | alias of `ship-sandbox-go` when harnesses were baked — the name existing workers already carry |

Every version is pinned in `images/versions.json`: base images by digest, the
harness binaries by exact npm version. That file is the single source of truth
— `src/harness.ts:HARNESS_PACKAGES` mirrors it and a test fails when they
drift, and `build.sh` refuses to build if a Dockerfile's `ARG` default has
wandered off.

**Go is pinned to 1.25, not 1.24.** Three repos need 1.25, and on a 1.24
sandbox every Go pull request arrived marked `tests: failed` on 2026-08-26 — a
base-image mismatch that reviewers read as the agent's fault, and it cost a
day. Do not pin it back; a test enforces this.

### Harnesses: declare, then bake

A harness is the program that edits the tree — `native` (Ship's own loop, which
needs nothing installed), `claude-code`, or `opencode`.

Declaring one and installing one are separate acts, deliberately:

- **Declare** on the project record — the Projects page's *harness* field, or
  the worker-wide `SHIP_HARNESS`. `enqueueRun` resolves it to an id + contract
  version and records it in the run input.
- **Bake** into the image with `images/build.sh --harness <id>`.

Nothing installs a harness at run time, and it is not an oversight. A run-time
install needs the sandbox to reach npm — the egress hole default-deny exists to
close — and it lets the binary drift under a running worker. `selectAdapter`
(`src/harness.ts`) refuses to replay a run under a harness version other than
the one its log recorded, so drift does not merely change behaviour, it makes
old runs unreplayable.

A run whose declared harness is missing from its image records a
`harness-preflight` step that says so, names the build command, and ends the
run without spending anything.

<a id="test-detect"></a>
### Detecting the test command

A repo used to owe Ship a `teploy-ship evidence set <repo> --test-command …`
before a single pull request could carry a suite result, and the worker-wide
`SHIP_TEST_COMMAND` is by construction wrong for every repo but the one it was
written for. So when a repo has no explicit command, Ship reads its root **at
enqueue** and infers one:

| Signal | Command |
|---|---|
| `package.json` with a real `scripts.test` | `<pm> install… && <pm> test` — pnpm/yarn/bun/npm from `packageManager` or the lockfile |
| a `Makefile` with a `test:` target | `make test` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |
| pytest config (`[tool.pytest…]`, `pytest.ini`, `conftest.py`, `tox.ini`) | `python3 -m pytest -q` |

Notes that matter:

- **An explicit entry always wins.** The Projects page's *test command* field
  and `teploy-ship evidence set` both still do exactly what they did.
- **The JS commands include the install.** The suite runs in a container over a
  fresh clone, so `pnpm test` with no `node_modules` would report FAILED for a
  suite that never executed.
- **npm's placeholder is not a suite.** A `scripts.test` that is still
  `echo "Error: no test specified"` falls through to the next signal.
- **It happens at enqueue, never at execution.** Evidence is materialised into
  the run input so a replay runs the command the log was written under. Reading
  the tree at execution time would let a repo change between enqueue and replay
  and silently run a different suite.
- **It reads the forge API, not a clone** — one root listing plus at most three
  small files, against an origin the allowlist names. An origin the allowlist
  does not name is not contacted at all, authenticated or otherwise.
- **A wrong guess is bounded.** With `SHIP_TESTS_FEEDBACK` on (the default),
  the same command runs as a baseline *before* the agent edits anything, so a
  command the sandbox cannot run is reported as pre-existing breakage rather
  than blamed on the run.
- Detection is memoised per repo for ten minutes so a webhook burst is not four
  forge round trips per event.

## 4. Codebase indexing (optional)

Give the agent semantic code search: any OpenAI-compatible
`/v1/embeddings` endpoint works. The gateway proxies one — its
`teploy.yml` ships an Ollama accessory:

```sh
# once, on the gateway box
docker exec ship-gateway-ollama ollama pull nomic-embed-text
```

Then set `SHIP_EMBED_MODEL: ollama/nomic-embed-text` in ship's env
(SHIP_EMBED_URL/_KEY default to the gateway settings). Repo runs index
the clone incrementally (file-hash diff) into Nucleus vectors and the
agent gets a ```search action.

## 5. Security model (what protects what)

- **Label gate**: only `ship`-labeled issues/PRs ever become tasks;
  webhooks are HMAC-verified.
- **Approvals**: destructive/network/privilege actions park the run for
  a human decision (dashboard or CLI); plan-preview (`--plan` / the
  "plan first" checkbox) parks before anything runs at all.
- **Injection defense**: external task text is framed as
  data-not-instructions; matched injection patterns surface as an
  `injection-guard` step on the run timeline.
- **Egress**: sandbox runs can only reach allowlisted hosts; everything
  else has no route.
- **Secrets**: agent commands never see operator env secrets (scrubbed
  on local executors, absent in sandboxes); git tokens are used
  harness-side only and are picked per host (Forgejo vs GitHub).
- **Spend**: per-source daily budgets + global concurrency caps.

## Day-2

- `teploy deploy` redeploys; secrets persist. Run state lives in
  Nucleus (accessory volume) — containers are disposable.
- `teploy accessory upgrade nucleus ghcr.io/neutron-build/nucleus:latest`
  picks up engine updates.
- CI runs on Forgejo Actions (`.forgejo/workflows/ci.yml`) with a
  sibling-Neutron checkout — register any docker-labeled runner.

## Security-relevant settings

These have defaults that are safe but restrictive; the first is the one a
new deployment actually has to set.

| Variable | Default | What it does |
|---|---|---|
| `SHIP_GIT_TOKENS` | unset | JSON of origin → token: `{"https://github.com":"ghp_…","https://git.example.com":"…"}`. **This is the recommended way to configure credentials**, and it doubles as the allowlist — naming an origin here says Ship may talk to it, so there is no second variable to remember. |
| `SHIP_REPO_ALLOWLIST` | derived from `SHIP_GIT_TOKENS` | Only needed when you use the origin-less `SHIP_GIT_TOKEN`, which has no host attached and would otherwise go wherever a URL says. Comma-separated, and can be narrower than an origin: `https://github.com/your-org`. |
| `SHIP_ALLOW_UNSANDBOXED_INTAKE` | unset | Lets externally-sourced tasks run without a sandbox. Only for a disposable box. |
| `SHIP_MODEL_PRICING` | unset | JSON of model → rates for a model Ship does not ship a price for: `{"my-model":{"inputPer1M":2,"outputPer1M":8}}`. Without it an unrecognised **hosted** model is charged the highest known rate so the spend cap cannot fail open. |
| `SHIP_LOCAL_MODEL_PREFIXES` | `ollama/ local/ lmstudio/ vllm/ …` | Model prefixes that run on your own hardware and therefore cost nothing. Extend if your local runtime uses a different prefix. |
| `SHIP_REQUIRE_EDIT` | **on** | Hold a finish declared over an unchanged tree, bounded at two holds, on the **durable** path — the one a webhook launches. On by default since 2026-08-20, because without it a production run can finish "fixed" having written nothing and open a pull request that says so. Set to `0` to turn it off. A run that takes the hold and still has not edited eight turns later ends there rather than running to the step cap. Only newly-enqueued runs are affected: the flag is written into the run input, so anything already enqueued replays exactly as it was recorded. See `docs/MODELS.md` §3. |
| `SHIP_PREVIEW` | unset | Ask every newly-enqueued run to deploy its branch to a preview environment and link the URL on the pull request. Per-run, and only the request — whether a preview can happen is `SHIP_PREVIEW_DIR` below. |
| `SHIP_PREVIEW_DIR` | unset | **The switch.** A clone **of the repository being fixed**, on the WORKER host, containing the app's `teploy.yml`. Ship fetches the run's branch into a detached `git worktree` beside it and builds THERE — building in the directory itself would deploy whatever commit it happens to sit on and label it as the fix. Your checkout is never moved and the worktree is always removed. Deploy credentials stay on the worker — they are never placed in the agent's sandbox, which executes model-authored commands. Without this a run that asked for a preview records the step as disabled. |
| `SHIP_PREVIEW_BIN` | `teploy` | Path to the CLI. Needs a CLI with `teploy build`, released in **v0.1.27**; older binaries can only produce an image by deploying to production, which is exactly what a preview must not do. **The container image ships it** (`ARG TEPLOY_VERSION`, checksum-verified at build, both arches) — set this only to point at a different binary. |
| `SHIP_PREVIEW_TTL` | `24h` | Passed to `teploy preview deploy --ttl`. The CLI prunes expired previews on the next preview deploy for that app. |
| `SHIP_PREVIEW_DESTINATION` | unset | Destination overlay (`-d staging`), applied to every command so a preview cannot land on the wrong server. |
| `SHIP_PREVIEW_TIMEOUT_MS` | `900000` | Per-command ceiling. The server-side image build is the slow step. |

**Running a preview from the container image.** The image carries the `teploy`
binary, so the remaining two things a preview needs are the ones that cannot be
baked in — mount both into the worker:

```
-v /srv/app-clone:/srv/app-clone          # SHIP_PREVIEW_DIR: a clone OF THE REPO BEING FIXED,
                                          #   containing its teploy.yml
-v /root/.ssh:/home/node/.ssh:ro          # the deploy key and known_hosts
```

The CLI speaks SSH through Go's `crypto/ssh` rather than shelling out, so
`openssh-client` is not needed — but it **fails closed** on an unreadable
`known_hosts`, so that file has to be there and readable by uid 1000 (`node`).
Deploy credentials stay on the worker and never enter the agent's sandbox,
which executes model-authored commands.
| `SHIP_MAX_CONCURRENT_RUNS` | unset — **derived** | An override, not the mechanism. Left unset, each worker measures its own box (cores, `MemTotal`/`MemAvailable`, free space and inodes on the docker root) and derives its slot count every 15 s — so adding a VM raises the fleet's capacity and a squeeze lowers it with nobody touching a knob. Set it and this number wins outright; the Fleet page then says `set by hand, not measured` instead of naming a binding constraint. `--max-concurrent` is the same override on the command line. See the derivation in `docs/capacity.md`. |
| `SHIP_MIN_FREE_MB` | `600` | Load-aware admission: a worker launches no run while the host has less than this much available memory (`MemAvailable`), however many slots are free. One run plus headroom, from the measured ~350–400 MB per in-flight run (`docs/capacity.md`). Due runs wait; nothing is dropped. `0` disables. |
| `SHIP_MAX_LOAD_PER_CPU` | `1.5` | Same, for the 1-minute load average divided by CPU count. The Fleet page shows a held worker and why. `0` disables. |
| `SHIP_MIN_FREE_DISK_MB` | `2048` | Same, for free bytes on the docker root. Checked **ahead of** memory: running out of memory delays work and the kernel resolves it, while running out of disk breaks the docker daemon for every tenant on the box and needs a human. Sized as one run's clone + module/build cache plus the same again as headroom; the sandbox image is not in it (pulled once, already on disk). `0` disables. |
| `SHIP_MAX_INODE_USED_PCT` | `95` | Same, for inodes. Its own knob because it fails independently: a module cache is millions of tiny files, so a box can exhaust inodes with tens of GB of bytes still free and every write still fails. A filesystem with no inode accounting (btrfs) reads as no pressure. `0` disables. |
| `SHIP_DISK_PATH` | unset — `/var/lib/docker`, then `/` | Which mount to measure, when docker's data root is on neither. A worker in a container has no `/var/lib/docker`; its own `/` is an overlayfs whose `statfs` reports the underlying filesystem, which is the host's docker root anyway — so the fallback is usually right and this is rarely needed. |
| `SHIP_SANDBOX_TTL_SEC` | `7200` | Container TTL Ship requests from the sandbox daemon for each run (floor 600). The daemon's own default is 30 minutes, which is shorter than a real run on a large repository — that is how four runs were reaped before their first command on 2026-08-25. The run's own caps end it; this is the backstop for a worker that dies mid-run. |
| `SHIP_INDEX_TIMEOUT_MS` | `120000` | Time budget for the `repo-index` step. Past it the refresh stops between files, keeps what it embedded, and the step records `stopped at the 120s index cap`; ```search still works over whatever is indexed. |
| `SHIP_TESTS` | unset | Ask every newly-enqueued run to execute its test suite after the agent stops, and put the result on the pull request. Ship runs it — the agent's own account of its testing is not used. Which command, in order: the repo's explicit entry, else what Ship detected from the repo's tree, else `SHIP_TEST_COMMAND`. |
| `SHIP_TEST_COMMAND` | unset | The worker-wide **last-resort** suite, e.g. `pnpm test`. Used only for a repo with no explicit entry *and* nothing detectable. Run in the run's workspace **before** the push, so "tests passed" describes the code that becomes the PR. Without any of the three, a run that asked for tests records the step as disabled. |
| `SHIP_TEST_DETECT` | on | Read the repo's root at enqueue and infer its suite (`0` turns it off). See [Detecting the test command](#test-detect). |
| `SHIP_TEST_TIMEOUT_MS` | `900000` | Ceiling. A suite that hits it is reported as **not run**, never as failed — a killed suite did not fail, it never finished. |
| `SHIP_TELEMETRY` | unset | Ask every newly-enqueued run to read the affected service's error rate and latency around its change and put the numbers on the pull request. Needs the three `OBSERVE_*` reads below. |
| `OBSERVE_READ_TOKEN` | unset | An Observe **share token** (`X-Share-Token`), not the ingest key. Share tokens are GET-only, pinned server-side to their own site, long-lived and revocable — the only credential in Observe a worker can hold. Mint one from the site's share menu; revoke it to take the worker's read access away. Requires an Observe with share-token auth on `/api/v1/traces/services`, released in **v0.1.8**. Proven live 2026-08-20. |
| `OBSERVE_SERVICE` | unset | The service name as it appears in traces. Without it there is nothing to look up and the read stays off. |
| `OBSERVE_REPO` | unset | **Required, and the leg is off without it.** The repository `OBSERVE_SERVICE` is built from, e.g. `tyler/fylun-web`. A run on any other repo records the telemetry step as disabled and reads nothing. Learned live on 2026-08-21: a worker watching `fylun-web` reported its RED metrics on a pull request that changed one line of Go in an unrelated repo, so the reviewer saw "p95 up 2653ms" under a change that could not have caused it. `OBSERVE_MIN_REQUESTS` guards against too *little* data; this guards against data about the wrong *thing*, which is worse because it reads as a finding rather than as noise. Matched on owner/name, so clone URLs and bare slugs all agree. |
| `OBSERVE_WINDOW_MINUTES` | `30` | Length of each comparison window. Two adjacent windows ending now. |
| `OBSERVE_MIN_REQUESTS` | `20` | Requests needed **in each window** before a comparison is reported at all. Below it the PR says "not enough data to compare" and shows the raw counts. Lower it only if you want verdicts computed off a handful of requests. |
| `SHIP_MAX_RUN_COST_USD` | `0` (off) | Hard per-run ceiling. Turn count is a poor proxy for cost; this bounds one pathological run rather than waiting for the daily cap to notice. |
| `SHIP_ESTIMATED_RUN_COST_USD` | `0.50` | Held against a source's daily budget while a run is in flight, so a burst of launches cannot all pass the same budget read. |
| `SHIP_DAILY_AUTO_LIMIT` | `10` | Auto-launches per source per day, **fleet-wide** (it used to be per worker). |
| `SHIP_PUBLISH_MAX_FILES` | `200` | Above this, the PR is raised as a **draft** explaining why — not refused, because a big diff can be a real refactor and only a human knows. Also `SHIP_PUBLISH_MAX_ADDED_LINES` (20000), `SHIP_PUBLISH_MAX_FILE_BYTES` (2 MiB), and binaries. What *is* refused: key material, `.env`/`.ssh`/`.npmrc`-style paths, symlinks, and submodule pointers — none of which can be un-published. |
| `SHIP_PUBLISH_HARD_MAX_FILES` | unset | The blast-radius cap: above this many files the push is **refused outright** — the refusal is a recorded step and the work stays in the run's log. Unset by default; set it lower than the draft limit above when the worker runs unattended against real repositories. |
| `SHIP_SELFWATCH_INTERVAL_S` | `60` | The worker's self-observability pass: queue depth, worker heartbeat ages, and stuck-run detection (no recorded event for 30 min while a run is neither finished nor parked). Emitted to Observe's log ingest when `OBSERVE_URL` + `OBSERVE_API_KEY` are set (`service_name: teploy-ship`); anomalies are logged locally either way. `0` disables. Detection reports and never kills — a stuck-looking run may be a long thinking call. |
| `SHIP_WEBHOOK_MAX_BYTES` | `1048576` | Cap on a webhook body, applied **before** the signature is computed. |
| `SHIP_SESSION_SECRET` | derived from `SHIP_WEB_TOKEN` | Signs dashboard sessions. Setting it lets account sessions survive a token rotation; sessions established *with the master token* still die on rotation, so rotating remains revocation. |
| `SHIP_TRUST_PROXY` | unset | Believe `X-Forwarded-Proto`/`-Host`/`-For`. Only set it when something in front actually overwrites those headers. |

**Which model to point it at.** Any Anthropic- or OpenAI-compatible endpoint
routes, but they do not all perform alike and only some have been measured.
[`MODELS.md`](MODELS.md) records what was measured, on what sample, with what
confidence interval, and the one known cross-family limitation. Read it before
choosing a model for a production deployment.

### Getting started

The short version for a fresh install:

```sh
teploy secret set SHIP_WEB_TOKEN "$(openssl rand -hex 32)"
teploy secret set SHIP_WEBHOOK_SECRET "$(openssl rand -hex 32)"
teploy secret set SHIP_GIT_TOKENS '{"https://github.com":"ghp_your_token"}'
teploy secret set AI_GATEWAY_KEY "…"        # or ANTHROPIC_API_KEY
teploy secret set SHIP_SANDBOX_TOKEN "…"    # with SHIP_SANDBOX_URL in teploy.yml
```

That is enough. `SHIP_GIT_TOKENS` names the origins, so repository access is
scoped without a second decision, and the sandbox means webhook-sourced
tasks will actually run.

### Rotating the master credential

```sh
teploy secret set SHIP_WEB_TOKEN "$(openssl rand -hex 32)" && teploy deploy
```

Every session minted from the old token stops working immediately. Named
accounts are unaffected — their roles are re-read from the store on every
request.
