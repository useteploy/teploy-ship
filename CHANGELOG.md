# Changelog

All notable changes to Teploy Ship are recorded here.

## [Unreleased]

### Added
- **Three sandbox network tiers, a per-repo egress allowlist, and a default that
  is not "broken".** `sandboxNetwork` carried `none | egress`; it now carries
  `none | allowlist | open` (`egress` is still accepted everywhere and is still
  what goes on the wire for the middle tier, so a daemon that has not been
  upgraded keeps working), and a project record carries `sandboxEgressAllow` —
  extra `host` / `.suffix` / `host:port` entries unioned with the daemon's
  built-in registries. Both are materialised into the run input at enqueue, like
  every other per-repo setting, so a replay boots the container the log was
  written under.
  - **Unset now means `allowlist`, not the daemon's `none`.** A sandbox with no
    network cannot `git clone`, and the clone happens *inside* the container, so
    a fresh install where nobody set `SHIP_SANDBOX_NETWORK` could run no repo
    task at all — it looked broken rather than closed, and the remedy an
    operator reaches for in that state is the largest one in range. `open` was
    the other candidate and is the wrong one: it would widen a security boundary
    by omission on a box whose operator never decided anything.
  - **A project in Ruby, Java, PHP, .NET or Elixir no longer needs a systemd
    edit.** `teploy-ship project set <repo> --egress-allow rubygems.org,.hex.pm`
    (or the Projects page) opens those hosts for that repo's runs only;
    `SBX_EGRESS_ALLOW` on the daemon still exists and still widens the boundary
    for every project sharing the host.
  - **An externally-sourced task is never run on `open`.** A task that arrived
    through a webhook, an issue body or a chat message is downgraded to
    `allowlist` whatever the project record says — enforced in
    `sandboxOverridesOf`, the single funnel every workspace creation goes
    through, so it also covers a run enqueued by an older binary and a run that
    parks and restores. The declared tier stays in the log, and the run page and
    `teploy-ship explain` both report that the downgrade happened. This is the
    isolated-executor rule applied to the network: the agent writes the
    commands, a stranger wrote the prompt.
  - **An egress refusal is legible.** The turn's row on the run timeline reads
    `network blocked: <host>` with the remedy beside it, `explain` leads with it
    instead of with "ran out of turns", and the agent's own observation is
    annotated so it stops retrying a wall — a blocked host and a broken build
    were previously indistinguishable in raw output, so the loop treated a
    policy decision as flakiness and paid for it in turns. Detection is
    deliberately narrow: `Could not resolve host`, `Network is unreachable` and
    a bare 403 do NOT match, because a false positive tells the agent to abandon
    a command that would have worked.
  - `docs/DEPLOY.md` now states what the allowlist tier genuinely **cannot** do
    rather than what is merely unconfigured: the boundary is injected as
    `HTTP_PROXY`/`HTTPS_PROXY` over a bridge with no default route, so SSH git
    remotes and `git://` have nothing to dial and no allowlist entry can fix
    them, and only ports 80/443 are admitted unless an entry names a port.
  - `trust` is now recorded on the run input whenever the caller states it, not
    only on repo runs. An issue or chat task with no repository recorded none,
    which left both this rule and the existing isolated-executor refusal blind
    to exactly the tasks they exist for.

### Added
- **`teploy-ship join <controller-url>` — one command that ends with a box
  taking work, or with a sentence saying why it cannot (B3).** Adding a second
  worker meant reproducing a configuration by hand and finding out whether it
  was right when the first run failed. `join` reads a secrets bundle
  (`install.sh --export-secrets`), plans the worker's environment, and then
  **verifies every dependency before writing anything**: the controller's
  `/health`, that the controller *accepts* the token, a real connection and
  round trip to Nucleus, `/health` + token on **every** daemon in
  `SHIP_SANDBOX_URL`, the forge authenticating the deploy token it will actually
  present, the model route, and the forge co-location gate. On success it writes
  `~/.config/teploy-ship/worker.env` (mode 0600) and either starts the worker
  (`--start`) or prints the systemd unit.
  - **It never transports credentials.** MASTER_PLAN B3's `--token` shape reads
    as "present a token, receive the configuration" — but that configuration is
    the Nucleus URL, the forge token, the GitHub PAT and the gateway key, and an
    endpoint that emits them to a bearer token is the most valuable endpoint in
    the system. What such an endpoint would need (admin-minted, single-use
    redeemed atomically, minutes-long TTL, bound and audited) and what a stolen
    token would get you (everything Ship can do to your code) are written out as
    the `PRE-DECIDED` block at the top of `src/join.ts`, along with the reversal
    condition. The controller URL and token are used to **prove**, not to fetch:
    a wrong controller or a typo'd token fails in this command instead of on the
    Fleet page, and a stolen join token gets exactly what a stolen
    `SHIP_WEB_TOKEN` already got you.
  - **Every check runs, even after one fails.** One round trip listing all four
    problems is one fix cycle. Nothing is written and no worker is started
    unless every check passed — the value of the command is that it never leaves
    a box half-joined and looking fine. Warnings (no sandbox, empty allowlist)
    never block.
  - Per-install secrets (`SHIP_SESSION_SECRET`, `SHIP_WEBHOOK_SECRET`,
    `SHIP_WEB_TOKEN`, the Slack and Linear signing secrets) are dropped on the
    way in rather than shared between hosts, matching what `install.sh` already
    refuses to copy. Everything credential-shaped is redacted where join prints
    its plan back, by suffix match rather than by a list, so a secret added next
    month is redacted without anyone remembering.
  - `--sandbox` **appends** to `SHIP_SANDBOX_URL` (deduped) rather than
    replacing it, which is the whole of "add a sandbox host" under B2's pool.
  - Proved live 2026-08-26 on deploy-test: a second worker joined and the
    controller's `/health` reported `worker: "ok (2)"`. Run from a laptop
    against the same controller, it named the three real blockers to a second
    box in one pass — `NUCLEUS_URL` and `AI_GATEWAY_URL` are docker network
    aliases, and `SHIP_SANDBOX_URL` is a bridge-local address.
- **`install.sh --export-secrets` writes a complete worker environment**, not
  just the secret store. `teploy secret list` holds credentials only, so
  `NUCLEUS_URL`, `AI_GATEWAY_URL`, `SHIP_MODEL` and `SHIP_REPO_ALLOWLIST` — all
  of which live in `teploy.yml`'s env block — were absent, and a bundle of
  secrets alone was never a startable configuration. The non-secret half is now
  read back off the running worker container, which is also the only copy that
  reflects what the box is actually running.

### Fixed
- **The forge co-location gate was inert on the real deployment (B4).** It has a
  fourth check that asks, from inside a sandbox, whether the forge answers on
  the sandbox host's own address — and that check could never answer. Measured,
  not reasoned about: an egress sandbox network is docker-`internal`
  (`docker network inspect teploy-sbx-egress` → `"Internal": true`), so a run
  container has **no default route at all** and the probe returned `NOGW` every
  time; from that network even the sandbox daemon's own listening port is
  dropped. There is no sandbox-side fix — the isolation that makes the sandbox
  safe is what blinds the probe.
  - New check 3 asks the same question from the **worker's own container**,
    whose default gateway is the docker bridge on its host — on deploy-test
    `SHIP_SANDBOX_URL=http://172.18.0.1:7439` *is* the worker's default gateway,
    so it is the same host. `/proc/net/route` is parsed in-process (the worker
    image is `node:22` and has neither `ip` nor `route`) and one `net.connect`
    asks whether the forge's port answers there. No sandbox, no container, no
    startup cost.
  - Proved both ways 2026-08-26 through the production `worker.ts` call site,
    with **no change to `worker.ts`**: on infra-home (which runs Forgejo) the
    worker now refuses, naming gateway `172.18.0.1` and port `49152`; on
    deploy-test it starts, and the "could not determine" line it used to print
    on every start is gone. Before this, on infra-home the gate reported "no
    sandbox is configured" and the worker started.
  - A connect **timeout counts as "not co-located"**, deliberately: a
    co-located forge's port answers from the host's own bridge in every shape
    Ship supports, and a gate whose normal output is a warning is a gate people
    stop reading. The reversal condition is written at the call site.
  - Check 3 is **not** asked for a public forge on port 80/443 — found by
    running `join` for real, not by reasoning. With `https://github.com` in the
    allowlist the question becomes "does anything answer on 443 on my default
    gateway", which on a bare-metal worker is a home router's admin UI. A
    self-hosted forge is still asked about on any port, and a public-address
    forge on a non-standard port still is too.
- **`/hooks/observe` — an Observe alert becomes an incident proposal (P1-5 /
  L4).** Ship had no way in from its own telemetry: Observe could see a service
  breaking and Ship could fix it, and nothing connected the two. A firing alert
  now arrives signed (`SHIP_OBSERVE_SIGNING_SECRET`, verified against
  `X-Observe-Signature` — hex HMAC-SHA256 over `"<unix-seconds>.<body>"` — with
  a freshness window on the signed `X-Observe-Timestamp`, default 300s) and
  becomes a `source: "observe"`, `kind: "incident"` task keyed
  `observe:<alert_id>`.
  - **The repository is a reverse lookup, not a payload field.** An alert names
    a service; it never names a repo. `repoForObserveService`
    (`src/evidence.ts`) reads the `observeService` correspondence backwards off
    the evidence store — a free function over `list()`, not a method, because
    `ProjectEvidenceStore` implements the same interface as a view over project
    records — and the receiver resolves the slug's clone URL from the project.
    An ambiguous service (two repos claiming it) binds NOTHING: a proposal a
    human binds in the inbox beats an incident opened against a repository that
    is not the one that broke.
  - **The mapping is a pure builder** (`incidentTaskFromObserveAlert`,
    `src/intake-sources.ts`), like every other intake source, so the part that
    decides what the agent reads is the part under test. Alert fields are
    flattened to one line before they reach the detail — the detail becomes the
    run's task text and a newline in an attacker-chosen rule name would
    otherwise forge a section inside the `frameUntrusted` wrapper.
  - **Policy stays `propose`.** An incident is not something to run unattended;
    the worker only auto-launches a source explicitly set to `auto`.
  - **Honest about a thin payload.** Observe's alert webhook carries no error
    fingerprint, no first/last-seen window, no sample stack and no service name
    — its alerts are threshold breaches on four site-wide metrics, and the
    fingerprint/first-seen/stack fields live on the error-issue subsystem that
    alert evaluation never reads. The builder accepts those fields optionally
    and renders them when present; when they are absent the detail SAYS so
    rather than letting the agent hunt for a stack it was never given.
  - Observe side (`teploy-observe`): the alert payload gained `rule_id` (the
    stable identity behind a per-cooldown `alert_id`), every delivery now
    carries an `X-Observe-Delivery` id so a receiver can dedupe a resend
    without hashing the body, and `internal/platform/webhooks_test.go` covers
    the signing scheme, the headers and the wire shape — that file had no test
    at all, for a contract another service verifies byte for byte.
- **The Bulletin: a public board whose pinned notes Ship picks up (L6 / D6).**
  `/bulletin/<slug>` is a page anyone can reach and anyone can write to — no
  account, no JavaScript required, every action a plain form POST. A note is
  pinned, voted for, and (on a board set to `auto`) promoted into an intake
  proposal by `POST /api/bulletin/sweep`; the note's public label moves Pinned →
  Picked up → Fix open as the task and its run move. `docs/bulletin.md` is the
  trust model and the operator's guide; `/bulletin-admin` (Projects → Bulletin)
  is where boards are configured and flagged notes are read.
  - **It is an untrusted input surface, and every automatic behaviour is off by
    default.** A note becomes a PROPOSAL, never a run — the `bulletin` intake
    source starts at `propose` like every other source, so a public board and an
    unattended run are two switches, not one. The repository is named by the
    BOARD and re-checked against the allowlist at `trust: "external"`
    (`proposeExternal`), so a poster cannot choose one. The text is carried
    verbatim and framed as `<untrusted-content>` at the agent boundary, exactly
    like an issue body, and `screenUntrusted` flags are recorded ON THE NOTE at
    pin time — so an injection attempt is visible to the operator whether or not
    it is ever promoted.
  - **A board cannot be set to `auto` while the change-class gate (L3) is off**,
    and cannot point at a repository with auto-merge (L5) on. Both are refused at
    save time AND re-asserted at send time, because the two settings live in
    different stores and either can move without the other knowing. That gate is
    the whole dependency of this item: with it on, a public note can only ever
    produce a `trivial`/`normal` change unattended, and anything `serious` parks
    for a human.
  - Volume bounds: a vote threshold (default 3), `bug` only by default, a
    per-board daily cap on auto sends (default 5) so a vote brigade cannot drain
    the budget, an in-process rate limit on pinning, similar-title dedupe that
    counts a re-post as a vote for the note it duplicates, and a staff `Decline`
    that blocks lookalike titles for 30 days.
  - Nothing internal reaches the public page: no run ids, no logs, no repository
    name, no failure states, and no email addresses (an address given for
    updates is stored, never rendered, and stripped by `redactPost`). The public
    status vocabulary is four words wide on purpose — `Picked up` deliberately
    covers a parked or failed run, because a page that distinguished them would
    be telling strangers how Ship is doing.
  - The sweep is an API route rather than a worker tick only because
    `src/worker.ts` belonged to another lane while this landed;
    `docs/bulletin.md` carries the exact patch that makes it resident, along
    with the one-line `changeClassRequired(task.source)` patch that makes the
    class gate per-source instead of deployment-wide.
- **Auto-merge for `trivial` changes, per repo, off by default (L5 / D5).** A
  run whose change classified `trivial` can now squash-merge its own pull
  request. FOUR conditions have to hold at the merge point, and the run records
  which of them did: the change classified `trivial`; the suite **passed** (not
  "ran" — a `disabled` outcome means nobody configured a suite, and merging on a
  test run that never happened is exactly the failure the gate exists for); the
  pull request opened **non-draft** (a draft is the run saying a person should
  look); and telemetry did not get worse. Three more are already settled before
  the run starts, because they are baked into the run input at enqueue: the
  repo's project record says `autoMerge`, the change-class gate is on (`trivial`
  is the whole authority for merging without a human, so without a verdict there
  is nothing to merge on), and the run is not a scan.
  - `mergePullRequest` (`src/git.ts`) is the one new forge call: `PUT
    …/pulls/{n}/merge` with `merge_method` on GitHub, `POST` with `Do` on
    Forgejo, squash on both. **It never throws.** The pull request is the
    deliverable and the merge is a convenience on top of it, so a forge that
    refuses leaves the PR open and the run `completed`, with the status and
    reason on the timeline. It is also never retried: a timeout after the forge
    merged, retried, comes back 405 "already merged" and would record a failure
    for a merge that happened.
  - The `auto-merge` step is recorded whenever the flag is on, refusals
    included, so the timeline answers the question a reader of an unattended
    merge actually has — not "did it merge" but "why was it allowed to".
  - `SHIP_AUTO_MERGE=0` is a deployment-wide kill switch; the per-repo switch is
    the Projects page (it needs the same `auto` grant as setting a source to
    auto). Turn it on per repo only after that repo's `change-class` steps have
    been read for a while: the 2026-08-26 sweep's one bad run was confident,
    sourced-looking and false, which is the failure a merge gate has to catch.
- **Auto-rollback, observable first (P1-4 / L4).** After `preview-deploy` and
  `telemetry-check`, a `rollback` step judges the measured before/after and
  records what should happen. Two conditions, not one: the service must have got
  worse **and** this run must actually have deployed something — a repo whose
  p95 moved while Ship only opened a pull request is watching somebody else's
  deploy, which is the same false attribution that cost the telemetry leg a live
  run on 2026-08-21.
  - `telemetryRegression` (`src/observe.ts`) is the judgement, and only a
    `compared` verdict can be one: `insufficient`, `unavailable` and `disabled`
    all answer no, because a rollback is destructive and "we could not measure
    it" is not evidence for taking one. Error rate is judged on an absolute
    delta (a point of extra errors is a point of extra errors at any scale) and
    p95 on a ratio **with** an absolute floor, so a fast service's 4ms → 6ms
    jitter is not a 50% latency regression. Defaults: 1 percentage point, or
    1.25x and at least 100ms.
  - **The default outcome is a sentence, not an action.** A repo gets
    `would-roll-back` with the numbers unless its project record carries
    `autoDeploy`, in which case the run calls `rollbackDeploy`
    (`teploy rollback` in the worker's own working copy — never in the agent's
    sandbox, which must not hold deploy credentials). Nothing in this system has
    ever been rolled back by a machine, so there is no distribution behind those
    thresholds yet; these recorded steps are how one gets collected before
    anything destructive runs on them.
  - The watch is on wherever preview and telemetry both are (`SHIP_ROLLBACK=0`
    turns it off) — it is a pure judgement over two verdicts that were going to
    be recorded anyway, so watching costs nothing.
- **`mode: "scan"` — read-only audit runs that produce findings instead of pull
  requests (L2 / D3).** The prompt-only scan MVP was structurally broken and its
  cron was switched off: it asked the agent to write
  `.teploy-agent/findings.json`, which is the one path in the workspace that
  cannot hold a deliverable — `validateActionPath` refuses it
  (`src/actions.ts:65`), `setupRepo` git-excludes it (`src/git.ts:141`) and the
  publish screen lists it as never-publishable (`src/publish-policy.ts:62`). All
  seven nightly scans on 2026-08-26 produced zero findings and five of them
  pushed code they had been asked in prose not to push. Three things changed.
  - **Publishing is disabled in the executor, not requested in the prompt.**
    `publishIfRepoRun` returns on the first line for a scan, so no push, no pull
    request, no forge call, and no test or change-class step runs. ```edit and
    ```create are refused by the loop before they reach the sandbox, with an
    observation telling the agent to record the change as a finding's `fix`
    instead. A prompt is a request a model drops at turn 30; a mode is not.
  - **Findings are run data, not a repo path.** The agent emits them in its
    ```finish block; a `scan-findings` step parses and validates them and they
    ride on the run's output, so they are readable from the run page, from
    `GET /api/runs/:id/findings`, and from the event log — with no file anywhere
    that could be refused, excluded, parked on, or accidentally pushed. A finish
    carrying no array is sent back to work twice before the run is allowed to
    end; an explicit `[]` is accepted as the real answer it is. `POST
    /api/runs/scan` starts one (the nightly cron's front door).
- **The daily spend cap is enforced on `enqueue`, not only at intake.** It used
  to be checked in `sweepIntake` against an intake TASK (`src/worker.ts:282`);
  `enqueueRun` creates a run directly and never makes one, so the CLI, the
  dashboard and any cron calling them were outside the cap entirely. That is how
  one night of scans spent $24.15 against a $10/day budget. `enqueueRun` now
  reserves and checks before the run's first event is written — a refusal means
  the run does not exist rather than existing and never being runnable — and the
  intake sweep is not double-counted, because its reservation is already held
  under the same run id. `reserve()` is idempotent by id in both spend stores.

### Fixed
- **An operator-declared `SHIP_MODEL_PRICING` override never applied to a
  prefixed model id — the documented form.** Overrides were stored under the
  key exactly as written but looked up under the prefix-stripped key, so
  `{"zai/glm-5.3":{...}}` (the shape of the docstring's own example) matched
  nothing and fell through to `UNKNOWN_MODEL_PRICING`: the most expensive
  entry in the table on every axis. A deployment declaring $1/$3.20 per 1M
  was charged $10/$50 — 10x on input, 15.6x on output — across every run.
  Not a cosmetic figure: the daily spend cap enforces against it, so runs
  were refused for exceeding a budget nothing had consumed. `pricingFor` now
  matches the full id first, then the bare id, so both forms work and a
  provider-specific rate still beats a bare one.

### Added
- **Ship is installable by someone who is not its author (B5).** Four things
  that only existed on one box now exist in this repo.
  - **The sandbox images are here**, in `images/`, with a build script and
    every version pinned in `images/versions.json` (bases by digest, harness
    binaries by exact npm version). They were hand-built from Dockerfiles that
    lived only in `~` on the dev box; if that box had died, Ship could not
    have run. `images/build.sh` produces `ship-sandbox-go:<tag>`,
    `ship-sandbox-node:<tag>`, and the `ship-sandbox-harness:<tag>` alias that
    deployed workers already name. **Go is pinned to 1.25, not 1.24** — three
    repos need 1.25 and on a 1.24 sandbox every Go pull request arrived marked
    `tests: failed`; a test now fails if anyone pins it back.
  - **Harnesses are declared, then baked.** A project record carries a
    `harness` field (Projects page, `src/projects.ts`), and
    `images/build.sh --harness <id>` bakes that binary in at a pinned version.
    Nothing installs a harness at run time, deliberately: that needs the
    sandbox egress default-deny exists to close, and a binary that drifts under
    a running worker breaks replay, because `selectAdapter` refuses to replay a
    run under a version its log did not record. A run whose harness is missing
    from its image now says which command builds one.
  - **`./install.sh`: a clean VM to a working Ship in one command.** Provisions
    the server, generates the secrets that should never be shared between
    installs, asks for the two only a human can supply, builds the sandbox
    images on the server, deploys. It also makes secrets portable off a single
    box for the first time — `--export-secrets` reads them back out of teploy's
    server-side age store, which is the concrete reason a second host had never
    existed.
  - **The test command is detected from the repo**, so no repo owes Ship an
    `evidence set` before its first pull request carries a suite result.
    package.json `scripts.test` (with the install a fresh clone needs), a
    Makefile `test:` target, `go.mod`, `Cargo.toml`, pytest config — read from
    the forge **at enqueue**, because evidence is materialised into the run
    input and a replay must run the command its log was written under. An
    explicit per-repo entry still wins; `SHIP_TEST_COMMAND` drops to last
    resort. `SHIP_TEST_DETECT=0` turns it off.
- **Akiroo hop (L1): Ship pulls work from an Akiroo workspace.** Set
  `AKIROO_URL` + `AKIROO_PULL_TOKEN` on the worker and a "Send to Ship" on
  an Akiroo work item becomes a `ship`-labelled Forgejo/GitHub issue and an
  intake proposal, and an approval on a parked run travels back the same
  way. The direction is the feature: Ship needs only outbound HTTPS — no
  port, no tunnel, no public URL — and Akiroo never holds a forge token.
  Rows are claimed in the delivery log before being handled and acked
  regardless, so a re-delivered batch cannot open a second issue and one bad
  row cannot wedge the queue. See `docs/DEPLOY.md`, "Connecting Ship to
  Akiroo".
- `origin {source, dedupe_key, work_item_ref}` on the outbound run-event
  payload (`RunWebhookPayload`), so a consumer can tie a run back to the work
  item it came from. Ship also stamps `Akiroo: <ref>` into the issue body,
  which reaches the same consumer through the run's task text.
- **Pull request reviews close the loop.** Only `issue_comment` was handled, so
  "Request changes" with five inline comments produced *nothing at all* —
  `pull_request_review` and `pull_request_review_comment` fell out of both
  receivers' catch-all. Both events are now mapped, on GitHub and on
  Forgejo/Gitea. Three things came with that:
  - **Ship's own PRs are followable without a human labelling them.** The gate
    was a `ship` label on the PR and nothing in Ship ever applied one, so the
    follow-up loop was dead on exactly the pull requests Ship opens. A head
    branch named `ship/…` **in the base repository** now satisfies it too. The
    same-repository half is load-bearing: anyone can open a fork PR from a
    branch called `ship/x`, and the gate exists so that a commenter cannot
    drive an agent run holding the git token from their own comment text.
  - **The task carries the location, not just the complaint.** File, line, diff
    side and the anchoring diff hunk travel with an inline comment; previously
    only the comment body did, so the agent was told "this is wrong" with no
    idea where.
  - **A batched review is one run, not N+1.** A review with three inline
    comments is four webhook deliveries; they now share one dedupe key (the
    review id, or the PR head SHA on Forgejo, which sends no review id), so
    they collapse into a single task, a single agent run and a single push.
    `listPrReviewComments` reads the whole review back off either forge, since
    coalescing means the later deliveries' bodies are dropped at intake.
- **`SHIP_QUOTA_MODEL_PREFIXES`: models billed as a flat plan, not per
  token.** The external-harness path already recorded a claude-code run on an
  OAuth token as `priced: false` — counted, not priced — but the native loop
  had no equivalent, so a run against a coding-plan endpoint was assigned a
  per-token dollar figure nobody was billed. Declared prefixes now cost 0,
  the way local inference already does. Opt-in with no default on purpose:
  guessing "free" removes the spend cap silently, while guessing "priced"
  only refuses work early.

## [0.2.1] - 2026-08-26

### Changed
- **A sandboxed run no longer parks on every ordinary verification step.**
  `defaultApprovalPolicy` is written for the LocalExecutor, where `rm -rf`
  and `curl` really do reach the operator's machine; it was being applied
  unchanged inside disposable sandboxes. Measured over the L0 round-2 batch,
  that cost twelve runs thirty-two approval parks — and all thirty-two were
  approved, because all thirty-two were the same thing: copy the tree to
  `/tmp`, run the suite, fetch a module from an already-allowlisted proxy.
  Unattended the batch simply stopped, taking its completion rate from 89%
  to 33%. New `sandboxApprovalPolicy` gates only what outlives the container
  (`git push`, `npm`/`pnpm`/`yarn`/`bun`/`cargo`/`poetry` publish, `twine
  upload`, `gh release|pr create`, `docker push`) and lets the sandbox
  boundary contain the rest. `resolveApprovalPolicy` picks it for durable
  runs that have a sandbox; a run without one is unchanged, since there is
  no boundary to lean on. `SHIP_SANDBOX_APPROVAL=strict|auto|boundary`
  overrides, and an unrecognised value falls back to the default rather than
  silently disabling the gate.

### Fixed — what the first real-backlog batch found (L0, 2026-08-26)
- **The worker never read `SHIP_MODEL`.** `worker`, `run`, `enqueue`, `fix`
  and `eval` resolved `--model` > config file > `anthropic/claude-sonnet-5`;
  only the web process looked at the environment, so a teploy-deployed
  worker (no config file) ran every intake task on the default whatever
  `teploy.yml` said — eleven runs recorded Sonnet under
  `SHIP_MODEL=zai/glm-5.3`. All six surfaces now go through
  `resolveModelId` (`src/model-id.ts`): flag > `SHIP_MODEL` > config >
  default, with a test.
- **…and once it did, `zai/glm-5.3` 404'd.** Ship spoke every non-`anthropic/`
  id over the OpenAI wire, but the gateway's z.ai coding-plan builtin is
  Anthropic-wire only. `usesAnthropicWire` (`src/model-id.ts`) now routes
  `anthropic/`, `zai/` and `zai-coding-plan/` over `/v1/messages`;
  `SHIP_ANTHROPIC_WIRE_PREFIXES` overrides the list for other gateways.
- **Runs on large repositories died at the sandbox reaper before their first
  command.** Ship never asked the daemon for a TTL, so every container got
  its 30-minute default, while the `repo-index` step waited on a 1 GB
  ollama answering one embedding at a time — four runs were reaped mid-index
  and failed as `turn-0-exec: run not found`. Two changes: the worker now
  requests `SHIP_SANDBOX_TTL_SEC` (default 7200, floor 600) on every
  sandbox, and the index refresh is bounded by `SHIP_INDEX_TIMEOUT_MS`
  (default 120000): it stops between files and batches once the deadline
  passes, keeps what it committed, no single embedding call may outlive
  the budget, and the recorded step says `stopped at the 120s index cap`.
  PRE-DECIDED: a time cap over a "skip when slow" probe — a probe measures
  one call, and the failure mode was a slow *endpoint*, not a dead one.
- **Store writes failing under load wedged meta, settle and `approve`.**
  With four sandboxes plus CLI traffic on the 4-connection pool, pg-pool
  rejected with `TypeError: Cannot read properties of undefined (reading
  'name')` — its `promisify` catch calls `Error.captureStackTrace` on a
  rejection value that was not an Error, masking the real reason
  (pg-pool@3.14.0 `index.js:45`; seen alongside Nucleus catalog write
  failures). Eight of nine runs kept `queued` meta, one settle lost its
  cost, and a parked run could not be approved ("no longer waiting"). Every
  statement now goes through one path that retries a non-database
  rejection once on a freshly checked-out client and destroys that client
  if it fails again (`src/nucleus-pgwire.ts`, injectable pool, five tests).
  Genuine database errors (SQLSTATE) are never retried. The root cause —
  what rejects with a non-Error under contention — is recorded there for a
  proper fix; the pool size and acquire timeout are unchanged.

### Changed — nav compression (C4, 2026-08-25)
- The header is five links — Inbox · Runs · Projects · Fleet · Settings — plus
  an avatar menu (Account, Sign out; new `POST /logout`). The other pages are
  sub-views switched by a link row under the title, driven by `?view=`:
  Runs → Reviews; Projects → Repos, Sources, Knowledge; Fleet → Workers,
  Spend; Settings → Governance, Team, System. Every old path still resolves:
  `/reviews`, `/sources`, `/knowledge`, `/spend` 302 to their new location
  (query preserved). `/policies` keeps its own path on purpose — its RBAC
  exemption is path-based, so a named viewer holding the `policies` grant
  must still reach it — and renders as the Governance sub-view of Settings.
  `/projects` joins the authority-governed paths (its edits check the
  `policies` grant in the route); Knowledge notes under it keep their editor
  rule in-route. One shared `redirect()` in `web/src/lib/http.server.ts`.
  Screenshot: `docs/images/nav-c4.png` (the dashboard has one theme).

### Added — load-aware admission (C2, 2026-08-25)
- The worker no longer fills the ceiling on a box that has no room: below
  `SHIP_MIN_FREE_MB` (default 600, measured `MemAvailable`) or above
  `SHIP_MAX_LOAD_PER_CPU` (default 1.5) a due run waits exactly as it does at
  the ceiling, the reason is logged once a minute, and the heartbeat carries
  `freeMemMB`, `load1`, `cpus` and `held` so the Fleet page says "held:
  memory" / "held: load". Removing the pressure resumes launches on the next
  pass, no restart. Sandbox CPU / memory limits come from the repo's project
  record (default 1 CPU / 1 GB, the daemon's).

### Added — Projects (C1, 2026-08-25)
- One record per repository (`src/projects.ts`; `projects.json` / `ship_projects`):
  clone URL, sandbox image / network / limits, intake policy and budget, test
  command, Observe service. Adding a project ALLOWS its repo — the effective
  allowlist is `SHIP_REPO_ALLOWLIST` (the floor) plus every project's clone URL,
  by exact repo. Its sandbox image, network and limits are materialised into
  the run input at enqueue and override the worker's `SHIP_SANDBOX_IMAGE` for
  that repo's runs, so a Go repo and a pnpm repo share one worker. A project's
  `sourcePolicy` (ignore / propose / auto) and daily budget override the
  source's for that repo's tasks in the intake sweep.
- Evidence is now a view of projects: `teploy-ship evidence set|list|remove`
  and `enqueueRun` are unchanged; existing `ship_evidence` rows are read
  through, and every `evidence set` moves the repo onto its project record.
- Dashboard `/projects` (list, add, `?repo=` detail with the webhook hint;
  edits need the `policies` grant, `auto` needs the `auto` grant) and
  `teploy-ship project set|list|remove`.
- Proven live on deploy-test: two throwaway Forgejo repos added through the
  page alone, one Go (`golang:1.24`, `go test ./...`) and one pnpm
  (`ship-sandbox-node:dev`, `pnpm test`), both webhook-proposed, both ran on
  the same worker in their own images side by side and opened PRs carrying
  `Tests: passed` with their own command; the same pnpm repo BEFORE its
  project existed ran in the worker image and reported `Tests: FAILED — go
  test ./...`.

## [0.2.0] - 2026-08-25

### Fixed — found by the capacity load test (2026-08-25)
- The concurrency ceiling was about half real: `launchDueBounded` counted an
  executing run twice (it is in both `launching` and `inflight` for its whole
  life), so `SHIP_MAX_CONCURRENT_RUNS=4` never held more than 3 runs and mostly
  sat at 2. Counts the union now; the test models the real membership.
- A terminal settle that failed after winning its exactly-once claim lost the
  run's cost from the ledger for good (one of 45 runs under load, on a
  transient pool rejection). The settle's reads and ledger write now retry, and
  a settle that still fails releases its own claim and logs it, so the state
  reads as unsettled rather than done.

### Added
- `docs/capacity.md`: a measured capacity figure on named hardware (4 vCPU /
  4 GB), the ceiling-vs-throughput table, the recommended ceiling for that box
  class and a rule of thumb for larger ones, with what was not measured and why.

### Added — pluggable harness (2026-08-24)
- `HarnessAdapter` (`src/harness.ts`): the loop that edits the tree is one
  implementation behind an interface. `native` (the existing durable loop,
  re-entry-pointed with no behaviour change — two pre-adapter run logs replay
  through the new path step-for-step in `harness.test.ts`) stays the default
  and the air-gapped fallback. Adapter id + contract version are materialised
  into every run input at enqueue (`SHIP_HARNESS`); a worker refuses a
  harness it lacks or a version the log did not record.
- `claude-code` and `opencode` adapters (`src/harness-external.ts`): the
  vendor binary runs headless inside the sandbox executor behind a recorded
  preflight step; credentials are forwarded by name (`SHIP_HARNESS_ENV`) and
  the log records names only. Publish gate, evidence legs and spend settle run
  on the tree the harness left. Contracts and sources in `docs/adapters.md`.
- Cost honesty for subscription-fed harnesses: usage carries `priced: false`,
  such runs go to a new unpriced-runs ledger (never the dollar ledger, never
  shown as $0), the Spend page shows "Unpriced runs" per source, and the run
  page shows an "unpriced run" chip. A priced external run records the
  harness's own dollar figure.
- Multi-harness attempts (`SHIP_HARNESS_ATTEMPTS`, repo runs, off by
  default): each listed harness works its own checkout, a recorded
  `harness-pick` step has the critic choose among the diffs, only the winner
  is published and the losers' workspaces are released.
- Settings shows the harness variables; `explain` knows the `error` outcome.
- Proven live 2026-08-25 on deploy-test: a native run and an opencode run
  (z.ai coding plan, in a sandbox image carrying the binary) each opened a PR
  with `Tests: passed`; the opencode run settled as an unpriced run. The
  sandbox daemon's egress allowlist (`SBX_EGRESS_ALLOW`) must name the vendor
  host for an external harness to reach its model.

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
