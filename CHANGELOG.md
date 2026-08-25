# Changelog

All notable changes to Teploy Ship are recorded here.

## [Unreleased]

### Fixed — dashboard pre-release pass (2026-08-24)
- Every Nucleus-backed store cached a FAILED table-ensure for the life of the
  process: one transient engine error at startup left that page 500ing on every
  request until a restart (found live: `/knowledge` returned "catalog
  persistence failed" for two days while the query itself worked from a fresh
  connection). A failed ensure is now retried on the next call. Seam test in
  `repo-memory.test.ts`; same fix in attributed-spend, code-index, evidence,
  fleet, intake, outbox, policies, steer, users.
- Settings named credentials Ship never reads (`FORGEJO_TOKEN`, `GITHUB_TOKEN`)
  and omitted the ones it does (`SHIP_GIT_TOKENS`, `SHIP_GIT_TOKEN`,
  `SHIP_GITHUB_TOKEN`, `SHIP_REPO_ALLOWLIST`, `AI_GATEWAY_KEY`). It now shows
  the real names, plus the evidence legs (tests / telemetry / preview and their
  config), intake settings, and `SHIP_MAX_STEPS`.
- Run page and login read `?decision=` / `?cancel=` / `?error=` from
  `window.location` inside the component, so the server rendered no banner and
  the client hydrated one in — a hydration mismatch. They are read in the
  loader now. The Inbox never showed its own `?decision=taken` outcome at all.
- Spend's "projected for today" extrapolated from minutes into the UTC day
  (ten cents at 00:02 read as $72); it waits for the first hour.
- Runs filter chips showed an empty table with headers and no message when a
  category had no rows; the `running` and `cancelling` statuses had no chip
  colour.
- Native `<select>` / `<input>` controls on Sources rendered in the platform's
  light theme on the dark page; form controls are styled globally now.
- Narrow screens: the header nav overflowed the viewport and the page scrolled
  horizontally; the nav now wraps to its own scrollable row and wide tables
  scroll inside themselves.

### Added
- Team policies (P2-3, the buyer half): `src/governance.ts`, the dashboard's
  **Policies** page, `/api/policies` and `teploy-ship policy …`.
  **Authority** — per action (`approve`, `auto`, `steer`, `policies`) the
  roles and named users allowed; deny by default; enforced server-side on
  the run page, the Inbox, the Sources form, `/api/runs/:id/decide` and
  `/api/policies` (a refused caller gets a 403 or a `?denied=` banner, never
  a silent no-op). Paths those grants govern are no longer role-locked in the
  layout, so a named viewer can hold `approve` — and a quick new run from
  the Inbox now needs `approve` like a launch does. **Auto windows** — per
  source or global (`*`), wall clock in an IANA zone; outside it an `auto`
  source parks its tasks as `propose` (the worker checks at every sweep and
  claims nothing). **Required reviewers** — per repo slug, requested on the
  PR via one call shape on both forges; materialised into the run input at
  enqueue (new recorded step `repo-reviewers`), and a refused request is the
  step's recorded outcome, never a failed run.
- Teams and roles (Teploy RBAC contract: admin/editor/viewer). Ship's single
  shared `SHIP_WEB_TOKEN` becomes multi-user: username/password accounts with
  three roles — **admin** (manage users, sources, secrets), **editor** (approve
  runs, launch work, mid-run steer), **viewer** (read-only). Since the approve
  button is remote code + spend approval, this gates *who can approve* vs who
  can only watch. Accounts persist in the runtime (file or Nucleus) via a new
  user store; passwords hashed with Node's built-in scrypt. Login now takes a
  username; the `SHIP_WEB_TOKEN` remains an **admin master credential** (login
  fallback + API bearer) so operators are never locked out and existing API
  callers keep working. Sessions are stateless signed cookies whose role is
  re-derived from the store on every request — so a demotion or removal takes
  effect immediately, not when the cookie expires. Manage accounts in Settings
  (admin only); change your own password in Account. Roles are modeled to map
  1:1 to a future OIDC claim for Phase 2 SSO federation.
- Cross-product dashboard switcher. A top-left dropdown lets you jump between the
  deployed Teploy dashboards — Dash, Observe, and Ship. Configure the sibling
  URLs with `TEPLOY_NAV_DASH_URL` and `TEPLOY_NAV_OBSERVE_URL` (same env
  convention across all three products); the switcher only appears once at least
  one sibling URL is set.
- Single sign-on (OIDC). Ship can act as an OpenID Connect relying party:
  delegate login to your own identity provider (Okta, Azure AD/Entra, Google
  Workspace, Keycloak, Authentik — "generic OIDC") or to Teploy Platform acting
  as the IdP for Cloud. The IdP authenticates the user; Ship verifies the signed
  ID token (authorization-code flow with PKCE, state, and nonce via
  `openid-client`) and maps a claim to the same admin/editor/viewer roles — a
  `teploy_role` claim wins, otherwise a group claim is matched to configured
  admin/editor/viewer groups, otherwise a configurable default (viewer). It then
  mints Ship's normal signed-cookie session (marked as an SSO session, whose
  role is carried in the tamper-proof cookie and re-read from the IdP on each
  login). Ship stays stateless — the in-flight state/nonce/PKCE verifier ride in
  a short-lived signed cookie, not a server store. Username/password login
  remains the break-glass path. Enable with `SHIP_OIDC_ISSUER` +
  `SHIP_OIDC_CLIENT_ID` (plus `_CLIENT_SECRET`, optional `_REDIRECT_URL`,
  `_SCOPES`, `_LABEL`, `_USERNAME_CLAIM`, `_ROLE_CLAIM`, `_GROUPS_CLAIM`,
  `_ADMIN_GROUP`/`_EDITOR_GROUP`/`_VIEWER_GROUP`, `_DEFAULT_ROLE`); register
  `https://<your-ship-host>/oidc/callback` as the redirect URI. The login page
  shows an SSO button when it's configured.
- Machine-callable approve/deny for a parked run:
  `POST /api/runs/<run-id>/decide`, JSON in and JSON out, authenticated with
  the existing `Authorization: Bearer <SHIP_WEB_TOKEN>` and requiring the
  editor role. The dashboard form on `runs/[id]` is the right surface for a
  person and the wrong one for a program, which would otherwise have to post
  form fields and parse a 302. Body: `approved` (required boolean), optional
  `reason`, optional `plan` (honoured only on a plan approval), and optional
  `event_name` to pin the decision to the park the caller actually saw — if the
  run has since parked on something else that is a 409, not a silent approval
  of something nobody looked at. Reuses the same
  deliverEvent → markWake → saveMeta primitive the form does, rather than a
  second resume path that would rot. Requires `@neutron-build/core` 0.1.8.
- `/api/*` now answers unauthenticated requests with `401` and a problem+json
  body instead of redirecting to `/login`. A program cannot fill in a login
  page, and a caller following the 302 would have parsed the login HTML as its
  result. Page routes still redirect.

### Fixed
- The session cookie was `SameSite=Strict`, which the SSO callback cannot
  survive. The callback sets the cookie and redirects to `/`, and that hop is
  the tail of a cross-site redirect chain starting at the identity provider —
  browsers withhold a Strict cookie on a cross-site-initiated top-level
  navigation, so the user would have landed on `/` with no session, bounced to
  `/login`, and appeared signed in only after a manual reload. Now `Lax`, which
  is still withheld on cross-origin POST. Password login never leaves the site,
  which is why Strict looked correct until SSO existed.
- `X-Forwarded-Proto`/`X-Forwarded-Host` were believed from any caller. Since
  the shipped `teploy.yml` uses `ingress: host`, the web process is published
  directly at `<server-ip>:7460` with no proxy in front, so those headers were
  client input — and the scheme derived from them decides whether the session
  cookie gets `Secure`. Sending `X-Forwarded-Proto: http` was enough to have
  sessions issued without it. The origin is now taken from `SHIP_PUBLIC_URL`
  when set, then from the forwarded headers only if `SHIP_TRUST_PROXY` is set,
  and otherwise from the request itself. (Dash gates the same logic on the peer
  IP against a trusted-proxy CIDR list; the web layer here only sees a
  `Request`, so the operator declares it rather than Ship inferring it.)
- Added an Origin/`Sec-Fetch-Site` check on state-changing requests, matching
  dash. `SameSite=Lax` already blocks the ordinary CSRF case; this covers a
  browser or intermediary that doesn't enforce it. Bearer callers send neither
  header and are unaffected — a bearer token is never attached ambiently.

First public release.

### What Ship is

A self-hosted coding agent: point it at a task and it plans, edits, runs, and reviews in a real workspace. Acts by writing and running code (the CodeAct strategy) rather than emitting structured tool-call JSON — each turn it thinks, runs one fenced Bash or Python block in a sandbox, observes the real output, and iterates. Self-host the dashboard and worker, bring your own model keys, and keep your code on your own infrastructure.

### Core loop

- CodeAct execution: think → act (one code block) → observe → repeat, against a persistent kernel that keeps variables alive across turns within a run.
- Durable runs: workflow state survives restarts and crashes; a run can park on an approval gate and resume exactly where it left off, without repeating completed model calls or shell commands.
- Configurable approval policy: live runs prompt on dangerous actions by default; durable runs park for review. Destructive/network/privilege-affecting actions are the ones gated.
- Loop and thrashing detection: repeated identical actions or repeated failures trigger a nudge, then an escalation to abort rather than burning an unbounded number of turns.
- Recovery and memory: oversized histories condense the middle turn range and keep the head + recent context; per-repo notes and a playbook (`SHIP.md`, `.ship/playbook.md`, or `AGENTS.md`/`CLAUDE.md`) persist lessons across runs on the same repo.

### Task intake

- Signed GitHub and Forgejo issue webhooks propose tasks from a `ship`-labeled issue; a follow-up `issue_comment` on an open PR proposes a review/steer task on the same run.
- Slack and Linear intake: an `@ship` mention or a labeled Linear issue creates a task the same way; run notifications (parked, failed, PR opened) post back with a link to the run.
- A CI-failure webhook (`workflow_run`/`check_run`) on a `ship`-authored PR proposes an auto-fix task with the failure log attached, closing the review loop without a human re-triggering it.
- Every automated launch path is bounded by daily launch count, concurrency, and per-source spend caps; a policy-read failure fails closed (no launch) rather than open.

### Repository work

- For repository tasks, Ship works from a `ship/run-<id>` branch, commits as it goes, and opens a pull request once its diff is non-empty — never force-pushes, never touches `main` directly.
- Per-repo codebase indexing: a repo run refreshes a chunked, embedded index of the codebase into Nucleus vector storage after clone, and the agent gets a `search` action to query it mid-run.
- Plan preview (opt-in per run) and mid-run steering: a run can pause for plan review before touching anything, and a dashboard operator can inject guidance into a running or parked run.

### Model and infrastructure

- Configurable model routing: Anthropic or OpenAI directly, or any OpenAI-compatible gateway (self-hosted or otherwise) — you choose the endpoint and hold the credentials. Routing is model-agnostic; performance is not. Ship is validated and prompt-tuned on specific model families — [docs/MODELS.md](docs/MODELS.md) records exactly which, on what sample size, and with what confidence interval.
- Sandboxed execution via `teploy-sandbox`, with a default-deny egress policy — a run can reach its git host, its model gateway, and package registries, and nothing else.
- Prompt-injection mitigations: untrusted issue/PR/repo content is framed explicitly as data, not instructions; a guardrail pass flags injection-shaped content in the run timeline; the approval gate stays in front of network/push actions regardless of what repo content says.
- Secrets are scoped per run source rather than dumped wholesale into the sandbox environment.
- Runs, spend, and audit-relevant events can forward to a self-hosted Teploy Observe instance.

### Self-hosting

- One `teploy deploy` brings up the dashboard, the worker, and a Nucleus store as a Teploy app — see [docs/DEPLOY.md](docs/DEPLOY.md) for webhook wiring, the sandbox, embeddings activation, and the full security model.
- Ships as a multi-arch (`amd64`/`arm64`) GHCR image (`ghcr.io/useteploy/teploy-ship`), built from source with no dependency on any unpublished package — `pnpm install && pnpm run build` works from a clean clone.

### Known gaps

- Multi-user auth/RBAC, SSO, and an IDE integration are deliberately deferred — see the project roadmap for the reasoning. Single-token auth is the current model; fine for solo/small self-hosting, not yet a team product.
- **Model portability is architectural, not yet broadly validated.** The routing seam reaches any Anthropic- or OpenAI-compatible endpoint, but the agent prompt was written and tuned while only ever observed against one model family. On a 9-instance cross-family smoke, a different family produced no patch in 5 of 9 runs — not a format failure, a prompt-tuning one. [docs/MODELS.md](docs/MODELS.md) has the numbers and the honest limits.
