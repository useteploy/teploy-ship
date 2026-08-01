# Self-hosting Teploy Ship

Issues in, pull requests out, on your own box. One `teploy deploy` from
this repo brings up the dashboard, the worker, and a Nucleus store; the
optional gateway and sandbox daemon complete the production shape.

## What runs where

| Piece | What | How it deploys |
|---|---|---|
| `ship` (web + worker) | dashboard/webhooks + the durable agent executor | `teploy deploy` from this repo (server-side image build) |
| `ship-nucleus` | durable runs, intake, spend, code index | accessory in `teploy.yml` (automatic) |
| `ship-gateway` | BYO-model AI gateway; provider keys never reach ship | `teploy deploy` from `../teploy-gateway` (optional but recommended) |
| `teploy-sandbox` | per-run containers with default-deny egress | systemd service on the host (see below) |

## 1. Bring-up

Prereqs on your machine: the `teploy` CLI pointed at your server
(`servers.yml`), Node 22, pnpm, and Docker. The deployment image installs its
Neutron SDK dependencies from the public npm registry.

```sh
# build what the image copies in
pnpm run build && (cd web && pnpm run build)

# secrets (once; injected into web + worker on every deploy)
teploy secret set SHIP_WEB_TOKEN=<dashboard login/bearer>
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
- Events: issues, issue comments (PR review loop), labels

Then label an issue **`ship`**. Unlabeled events are ignored — the label
is the opt-in. The issue appears in the dashboard inbox as a *proposed*
task; Launch it, or flip the source to **auto** on the Sources page.
Auto is bounded three ways: a daily launch cap, a concurrency ceiling,
and a per-source daily spend budget (`SHIP_DAILY_BUDGET_USD`).

PR review loop: any non-`[teploy-ship]` comment on a `ship`-labeled PR
proposes a follow-up task; the run pushes to the PR branch and replies.

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

### CI auto-fix

Subscribe the repo's webhook to **workflow run** events (same endpoint,
same secret). A failed CI run on one of Ship's own PRs (head branch
`ship/…`) proposes a review task carrying the failure context; the run
reproduces the failure, fixes it on the PR branch, and pushes — deduped
per failing SHA, so one red check is one fix attempt.

## 3. Sandbox (required for a worker)

`teploy-ship worker` refuses to start without one, and that is deliberate.
A worker exists to run work that arrived from somewhere else — a webhook, a
chat message, an issue body — and the approval policy is a list of command
regexes, not a boundary: the same effects are one `node -e`, `nc`,
`find -delete` or `getattr(os, "sys"+"tem")` away, and the agent writes the
commands. On the local executor the blast radius is the host and everything
the worker process can reach.

`SHIP_ALLOW_UNSANDBOXED_INTAKE=1` overrides it for a genuinely disposable
box. The local executor remains fine for `teploy-ship run` and
`teploy-ship fix` in your own terminal, where you are trusting your own
machine.

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
from /var/lib/teploy-sandbox/token>`, `SHIP_SANDBOX_IMAGE=golang:1.24`
(pick your stack), `SHIP_SANDBOX_NETWORK=egress`.

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
| `SHIP_REPO_ALLOWLIST` | unset | Origins Ship may clone, comma-separated (`https://github.com/your-org`, `http://100.x.y.z:49152/tyler`). A repository URL arriving from a webhook, a Slack message, or an issue body is **refused** unless it matches — otherwise a task could point Ship's deploy token at an attacker's host. An operator-typed URL is allowed when this is unset; external ones never are. |
| `SHIP_GIT_TOKENS` | unset | JSON of origin → token, so two forges stop sharing one credential: `{"https://github.com":"ghp_…","http://100.x.y.z:49152":"…"}`. Falls back to `SHIP_GITHUB_TOKEN` / `SHIP_GIT_TOKEN`. |
| `SHIP_ALLOW_UNSANDBOXED_INTAKE` | unset | Lets a worker start with no sandbox. Only for a disposable box. |
| `SHIP_MAX_RUN_COST_USD` | `0` (off) | Hard per-run ceiling. Turn count is a poor proxy for cost; this bounds one pathological run rather than waiting for the daily cap to notice. |
| `SHIP_ESTIMATED_RUN_COST_USD` | `0.50` | Held against a source's daily budget while a run is in flight, so a burst of launches cannot all pass the same budget read. |
| `SHIP_DAILY_AUTO_LIMIT` | `10` | Auto-launches per source per day, **fleet-wide** (it used to be per worker). |
| `SHIP_PUBLISH_MAX_FILES` | `200` | Publication refuses a diff touching more files than this. Also `SHIP_PUBLISH_MAX_ADDED_LINES` (20000) and `SHIP_PUBLISH_MAX_FILE_BYTES` (2 MiB). Binaries, symlinks, submodule pointers, key material and forbidden paths are refused outright. |
| `SHIP_WEBHOOK_MAX_BYTES` | `1048576` | Cap on a webhook body, applied **before** the signature is computed. |
| `SHIP_SESSION_SECRET` | derived from `SHIP_WEB_TOKEN` | Signs dashboard sessions. Setting it lets account sessions survive a token rotation; sessions established *with the master token* still die on rotation, so rotating remains revocation. |
| `SHIP_TRUST_PROXY` | unset | Believe `X-Forwarded-Proto`/`-Host`/`-For`. Only set it when something in front actually overwrites those headers. |

### Rotating the master credential

```sh
teploy secret set SHIP_WEB_TOKEN "$(openssl rand -hex 32)" && teploy deploy
```

Every session minted from the old token stops working immediately. Named
accounts are unaffected — their roles are re-read from the store on every
request.
