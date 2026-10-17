# Open audit items

## 2026-10-17 — plan grounding saw nothing on plain-prose plans (GLM-5.3)

Found live on production 2026-10-17 (A5 soak): with
`SHIP_PLAN_GROUNDING=on`, a GLM-5.3 plan that named its files in plain
prose ("read index.html to find the paragraph, and read test.sh … check
for an existing .ship/flow.mjs") produced a grounding report with
`refs: []` and every count 0. `extractRefs` read only backtick spans and
fenced command lines; this model writes file names unquoted, so real
plans grounded nothing and the advisory said "no files, symbols or
commands" about a plan full of them. Fixed (branch
`fix/plan-grounding-prose`): `extractRefs` also scans the prose between
backtick spans (never inside fences) for bare file-path tokens that pass
`looksLikePath` with surrounding punctuation stripped — conservatively:
emails, `1.2.3`-style versions and hostnames are refused (`example.com`,
`api.z.ai`: a dot-suffix that is not a known FILE_EXT is TLD-like, with
or without a path), URLs are refused by `looksLikePath` itself, and
symbols and commands stay backtick/fence-only. Prose-derived refs carry
an additive `origin: "prose"` field; report shape is otherwise
unchanged. Pinned by failing-on-main tests in
`src/plan-grounding.test.ts`: the production plan text yields
`index.html`, `test.sh`, `.ship/flow.mjs` (grounded / grounded /
ungrounded against a real git fixture), negative controls (`example.com`,
`1.2.3`, `api.z.ai`, `e.g.`, `i.e.`, `done.`) extract nothing, and
backtick behaviour is unchanged (same path both ways dedupes to one ref).
## 2026-10-17 — delegated children were writable change runs: read-only children, single parent PR (FIXED IN CODE, re-enable owed)

Found live on production 2026-10-17 (soak A4, run-request-1032fa9d…): a
change-journey parent delegated two children, and each child — an ordinary
change run with the parent's gates copied — edited files, opened its OWN
draft PR (#3, #4 on the scratch repo) and parked at approve-merge, so the
parent's delegate-wait blocked until a human approved each child's merge;
then the parent redid both files in a THIRD PR. Delegation was switched off
in production until fixed. The mechanics otherwise worked (sequential
children, context transfers, placement across hosts, $0.072 total).

- Code fix (branch `fix/delegate-readonly-children`): delegated children are
  ALWAYS read-only — `delegateControlFromRuntime` enqueues the child with
  `mode: "scan"` (and `enqueueRun` forces scan for any `delegateChild` run,
  enforcement over cooperation), so a child edits nothing, pushes nothing,
  opens no pull request and can never park at approve-merge; its deliverable
  is the context transfer (findings/answer/proposed patch text in the
  summary), and the parent stays the only writer producing the single PR.
  The `plan` flag is no longer copied (a child that cannot edit owes no plan
  review); trust, the network tier and the spend source still are.
- No human-blocking child parks: a child is never offered ```ask (suppressed
  at enqueue) and a stray block is refused BY NAME in the loop
  (`DELEGATE_CHILD_ASK_REFUSED`); an approval-required action on a child is
  denied automatically with the reason recorded
  (`DELEGATE_CHILD_APPROVAL_REFUSED`). Both are pure functions of the
  recorded input, so replay refuses identically.
- The parent's wait is bounded by `SHIP_DELEGATE_WAIT_MS` (new env; default
  30 min, 0 honoured, ceiling 6 h): a child that never terminates yields an
  honest `timeout` context transfer ("child did not finish") instead of an
  infinite park. The bound is decided inside the recorded wait step, so
  replay reads the recorded result, never a recomputed clock.
- Pinned by failing-on-main tests in `src/delegate.test.ts` (verified against
  `github/main`: on main the child enqueues with no `mode` — a writable
  change run; a child ask parks the run (`waiting`); a never-finishing child
  leaves the parent `sleeping` forever): a child from a change parent is a
  scan with none of the parent's change-shaped gates and no ask; a child ask
  and a child approval never park; the wait timeout records the transfer and
  replays; flag-off equivalence and the updated gates/prompt tests.
- Replay safety: the child mode is materialised at enqueue (part of the
  child's input), the parent's step sequence and step names are unchanged,
  and flag-off is byte-identical. Accepted exposure: a pre-fix child log that
  contains an ask or approval park would replay into a NondeterminismError —
  moot, because the flag is off in production and those soak children are
  terminal (a terminal log is never re-executed).
- Still open: re-enable `SHIP_DELEGATE` in production and run one live
  delegated change to confirm the read-only shape end to end (single PR from
  the parent, no child PRs, no human-blocking parks).

## 2026-10-17 — PR watch first-enable flood: discovery bounded by PR age

Found live on production 2026-10-17: the FIRST sweep after
`SHIP_PR_WATCH=on` walked the entire run history (no discovery cursor
existed yet) and adopted EVERY run that ever opened a `ship/` PR —
months-old load-test PRs (`Tyler/ship-load-test` #3..#55) plus real ones
(`tyler/neutron.git` #5, `Tyler/teploy-observe.git` #12/#13) — proposing 24
conflict-revision tasks into the Inbox at once. Nothing auto-launched
(intake policies do not cover source `pr-watch`), but the operator's queue
flooded with stale work. Fixed (branch `fix/pr-watch-age-bound`):

- Discovery adopts only runs whose PR OPENING is within
  `SHIP_PR_WATCH_MAX_AGE_DAYS` (new env; default 14, clamped 1-90), dated
  by the recorded `repo-pr` step's own append time when present, else the
  run meta's `updatedAt` — the tighter bound, so a run touched recently
  that opened its PR long ago is still skipped.
- First-enable cutover: when no discovery cursor exists, it is initialised
  at now minus the max age instead of scanning all history; older metas
  count as examined by definition. Existing proposals are NOT
  auto-dismissed — the 24 are the operator's to triage — but the first
  enable logs one line summarising how many historical PRs were skipped
  as too old.
- Pinned by failing-on-main tests in `src/pr-watch.test.ts`: a PR opened
  60 days ago is not adopted while one 3 days old is; the age is taken
  from the step's own time, not `updatedAt`; first enable adopts nothing
  beyond the window and writes the cursor at the floor; the env clamps
  (90 adopts a 60-day PR, 1 skips a 3-day one); flag-off stays a strict
  no-op.

Still open: the watches adopted on production by the flood sit in the
runtime config until their 30-day expiry (or merge/close) removes them —
harmless (each due watch costs forge reads only, capped per sweep), but
an operator `teploy` command to prune watch rows by age would be nicer
than waiting.

## 2026-10-17 — external harnesses died at the egress allowlist calling their own model vendor — FIXED IN CODE, live confirmation owed

Found live 2026-10-17 (production): an external-harness run (claude-code,
`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`) failed with
`API Error: 403 egress denied by the sandbox allowlist: api.z.ai:443`.
External harnesses call their model API from INSIDE the sandbox; the native
loop calls from the worker. The sandbox's allowlist carried only the forge,
so every model call died at the proxy until the operator added api.z.ai to
the project's `sandboxEgressAllow` by hand.

- Code fix (branch `fix/harness-provider-egress`): `enqueueRun` derives the
  provider API hosts from the same forwarded env the harness will read
  (`providerEgressAllow`, src/harness-external.ts — a forwarded base URL wins:
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AI_GATEWAY_URL` for codex's
  gateway; else the vendor default per forwarded key: `api.anthropic.com` for
  claude under `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, `api.openai.com`
  for codex under `CODEX_API_KEY`/`OPENAI_API_KEY`, and for opencode
  `api.z.ai` when `ZHIPU_API_KEY` is forwarded and the model starts with
  `zai-coding-plan/` or `zhipu`, plus `api.anthropic.com`/`api.openai.com`/
  `openrouter.ai` under their matching keys) and merges them into the run
  input's `sandboxEgressAllow` (`withProviderEgress`): materialised at
  enqueue so replays are stable, hosts only on port 443, de-duplicated,
  project entries surviving. Native derives nothing and an external run with
  nothing derivable records byte-identical inputs; the field admits no step,
  so no step fingerprint moves. `teploy-ship doctor` gained the
  `harness-egress` line naming what the machine's configuration derives.
  Deliberately NOT derived: subscription credentials
  (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`) — those dial a vendor
  host too, but guessing a host onto a security allowlist from a token Ship
  cannot read through is not the derivation's call; those deployments keep
  adding the host by hand, and the doctor line says so.
- Still open: one live external run (the 2026-10-17 shape or any other) to
  confirm the derived entry reaches the daemon's proxy allowlist end to end.
  The tests cover the derivation, the enqueue materialisation, and the merge
  with the project's own list; `sandboxOverridesOf` already passes
  `input.sandboxEgressAllow` to the daemon unchanged.

## 2026-10-16 — codex harness adapter: event contract source-verified, live run still owed

The `codex` adapter (src/harness-external.ts, pin @openai/codex@0.163.0)
parses a JSONL event stream whose encoding its tests replay through a fake
binary. Per the mock-encodes-semantics rule, that encoding is a claim: it
was verified against the tagged upstream sources
(evals/receipts/2026-10-16-codex-exec-json-contract.txt lists every file and
field), NOT against a live codex run — no OpenAI credential was available.
Deferred, not closed: the first live canary (one instance, trivial task,
CODEX_API_KEY) must compare the recorded `harness-run` step against the
receipt's section 2 and correct `parseCodexExecStream` if the real 0.163.0
stream differs. Also unverified live: the npm postinstall fetch inside the
sandbox image build, `codex exec` as root under
`--dangerously-bypass-approvals-and-sandbox`, and the teploy-gateway route
(the gateway must expose a Responses-compatible endpoint; codex dropped
`wire_api = "chat"`). No version-refusal guard exists yet — none is warranted
until a measured incompatible major exists, same standard S13 set for
opencode.

## 2026-10-16 — B6: Slack/Linear intake proven; Linear replay gap closed

Owner Decision 7 (2026-10-16): Slack and Linear are user features for
self-hosters, not the owner's workflow. Real-path tests now drive the actual
`/hooks/slack` and `/hooks/linear` route handlers with correctly signed
payloads (`web/src/lib/slack-linear-hooks.test.ts`) and the outbound Slack
incoming webhook over a loopback socket (`src/notify-slack-loopback.test.ts`).
Defect found and fixed: the Linear receiver's replay protection rested on the
`Linear-Delivery` header, which the signature does not cover — a captured
body re-sent under a fresh delivery id was accepted. It now refuses a body
whose signed `webhookTimestamp` is more than 5 minutes off. Self-hoster guide:
`docs/INTEGRATIONS_SLACK_LINEAR.md`. Still open: a real Slack app / Linear
webhook pointed at production (B6's live half; needs the public HTTPS route
for `/hooks/*`), and threaded Slack results (B4).
## 2026-10-16 — shadows wrote nothing for 12 days (root-owned data volume)

Found live 2026-10-16: on production the bind volume
`/deployments/ship/volumes/ship-data -> /data` was `root:root 755` while web and
worker run as uid 1000 (`node`). Root cause: the volume teploy created for the
new deploy was root-owned, and nothing re-owned it. Every file-backed shadow
(`policy-shadow.jsonl`, `placement-shadow.jsonl`, the tool-manifest shadow,
the budget-reservation file ledger, file-mode knowledge provenance) failed
every write from 2026-10-04 and logged nothing an operator would see — the
writers swallowed the error (tool manifest, provenance) or logged only per run
in lines nobody watched (budget ledger) — so the A2 "shadow soak" produced no
data, and `policy shadow-report` said "no record file ... unknown", which read
as a quiet shadow, not a broken one. The `warnIfStateUnwritable` startup check
existed but only ran for UNSANDBOXED workers, so production never ran it.

- Hand fix applied 2026-10-16 by the operator: `chown 1000:1000
  /deployments/ship/volumes/ship-data` on the server.
- Code fix (branch `fix/loud-shadow-writes`): every shadow/record writer goes
  through `src/record-writes.ts` — never throws into the run path, ONE loud
  warning per process per file (path, errno, uid, the chown fix), every failure
  counted (`writeFailures()`); worker and web probe the data dir and each
  enabled shadow's record dir at startup (`src/record-dirs.ts`) and log an
  ERROR naming the fix without stopping; `teploy-ship doctor` gains
  `data-dir-writable` (fail / unknown, never pass on unknown); the policy and
  placement shadow reports say "the shadow could not write here (permission)"
  when the file is missing and the dir is not writable.
- Consequence for A2: the shadow review clock restarts from the 2026-10-16
  chown. Nothing recorded before it is evidence of agreement.
- Still open: `install.sh` chowns the volume on a fresh install, but a volume
  teploy creates on a later deploy (as here) is not re-owned; making teploy or
  the image entrypoint own that step is a teploy-cli question.
## 2026-10-16 — D3 (S03) follow-up continuity: measured, context gap fixed

Read end to end on `477529a` (web composer → `runs/[id].tsx` follow-up
action → `enqueueRun` → durable `repo-setup` → prompt → publish). Line
numbers are on `477529a`.

| Question | Before | Evidence |
| --- | --- | --- |
| (a) prior transcript / faithful summary | **Gap.** Context was each ancestor's request plus `agentSummary ?? summary`, up to 20 runs, tail-sliced to 36k chars. A failed or cancelled run (no `run-completed`) contributed the literal "No final result recorded" — exactly the runs most likely to be followed up. No plan, no verification results, no pushed head or changed files, no critic notes, no scan findings. Prior agent claims were not distinguished from recorded facts. | `web/src/routes/runs/[id].tsx:160-162`; `web/src/lib/workspace.server.ts:38,44-51` |
| (b) recorded head/branch, not main | **Correct for the branch; head is the PR's current tip.** With a PR the action resolves it live (`freshForge`) and enqueues `pr`; the worker fetches the PR head branch and checks it out (`setupRepoForPr`), so the follow-up builds on the earlier run's pushed commits, not main. The commit is whatever the PR head is at checkout, which differs from the earlier run's recorded push if anyone pushed since; nothing told the agent that. | `runs/[id].tsx:164-170`; `src/runtime.ts:1426-1427`; `src/durable.ts:1287-1295`; `src/git.ts:746,766-794` |
| (c) same PR updated, no new PR | **Correct.** `input.pr` takes the review-follow-up publish branch: push to the PR branch, `repo-comment` on the same PR, amended Verification section, no `repo-pr`, no auto-merge. Closed/merged PRs are refused at launch and again at checkout (`requireOpenPr`). Forge review comments on the PR are read into the prompt (`pr-review-comments`). | `src/durable.ts:1454-1470,3127-3171`; `src/git.ts:746` |
| (d) prior steering notes | **Gap.** Drained notes live as `turn-N-steer` step results; nothing carried them into the follow-up. | `web/src/lib/thread-chain.server.ts:115-137` (where they are read for the view only) |

Fixed (branch `fix/followup-continuity`): `src/prior-run-context.ts` renders
a bounded digest per ancestor from its own event log — request, outcome
(incl. the run-failed error and the failing step), approved/edited/rejected
plan, delivered steering notes, push sha + PR, changed files from the pushed
diff, baseline/build/suite results (+ failing output tail), then the agent's
final summary, critic notes and scan findings under explicit "claim" labels.
Every quoted line is prefixed `> ` so a claim cannot forge a "Recorded"
header. Whole block capped at 36k chars, oldest runs dropped first. The PR
head the forge reports at launch is compared with the recorded push and a
move is stated. It is materialised into `input.task` at enqueue (as before),
so replay reads recorded text; no step was added (fingerprint unchanged).

Tests: `src/prior-run-context.test.ts` (real durable path: an ordinary run
opens PR #1, then a follow-up with the materialised input checks out the
same branch at the recorded head, pushes on top of it, comments on PR #1,
opens no PR, and its first prompt carries the block; the ordinary run is the
negative control with no block; forgery negative control; size bound; head
move) and `web/src/lib/workspace-actions.test.ts` (failed parent → error and
steering note reach the child's input; "No final result recorded" gone).

Still open (bounded, not fixed here): ask-park questions/answers are not
carried (the thread view shows them); a run that pushed but never opened a
PR offers no PR target, so its follow-up starts from the default branch and
loses the pushed commits; the follow-up's head is the PR's current tip by
design (now reported when it moved), not pinned to the recorded sha.

## 2026-10-16 — X7 (S20) claim ledger in CI, seeded claims re-checked

- `node scripts/claim-ledger.mjs --check` now runs in CI: a `claims` job in
  `.github/workflows/ci.yml` and a step in `.forgejo/workflows/ci.yml`.
- Every cited automated test was re-run green at `477529a` and its revision
  updated. Changes of status: `harness.native-steering` provisional ->
  supported (the route refusal it lacked now has tests,
  `web/src/lib/steer-refusal.test.ts`); `harness.external-refuse-plan-review`
  gained the admission-time test. `model.default-quality` and
  `git.env-credential-mode` stay provisional (no pinned commit; S01 live items
  open); the two open and two disclaimed claims are unchanged.
- Added at the level reached: `perception.look-live`, `store.postgres` and
  `auth.admin-bootstrap` are supported and verified on production evidence at
  an exact revision (look soak receipt at `25d592a`; the bootstrap's recorded
  production log line at `03748ab`). `resource.browser-class`,
  `delegate.coordinator` and `thread.view` are provisional: tested, not
  enabled or not proven live.
- Still open: `--stale` compares the cited PATH at the evidence revision, so
  system evidence whose receipt was written after the observed revision is
  always reported stale (3 such entries now). CI runs `--check` only; the
  stale report needs a per-evidence "recorded at" field before it can gate.
  Tests are still cited by name only (the script checks the name exists, not
  that it ran).

## 2026-10-16 — ship-backup.sh predates the postgres store — FIXED IN CODE (A0), live rehearsal pending

`scripts/ship-backup.sh` tars `accessories/nucleus/nucleus-data`, which no
longer exists on a postgres-store install (it dies with "engine data dir
not found"). Until fixed: use `teploy accessory backup postgres --bucket …`
(S3 path) or a cold pgdata tar of the bind dir — the soak's pattern
(`/root/ship-pgdata-pre-look-soak-2026-10-16.tgz`, sha256 sidecar, gzip -t).
Fix = teach the script the postgres layout (pg_dump of the accessory or
cold tar of the bind mount) with the same verify/rehearse discipline.

**Update 2026-10-16 (A0, branch `fix/backup-postgres`):** fixed in code.
The script detects the store (writer `--store` args > `$SHIP_ROOT/teploy.yml`
> accessory containers/dirs; disagreement refuses; `--store`/`SHIP_STORE`
override). Postgres default = `pg_dump -Fc` via `docker exec` into
`ship-postgres` (online, one snapshot, no stop), `.sha256` sidecar, manifest
with per-table row counts read back from the archive; `verify` = checksum +
PGDMP header + `pg_restore --list`; `restore` = NEW scratch container +
count check (left running); `rehearse` = scratch postgres, `pg_restore
--exit-on-error`, table set + every count must equal the manifest, then
`preflight --store postgres` when a teploy-ship is available. `--cold` = the
soak's pgdata tar under the nucleus stop rule, rehearsed by booting a
scratch postgres on the copy. Nucleus path unchanged (its tests pass
unmodified; a negative control pins its manifest keys and no pg calls).
`teploy-ship snapshot` now refuses on a postgres install with a pointer to
the script instead of a bare "not found". Verified locally against a real
throwaway `pgvector/pgvector:0.8.0-pg17` (backup, verify, rehearse incl. a
tampered-manifest negative control, restore, cold tar + boot) and manually
with the REAL `teploy-ship preflight --store postgres` on a rehearsed copy.
**Still open:** the live rehearsal on infra-home against the production
store (archive + sha256 + rehearsal receipt — A0's exit criterion); this
lane did not touch production.

## 2026-10-16 — initial admin bootstrap (port of observe's EnsureAdmin)

- `bootstrapAdmin()` (src/bootstrap-admin.ts) provisions the FIRST local
  account from `SHIP_BOOTSTRAP_ADMIN_USER`/`SHIP_BOOTSTRAP_ADMIN_PASSWORD`
  (teploy secrets) at WEB process boot only (web/src/lib/store.server.ts,
  gated on the env so existing imports stay inert). Before this, nothing
  called setPassword/create: no CLI, no bootstrap, so the break-glass
  SHIP_WEB_TOKEN was the de-facto login on every fresh install.
- Semantics ported from observe, adapted to ship's stores: no-overwrite
  (any existing local principal skips it entirely), an atomic once-ever
  claim BEFORE the create — KV setNX (`ship:bootstrap:admin`) on
  nucleus/postgres runtimes, the delegation ledger's withFileLock +
  runtime-config read-check-write on the file runtime — value-conditional
  release on a failed create, validate-before-claim through the users
  store's own (now exported) policy, one success line naming the username
  only, and a precise one-line refusal when exactly one of the two
  variables is set. Password is never logged.
- ATOMICITY CEILING (stated in the module, same as everywhere else): the
  file-runtime claim is in-process only — file mode is single-process by
  construction; the cross-process boundary is the KV setNX on the shared
  store. The narrow claim-then-crash window leaves bootstrap closed with
  the master credential as the admin way in (documented in DEPLOY.md).
- `NOT_FOR_A_WORKER` now drops the bootstrap pair from join bundles: the
  worker never runs the bootstrap and should not hold its password.
- Verified: `pnpm run lint`, `pnpm test` (12 new bootstrap-admin tests:
  create+claim, idempotent second boot, no-overwrite, one-variable
  refusal, no-password-in-logs across happy/error paths,
  validate-before-claim, in-process file-runtime race, two-process KV
  setNX race, value-conditional release + retry, FileUserStore interop),
  join drop/redaction assertions, `cd web && pnpm test` and
  `cd web && pnpm run build`. Verified LIVE against the built web server
  (file store, isolated state dir): boot with both secrets creates the
  admin with one log line, password login returns the admin session
  cookie, a wrong password is refused, a second boot is a silent no-op
  (users.json byte-identical), and the password appears in no log or
  state file. NOT verified live: the same boot against a real
  nucleus/postgres store — the KV setNX claim path there is seam-tested
  only (two-runtime race over one shared KV map).
  **Update 2026-10-16:** LIVE-PROVEN on production — the bootstrap ran at
  first correctly-built boot on the postgres store (atomic claim → create →
  once-ever; log line `bootstrap admin: created initial admin user "Tyler"`).
  The gap is closed; only the no-CLI note below remains.
- Still open: no CLI for account management (create/reset password from
  the console) — dashboard-only for now, honestly noted in DEPLOY.md.

## 2026-10-15 — resource classes: browser runs admitted on their real footprint

- A run whose input carries `look` (SHIP_LOOK, default off) is now a
  **resource class** (`src/resource-class.ts`), not only a prompt capability:
  its create carries `Limits.MemoryMB` raised by `BROWSER_MEMORY_DELTA_MB`
  (512 MB — the top of the measured ~300-500 MB browser overhead from
  `evals/receipts/2026-10-14-egress-proxy-browser-proof.txt`, on top of
  docs/capacity.md's 400 MB plain run), its placement requirement (the S26
  requirement seam in placement-shadow.ts) demands `browser: "headless"`,
  and admission accounts its real footprint: `capacityPlan`'s free-memory
  term subtracts in-flight browser deltas, and a browser run launches only
  above a memory floor raised by the same delta (`hostHold`'s third
  parameter, checked in `driveOne`; the run stays due — the takeover-hold
  queue shape, and plain runs are not held behind it).
- Wired through the EXISTING funnel, no parallel admission path: the class
  rides `sandboxOverridesOf` beside the network tier (create and every
  restore path), `definedOverrides` drops it before the daemon wire (the
  daemon rejects unknown fields), and the limit raise lands in the worker's
  host-sized seam (`resolveSandboxLimits`, exported so precedence and the
  raise are pinnable without a running worker).
- Default-off: plain runs resolve byte-identical overrides, limits and plans
  (pinned per seam); no run carries the class unless SHIP_LOOK was set at
  enqueue. Placement enforcement is still shadow-only — S26's status is
  unchanged by this.
- Verified: `pnpm run lint`, `pnpm test` (2257 runtime + 242 scripts pass,
  0 fail; the three grader-matrix scripts failures seen in one intermediate
  run fail identically on pristine main when they appear — the documented
  agent-sandbox flake). NOT verified live: a real look run admitted on a
  squeezed box; the delta's adequacy beyond one page (512 is the daemon's
  shm quantum, not a measured browser-RSS ceiling); `pids` left untouched
  (the receipt's 256-pid limit under multi-page sites is unmeasured).

## 2026-10-14 — Postgres store support (code; not yet released or deployed)

**Update 2026-10-16:** released and live. Production web and worker run on
the postgres store (look soak receipt at `25d592a`, then `03748ab`); see the
`store.postgres` claim in docs/CLAIM_LEDGER.md. The heading is historical.

- `--store postgres` (config, CLI flags, SHIP_STORE in the web app) runs the
  same shared-store runtime against real PostgreSQL: `NucleusPgwire` gains a
  dialect, and its KV and stream surfaces — Nucleus engine built-ins
  (`KV_SETNX`/`KV_CDEL`/`KV_CEXPIRE`, `STREAM_XADD`/`STREAM_XRANGE`) — are
  reimplemented over plain tables (`ship_kv`, `ship_stream`) on that dialect.
  Documents/SQL were already standard. The `nucleus` dialect and path are
  unchanged: the live infra-home instance is untouched by this change.
- KV semantics preserved and pinned by new tests: set-if-absent with TTL
  lapse re-opening the key, value-conditional cdel/cexpire (a rival never
  releases another's claim), ordered per-stream reads for the SDK's
  NucleusEventStore (append return value unused; full-range read).
- code-index on postgres uses pgvector (CREATE EXTENSION, `vector(n)`,
  hnsw `vector_cosine_ops`, `<=>`); the Nucleus DDL/operators are unchanged.
- Motivation is upstream: Nucleus v1.1.1's live defects (UPSTREAM_BUGS
  2026-09-24, recurrence 2026-10-12). No Nucleus/Neutron fix was made from
  this repo. The catalog default flips to PostgreSQL in the templates repo,
  gated on a teploy-ship release carrying this change.
- Verified: `pnpm run lint`, `pnpm test` (236 pass / 1 pre-existing skip),
  `cd web && pnpm test` (176 pass), `cd web && pnpm run build`. A live
  run against a real Postgres has NOT happened yet — do that before release.
- **Correction 2026-10-16 (X11):** the line above is stale. The postgres
  store was released and deployed on 2026-10-14 (docs/MIGRATE_STORE.md;
  data copied by scripts/migrate-store.mjs) and production has run on it
  since — web+worker `03748ab` (store: postgres) per NEXT_SESSION.md; the
  nucleus accessory was retired 2026-10-15 (teploy.yml). The entry is kept
  as written; this note supersedes its "not yet released or deployed" and
  "has NOT happened yet". `teploy-ship doctor` now answers for the postgres
  store too (`--store`/`SHIP_STORE`/config: kind-labelled store checks, a
  shared store with no URL fails, and a `store-engine` check that fails a
  kind/engine mismatch via `SELECT version()` and stays unknown when the
  engine does not identify itself).

## 2026-10-04 — wave 5 (live: S02 batch, production upgrade, shadows on)

- Production ship web+worker upgraded `dd5b13e` -> `80c9187` (coordinated
  stop; pre-deploy backup `pre-80c9187-shadow-deploy-2026-10-04` verified;
  the five waiting runs survived intact; gateway stayed at `c0b07dd`).
- Shadow flags set on production: `SHIP_BUDGET_RESERVATION`, 
  `SHIP_MODEL_ROUTING`, `SHIP_PLACEMENT`, `SHIP_TOOL_MANIFEST`,
  `SHIP_KNOWLEDGE_PROVENANCE` = shadow, `SHIP_POLICY_SHADOW=on`.
  `SHIP_MODEL_ROUTING` shadow logs "no usable policy" until
  `SHIP_MODEL_ROUTING_POLICY` is set — setting that policy is now the
  unblock for that shadow's logs. Shadow-log review before any `on` flip
  is still the rule (see NEXT_SESSION.md).
- S02 executed (A only, $0 real spend): see
  `evals/product-journeys/BATCH_2026-10-04.md`. Upstream reports filed
  (neutron#6, teploy-cli#18/#19/#20 — links above/below).
- The integration-check test-quoting defect (spaced checkout paths) was
  fixed in PR #56.
- **S08 PR-body/webhook surfacing built (PR #58, this wave):** the detector's
  findings now reach the pull request's Verification section and the
  run-completion webhook behind `SHIP_TEST_INTEGRITY_SURFACING=off|shadow|on`
  (default off; invalid values are off with a log). Advisory only — not a
  gate, not in the delivery record, and no step is added to the durable log
  in any mode. The one step-sequence effect, under `on` only: a run whose
  only verification part is an integrity finding now records the existing
  `verification` step. Clean diffs surface nothing (pinned by test). Not one
  live run; soak `shadow` on the real worker and read its logs before any
  `on` flip, the same rule as the other shadows.

## 2026-10-04 — wave 4 (S07, S13, S15/S17, S19, S21, S22, S24, S26, S27)

All off by default or observe-only; flags are in the programme's wave-4 table.

- **S27 Teploy adapter (PR #54):** flag off. When on, it is stricter than the
  legacy path (unreadable status, including a brand-new destination, holds).
  A manual `teploy deploy` landing inside Ship's deploy is overwritten and still
  reads back confirmed; the lease serialises Ship's own releases on one host
  only. Upstream feature requests (filed 2026-10-04): deploy dry-run
  ([teploy-cli#18](http://100.108.123.49:49152/Tyler/teploy-cli/issues/18)); deploy generation
  and compare-and-set in `status --json`
  ([teploy-cli#19](http://100.108.123.49:49152/Tyler/teploy-cli/issues/19)); documented `logs` flags and a
  no-deployment-versus-unreachable signal
  ([teploy-cli#20](http://100.108.123.49:49152/Tyler/teploy-cli/issues/20)).
- **S21 (PR #51):** provenance is a sidecar, not fields on the note. Project
  scope is repo-only. Pre-flag notes read as unknown. Run `shadow` and read the
  logs before `on`.
- **S24 (PR #52):** host and secret findings cannot fire until the executor or
  credential layer reports hosts contacted and secrets injected. Enforcement is
  untouched and stays with that layer.
- **S26 (PR #48):** records disagreements only; the sandbox pool still fails a
  run whose host dies.
- **S13 (PR #50):** probes are test-only; five operations unprobed.
- **S15/S17 (PR #46):** inert; callers must redact log excerpts.
- **S22 (PR #47):** the coordination record does not keep the revision the
  client was planned against.
- **S19 (PR #49; tail landed 2026-10-04):** doctor now answers store liveness
  and clock skew read-only when `NUCLEUS_URL` is set (unknown otherwise, and
  unknown when the engine answers no time query — honest, not a gap to paper
  over); `teploy-ship snapshot` / `restore-check` exist with the script's
  invariants. Still open: the unpack and rehearsal remain script-only by
  design; restore-readiness has no command; none of the S19 tail has run
  against a live store.
- **S07 (PR #53):** wired at the plan park 2026-10-04 behind `SHIP_PLAN_GROUNDING` (default off): the grounding report is an additive `grounding` field on the `plan-think` step result — no durable step added, flag-off bytes unchanged — and the run page's plan-review card renders it as advisory text with the name-existence caveat. Still open: the rest of S07 (planning-time use beyond the park, other consumers).
- **Agent hygiene:** parallel agents share one scratch directory and the fixed
  grading port 8901. A backup-file collision corrupted one agent's mutation
  backup (caught and fixed before push) and spurious grader-test failures
  appeared only in agent sandboxes. Later waves told agents to use their own
  directories and skip those tests locally.

## 2026-10-04 — wave 3 wired behind flags (S01/S04, S05/S06, S09, S11, S16, S18, S23, S25)

All off by default or observe-only; see the programme's wave-3 table for flags.
Items an operator or reviewer should know:

- **Default-on behaviour that is new:** `SHIP_SAFE_FETCH` defaults to shadow, so
  each forge API call does one extra background address lookup and may log a
  one-time warning per host. The request is never changed. Enforcement needs
  `SHIP_SAFE_FETCH=on` and, for a private forge, `SHIP_SAFE_FETCH_ALLOW`.
- **Kernel fix (PR #38) changes behaviour where it was broken:** a cell blocked
  past its timeout is now interrupted instead of the kernel being killed.
  POSIX-only. The original `TS-019` flake was not reproduced, so the cause is
  unproven; keep watching for it.
- **`SHIP_BUDGET_RESERVATION=on` is single-process only.** It is refused off the
  file runtime, but two file-runtime processes on one host cannot be detected.
- **`SHIP_MODEL_ROUTING=on` cannot switch mid-run** until `durable.ts` feeds the
  tool-call journal; side effects are treated as uncertain.
- **`SHIP_POLICY_SHADOW` records disagreements only**, so no rate is available;
  a missing record file means unknown, not zero.
- **S16 overlap** scans only the 200 most recent runs and does not count a task
  proposed but not yet launched.
- **S05 digest** is recorded but not compared; readiness staleness is unchanged.
- **S09** forge thread resolution is read but not used; GitHub's REST API does
  not expose it.
- **S18** has no worker wiring: nothing provisions the trees or runs the check.
- Earlier "unwired" notes for S09, S11, S16, S25, S01/S04 above now read as
  "wired behind a flag, observe-only or off by default".
- The three scripts-suite failures several agents reported (grader matrix,
  deploy-recovery reference, report totals) did **not** reproduce in CI on
  any wave-3 PR; they appeared only in agent sandboxes. Parallel agents sharing
  the fixed grading port 8901 is the leading suspect, unproven.

## 2026-10-04 — grader sensitivity and UI audit (S02, S10)

- **Eight product-journey graders were too weak and are tightened (PR #34).**
  Eleven wrong-but-plausible variants passed the previous graders; ten were
  defects (see the programme's S02 graders row). Recorded results under
  `evals/product-journeys/results/` were not re-graded, so earlier pass counts
  were scored under the looser graders and must be quoted with that caveat.
  The `pj-s-feature` placeholder acceptance is a deliberate known limit.
  Re-grading retained runs is possible only where their trees were preserved
  (only `eval-20260924-16` could be checked; it still passes).
- **UI audit (PR #33), deferred:** 79 sub-24px compact targets (design
  decision), the framework's plain-text 404 for unknown paths (upstream
  candidate for Neutron, with reproduction in `docs/UI_AUDIT_2026-10-03.md`;
  not yet filed), and human observation of target users.

## 2026-10-03 — wave-2 modules landed unwired (S06–S28), and what each leaves open

These modules are merged with tests but no route, worker or UI calls them, so
they change no behaviour. Each is "checked", not "verified"; per-package
detail is in the programme's wave-2 status table. Items that matter for audit:

- **Delivery (PR #12), fixed:** config-identity digest, stuck-rollback
  reconciliation, unbounded due/rollback reads, unknown-state escalation.
  Still open: `destination` enforcement (proposed grammar `app:<name>`,
  `server:<host>`, `addr:<host:port>`; bare strings stay legacy and
  unenforced; check `teploy status --json` before build, hold on a readable
  mismatch, treat unreadable as unverified). The digest covers
  `<SHIP_DELIVERY_DIR>/teploy.yml`, not the merged-tree file. Legacy executing
  rollbacks without `claimedAt` are not reaped.
- **S11 budget ledger (PR #13):** unwired and single-process only; cross-process
  atomicity waits on a Nucleus conditional write.
- **S01/S04 safe-fetch (PR #14):** unwired; user-supplied repo URLs still reach
  forge fetches without destination validation.
- **S09 continuity (PR #15):** unwired; reviews do not yet carry findings across
  revisions; thresholds unvalidated.
- **S05 stack-detect (PR #17):** unwired; readiness still keys on project
  config only, not manifest, lockfile or recipe digest.
- **S08 test-integrity (PRs #18, #31):** advisory-only on the run page; not a
  gate; PR-body/webhook surfacing landed in wave 5 (PR #58) behind a
  default-off flag; false-positive rate unmeasured.
- **S16 schedules (PR #24):** the overlap policy is inert in the worker until
  `sweepWorkflowSchedules` is given `isRunning`.
- **S25 policy (PR #25):** tested pure core, no enforcement; every entry point
  still applies its own limit independently. The service-account role needs
  product confirmation.
- **S26 placement (PR #26):** `sandbox-pool` still fails a run whose host dies;
  `onHostLoss` defines recover-versus-fail but is not adopted until wired.
- **S27 adapter (PR #27):** Teploy has no destination-level fence, so a manual
  `teploy deploy` can race a tracked delivery; a destination lease is needed
  before a Teploy adapter may declare fencing. Upstream feature requests (not
  defects): a Teploy CLI dry-run, and a status field exposing a deploy
  generation. Filed 2026-10-04: teploy-cli#18 and #19.
- **S13 (PR #28):** the steer-route refusal has no automated test.
- **S21, S22, S23, S24, S06:** modules exist unwired (PRs #22, #19, #21, #23,
  #29); see each PR's wiring list. The tool-manifest schema is strict, so a
  manifest from a newer minor version is rejected.
- **S02 recount (PR #11):** per-run `summary.json` totals for runs
  20260924-3, -4, -6, -7, -9, -10, -11 count not-wired `unknown` and
  `harness-error` as fail. The recount is authoritative; do not rewrite the
  summaries.
- **Flaky test, to investigate (not skipped):** kernel `TS-019` ("a cell that
  outlives its timeout is cancelled") failed once in a loaded full-suite run
  and passed alone and on retry. Timing sensitivity; a robustness fix is owed.

## 2026-10-03 — devalue advisories (web dependency, re-triage)

CI `audit` began failing on three new high-severity `devalue` advisories
(GHSA-j22f-vq7h-c4qm, GHSA-mcm9-63f2-9j32, GHSA-x5rw-q4pp-hg5g; vulnerable
`<=5.9.2`, patched `5.9.3`), reached through `@neutron-build/core` in the web
tree. The 2026-09-23 re-triage below recorded devalue 5.9.2 as clean; the
advisories were published afterwards, and `main` was last green on 2026-09-27.
The pinned override moves to 5.9.3 in `web/package.json`,
`deploy/package.web.json` and both lockfiles (regenerated with pnpm and npm,
not by hand). The Neutron core package is not patched or vendored differently;
if Neutron later pins devalue itself, the override can be dropped.

## 2026-10-02/03 — S01 Git credential placement (first-batch item 4, partial)

Audit of `src/git.ts`: the forge token is embedded in the URL of `clone`,
`fetch` and `push`, and for `clone`/warm-volume `fetch` it was written into
`.git/config` and scrubbed by a *separate* executor call. A worker death or a
half-failed clone between the two calls could leave a token resting in a warm
volume the agent can read. **Fixed (this change):** clone and the warm fetch
now scrub the remote in the same shell invocation, whatever the credentialed
step's status (`cloneCredentialFree`, `reuseRepo`). Pinned by a same-shell
sequencing test that fails on the previous code, plus a failed-fetch probe on a
real `LocalExecutor` checkout (a regression pin: the old catch path also
scrubbed, so that probe passes on both versions).

**Env credential mode (2026-10-03, implemented, OFF by default):**
`SHIP_GIT_CREDENTIAL=env` sends the credential in the git process's
environment as an origin-scoped `http.extraHeader` (`GIT_CONFIG_COUNT`, git
2.31+), with the URL left clean, so the token is in no command line and no
config file. It covers clone, warm fetch, push, PR-head fetch, rebase fetch and
force push (`gitCredential` in `src/git.ts`). Proven: a real `git clone`
against a local HTTP server received the Basic header on every request while a
recording executor saw the token in no command and `.git/config` held none; the
same probe fails in argv mode (negative control). Default behaviour is
unchanged.

**Still open before the flag can be turned on or the item closed:** (1) the
Sandbox daemon must forward per-exec `env` to the process — unproven; if it
drops it the failure is a forge authentication error, not a silent downgrade;
(2) the sandbox image's git version must be 2.31+ — unchecked; (3) a live
private-repo clone and push through the real sandbox on both Forgejo and
GitHub; (4) argv mode remains the default, so until then the token is visible
in git's command line for the process lifetime. Owner: Ship with Sandbox. No
upstream Neutron/Nucleus defect is asserted; if the SDK or daemon's `env`
handling drops values, that is an upstream report to write then.
Also not verified here: snapshots/logs of past runs for token residue.

## 2026-09-27 — coordination on a minimal installation

Coordination children inherited disabled change/merge gates, so successful PR
publication ended their runs without the merge receipt required by the pair.
The API was marked failed and held the client even after a separate forge merge.
New coordination children now explicitly request classification and the existing
merge boundary; operator approval and authority rechecks remain in that path.
Regression coverage reproduces the missing flags and checks both children.
Existing failed pairs are not rewritten or treated as merged; external merge
reconciliation and the full live producer/consumer run remain acceptance work.

## 2026-09-25 — database retry pressure

Fresh-connection retries bypassed the four-connection pool without a concurrency
limit or connection deadline. Concurrent pool timeouts could therefore amplify
connection pressure. Each client now allows at most four fresh retries, refuses
excess retries with the original error, and applies a five-second connection
and 30-second query timeout. Cleanup restores capacity even when construction
fails. This contains retry fan-out; it does not establish the cause of the
observed database stalls or claim those upstream stalls are fixed.

## 2026-09-25 — narrow-screen decision cards

Long request-derived run IDs made Inbox approval rows wider than the phone
viewport. Approval rows now wrap; IDs wrap within the available width and keep
the review action visible. A temporary style applied in the shared browser
removed the measured document overflow. Repository web checks and deployed
read-back remain required.

## 2026-09-25 — deployment history verification

The operator history digest used to replace failed event-store reads with empty
histories, potentially certifying an incomplete read as a successful comparison.
It now aborts without emitting a digest if any stream fails to load. Regression
coverage checks read failure, repeatability and changed event detection. A digest
still requires a quiescent boundary and a separately verified backup; it does not
establish that the database contains every expected run.

## Akiroo remediation — 2026-09-12

The [delivery contract](docs/AKIROO_DELIVERY.md) records the paired receiver/sender
change and recovery limits. Failed actions now retain explicit receipts instead
of being treated as success; notification sends use the durable outbox, retries
retain owed events, and chronology is carried on the wire. First project sync
protects existing settings; allowlist checks precede storage; managed test
commands update/clear their legacy alias too. No workflow steps changed.

`e7f889a` is committed, pushed and deployed on both Ship processes, after
Akiroo's receiver upgrade (`5038c7f`, then compatibility follow-up `88ab576`).
Verified lint/build, 1,137 main + 40 script tests, 67 web tests/build, and the
isolated Nucleus receipt probe. Live preflight reports one waiting run, zero
incompatible/unrecorded runs; deployed worker/outbox/connector hashes match the
tested build, login is reachable and collection resumed. No run was approved.
A coordinated Nucleus snapshot (LSN 1650451) is retained privately and restored
successfully into a disposable container. This is not the full end-to-end proof.

SKIPPED (separate design/operational proof): crash recovery before a
notification intent is enqueued; one-shot project/revert notifier recovery;
commit-bound verification and independent forge merge synchronization;
warm-volume approval restoration; settled multi-attempt cost propagation
(upstream event support); historical repair; retention/capacity policy for
durable receipts and overdue retries. PARTIALLY ADDRESSED 2026-09-22: unknown
MERGE outcomes are now reconciled by provider read-back (`mergePullRequestReconciled`,
`git.ts`) with an honest `merge-unknown` recorded outcome — the remaining
effects (push/comment/preview windows) stay on this list. Acceptance:
fault-inject each boundary, restart the actual worker, prove one approved
standalone and milestone loop, and reconcile the same tested, merged and
deployed revision without duplicate external effects. These are not
cosmetic tasks to delegate without the integration context.

SKIPPED (upstream): Nucleus v1.0.2 arm64 image still fails at startup with a
GLIBC_2.38 mismatch. The matching production amd64 image passed the isolated
receipt probe. Reported in the private upstream register; no vendor patch or
upstream release was made.

Unresolved findings for this repository from the ChatGPT-led audit series (2026-09-09 through 2026-09-11, passes 1-5; register: teploy-neutron-lullmail expanded audit). Every P0/P1 finding has been fixed and verified; the items below are the remaining P2/P3 tail plus one item needing validation. Fields are quoted from the audit register; line references point at the review commits listed per item where recorded.

Open items: 1 P2 improvement (1 total)

## useteploy__teploy-ship-04 - P2 - Open improvement

**Treat command regexes as advisory classification, not an enforcement boundary**

- Kind: Improvement
- Evidence: defaultApprovalPolicy and sandboxApprovalPolicy classify raw Bash/Python source with lists of regular expressions. Equivalent operations expressed through other commands, APIs, indirection, or argument forms are not necessarily recognized.
- Impact: A textual classifier cannot guarantee that every destructive or durable external action receives approval. This matters most for the trusted-local executor; it is not evidence of an escape from the separate sandbox implementation.
- Proposed fix: Keep mandatory filesystem/network/credential restrictions in the executor boundary and use explicit capability-scoped tools for durable external actions. Document the limits of heuristic classification and expand tests with semantically equivalent benign command forms.
- Acceptance test: Build a policy test corpus for equivalent argument spellings and API-based operations; verify enforcement through the executor does not depend solely on matching a particular source-code string.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)


## Resolution log (2026-09-12)

- teploy-ship-01, -02, -06, -07: FIXED - see audit commits (safe-csv is opt-in via --safe-csv; raw output unchanged).
- teploy-ship-05: PARTIALLY FIXED - the export now prefers a settled costUSD recorded at completion and labels recomputed rows costEstimated. UPSTREAM HANDOFF: writing the settled cost onto the run-completed event belongs to the vendored @neutron-build/agents run loop - report upstream (Neutron), then this export picks it up with no further change.
- teploy-ship-04: DEFERRED (design) - moving from heuristic command classification to capability-scoped executor boundaries is an architecture project; until then the regexes stay advisory (documented).

## 2026-09-19 — dashboard usability pass

- Fixed Settings' Team/System switcher rendering identical content. Settings
  now has overview, execution, connections, team, and advanced views; deployment
  values are explicitly read-only, secrets stay masked, and editable project,
  approval, and account controls are linked from the overview.
- Reworked the shared shell, typography, spacing, accessible navigation, form
  controls, and mobile layouts. Tables scroll inside their own containers.
- Added a multiline task composer with configured-repository suggestions,
  server-rendered run search combined with status filters, readable run dates,
  and task-first run headings. Project options are grouped under execution,
  verification, and automation disclosures. No worker steps or policy changed.
- Validation: lint, 1,151 runtime + 40 script tests, 76 web tests, web typecheck
  and production build. Isolated Chromium checks cover settings separation,
  team creation, search/filter/clear, task submission, and desktop/tablet/mobile
  layouts. Production preflight before rollout: five waiting runs, all safe,
  no executing runs and no incompatible or unrecorded workflow fingerprints.

### Visual correction — preserve the Teploy identity

Restored the original top navigation, monospace typography, palette, title
sizes and controls after user feedback. Settings navigation uses horizontal
pills; counts and overview links are compact. The functional settings split,
search, multiline composer and clearer project forms remain.

## 2026-09-19 — task workspace and team workflows

Added run conversation/changes/verification/activity views, governed linked
follow-ups, shared workflow templates, guided project registration and
configuration checks, and bounded service diagnostics. Published runs retain
a diff snapshot; browser-flow recordings have bounded attachment support.
Existing workflow step sequences are unchanged. Settings no longer evaluates
worker-only environment metadata in the browser. The shared Teploy shell and
visual tokens are preserved. Scope and remaining competitor distinctions:
[Working in Ship](docs/WORKSPACE.md).

## 2026-09-19 — environment and review integration

Added recorded project preparation, real environment verification, worker-side
PR/CI/review reads, fresh-PR validation for follow-ups, bounded conversation
lineage, tracked-file inspection, interval workflow schedules through existing
intake policies, and authenticated content-addressed PNG/WebM artifacts.
Run pages now update in place, preserve drafts, render formatted conversation,
and support a side-by-side review while retaining the Teploy shell.

New workflow steps are gated only on recorded preparation/environment-check
inputs; preflight reports all five existing waiting runs compatible. Live
Nucleus testing established its inline-row size constraint: artifacts use 8 KiB
base64 chunks with manifest-last writes and integrity checks. Workspace replies
are bounded to fit the same store. The Neutron dev returned-Response defect is
reported upstream; resource loaders throw Responses as a compatibility path.

Remaining distinct work: writable IDE/terminal/browser takeover, sandbox
continuation across terminal runs, arbitrary-stack auto-provisioning, wider
connector coverage and measured competitor coding-quality comparisons. This
change adds interval schedules and forge reads, not automatic merge
reconciliation or a general workflow graph. See docs/WORKSPACE.md.
(Partially superseded 2026-09-23: the takeover panel now carries a
screenshot-driven browser tab — S12 wave 9, src/takeover-browser.ts —
leaving a full IDE and sandbox continuation as the open items.)

## 2026-09-21 — journey foundations and simple team requests

Project-based change/question/plan/review requests, approval-only team intake,
requester-visible history, draft retention and clearer task status. Non-change
journeys materialize scan inputs before execution; older workflow-plan semantics
remain unchanged. Visible PR reads refresh automatically, without granting merge
authority. Project readiness receipts detect configuration drift. New snapshot
restores refuse invalid checkouts before agent execution. Intake claims now carry
the intended run ID in both launch paths so reconciliation can recover interrupted
launches. Full persistent interactive workspaces, automatic merge reconciliation,
coordinated multi-repository work and release-loop proof remain open.


Verification: 1,167 runtime, 40 script and 94 web tests; production web build;
18 live responsive page checks. A real private fixture completed a question,
standalone plan, UI-approved wording change, baseline/final tests, independently
checked browser/API/SQLite behavior and a merge approved through Ship. The
wording diff contained only the requested label. Real preparation/test receipts
became stale after configuration changed and valid after restoring the exact
tested configuration. A worker timer produced one proposal across repeated ticks
and stopped when paused (the scratch schedule timestamp was advanced for the
test, rather than waiting an hour). The scratch schedule remains paused.

Evaluation found an unsupported claim in an investigation answer and wasted
inline-edit retries: tightened question instructions and explained the editor's
trailing-newline matching requirement. These are mitigations, not proof that
model answers are always correct. `evals/product-journeys` now contains an
independent browser/SQLite grader. Snapshot identity validation has unit coverage;
the latest live plan used a warm retained sandbox, so its successful worker
upgrade/resume is not new proof of snapshot restoration. The wider journey catalogue remains open.


The UI/API search fixture also passed independent name/email, case, whitespace,
literal-wildcard, empty/no-match, stale-response, browser and data-preservation
checks. Its baseline fails the same search grade (negative control). The agent’s
14 tests passed, the PR changed only UI/API/tests, and existing styling was
preserved. An active worker replacement paused publication until the five-minute
repository lock expired, then recovered automatically without manual unlock.
A repeated question corrected the size-limit claim but incorrectly described a
relative database path as relative to the app file rather than the working
directory. Keep factual answer grading open. Empty machine findings are hidden
from the readable response; Activity retains the original output.


Follow-up evaluation found the conversation displayed unconsumed model text after
the first action, including imagined tool output. The UI now uses the executor’s
`transcriptTurn` projection; plan-only prose is exempt because it is not an
execution turn. Regression coverage includes both cases. Independent PR review
found the seeded search regression but mixed in pre-existing issues; prompt scope
attribution was tightened. An expanded browser grade exposed active-filter/save
behavior missing from the first search grade; same-PR correction passed the expanded independent browser grade, including matching and nonmatching saves under an active filter.

Read-only reviews now carry the checked-out SHA into the evidence view, so a
later PR update warns that the recorded results apply to the earlier revision.
The display says “recorded revision” for both reviews and published changes;
a review is never described as having pushed a commit.

## 2026-09-21 — release programme audit started

[Incremental findings](docs/AUDIT_2026-09-21.md): production manifests differed
from tested framework/driver versions and omitted security overrides. Aligned
pins, frozen production lockfiles, deployment seam checks and expanded CI audits
address that dependency drift. Eight web advisory entries are patched; local and
production dependency scans report zero at the time of review. This is not a
completed security audit. Project boundaries, submission idempotency, merge races,
preview authorization and recovery targets remain explicitly open in the report.


## 2026-09-21 — durable launch recovery and project plan floor

Added additive primary-key intake storage and a durable accepted-launch journal,
transactional Nucleus scheduling publication, bounded worker recovery and stable
direct-request submission IDs. Removed the live missing-events claim-release
race; interrupted intake launches have an authorized same-ID Inbox retry. Project
plan-review requirements are enforced at shared enqueue and cannot be overridden
per task. Details and remaining boundaries: [F06](docs/AUDIT_2026-09-21.md),
[upgrade procedure](docs/UPGRADING.md), [adaptive workflow](docs/ADAPTIVE_WORKFLOW.md).

Open: durable follow-up/parent-decision coordination, complete reservation
reconciliation, full canonical multi-forge identity, broader audit/evaluations
and the remaining release programme. Tests and isolated-engine/browser proofs
do not establish whole-product completion or competitor superiority.


## Follow-up recovery continuation

Stable follow-up identities and durable review-parent replacement now cover lost
responses and interrupted launch publication. See the F06 continuation and upgrade
notes. Conflicting held intents, generic approval delivery and external outcome
reconciliation remain open; do not infer full transactionality across the forge.

## 2026-09-22 — recovery, preview identity and workspace inspection

Fixed shared preview worktree/FETCH_HEAD races; new pushed-change previews fetch
the exact commit and use revision-specific slots. Corrected the legacy regression
handler that could invoke production rollback after only deploying a preview.
It now removes the identified preview; historical receipts without that identity
remain advisory. The standalone rollback helper requires an explicit version.

Added governed accepted-launch recovery UI, bounded/cursor-based inspection and
identity-preserving retries. Added live read-only tracked workspace changes,
separate inspection receipts, correct restored-handle attachment and historical
snapshot/restore evidence. Preview revision/image and recovery detail survive the
verification projection. Existing event logs are not rewritten.

Remaining: reconcile unknown external effects, resolve permanently conflicting
accepted intents without overriding decisions, recover warm-volume bytes, enforce
exclusive writable workspace leases, and bind production promotion to trusted
target configuration, artifact digest, approval and retained rollback version.
A successful preview is not evidence that those production guarantees exist.

## 2026-09-22 — S17 incident negative guards (Track D, orchestrator-recorded)

The two S17 negative guards are covered structurally and by unit test, not yet
by a live seeded incident: (1) wrong-service attribution cannot pass —
`attributeServiceMatch` (src/incidents.ts) refuses on zero matches, ambiguous
substring matches, and duplicate exact matches, listing candidates instead of
guessing; (2) an evidence-free diagnosis does not grade as confident —
`gradeDiagnosis` steps down claims without line-level citations and forces
low-confidence diagnoses to report uncertainty and escalation, and the digest
refuses any run whose recorded input is not `mode:"scan"`. Live seeded-incident
proof (alert → attribution → diagnosis with a real wrong-hint attempt) remains
open with the S17 starter.

## 2026-09-23 — wave 9 live findings (resolved 2026-09-24, lane L3; remaining items open below)

### Resolved

- **Browser-takeover screenshots must not ride the runtime config store —
  RESOLVED `f7987c5`.** The BROWSER tab wrote its base64 screenshot (up to
  ~400KB) into the takeover reply on `ship_runtime_config`; Nucleus refused
  the row, the request was re-served every tick (re-running the action and
  renewing the lease, which is why the takeover never lapsed) until the keys
  were cleared by hand. Now: the screenshot is stored in the run artifact
  store (PNG, plus the driver's JPEG fallback, now accepted) and the reply
  carries only `{artifact, bytes}`; the web tab renders the authenticated
  `/api/artifacts/<id>` route and drops malformed references. A failed or
  absent artifact store is an error on the reply ("the action ran; its
  screenshot could not be stored"), never a retried action. Pinned in
  `src/takeover.test.ts` (large screenshot never touches the config store,
  reference round-trips, failed store surfaces once and is not re-clicked)
  and `web/src/lib/artifacts.test.ts` / `workspace-actions.test.ts`.
  Also closed in the same commit: the note at line ~110 ("workspace replies
  are bounded to fit the same store") was not true for takeover replies —
  every request/reply row is now fitted under `WORKSPACE_ROW_BYTES_LIMIT`
  (14 KB).
- **A reply write that permanently fails is bounded — RESOLVED `f7987c5`.**
  Delivery is separated from execution: an unstorable reply is re-delivered
  (never re-executed) up to `REPLY_WRITE_ATTEMPTS` (3), then a terminal
  failure reply takes the marker key (cleared first — that recovers a row a
  refused UPDATE left unwritable); if even that cannot be stored, the
  request key is cleared. One error line per attempt, then silence. Per-
  request isolation in `serveWorkspaceRequests` and per-record isolation in
  `sweepLapsedTakeovers` (which no longer reads reply/history rows). Pinned:
  bounded-then-terminal, terminal-unstorable-clears-request, one run's
  poisoned reply does not starve another run's request in the same tick,
  lapse sweep survives an unreadable record.
- **Park-snapshot restore "starvation" — DISPROVEN as starvation; real
  defect found and RESOLVED `4d4d524`.** Evidence (worker log of
  `ship-worker-b1f8107` + run-af29bf4e's event log, read-only): the
  row-too-large storm ended 21:55:16; plan approved 21:57:45; plan-restore
  created `01M384CV…` and disposed the original `01M382JM…`; merge park
  22:00:18; approve-merge 22:01:57; picked up 22:01:59.23 and failed 43 ms
  later with "the sandbox this run recorded (01M382JM…) is no longer
  available". The C5 liveness probe checked the `sandbox` step's ORIGINAL
  handle on every replay — disposed by the first park's restore — before
  the replay could reach merge-restore. Deterministic for any run with two
  sequential snapshot parks (plan + merge, plan + action approval, ask +
  merge), and for a single snapshot park that outlives the container TTL.
  The probe now reads the run's own log (`DurableAgentConfig.loadEvents`,
  wired in worker and cli) and checks the latest main-workspace handle, or
  nothing when a restore is pending. No step added. Pinned in
  `src/durable.test.ts` (two-park run completes; the old probe target
  reproduces the exact live error; `livenessProbeTarget` unit cases). The
  sweep legs were checked for coupling anyway: each leg in the worker tick
  already had its own `.catch`, and the durable drive loop is separate from
  the sweep chain — the only coupling was per-request inside the workspace
  leg, fixed above.
- **readBackDelivery image comparison could not match ID-form images** —
  fixed in 6a5a69b/b64deee/3beb210 (receipted in the ninth-wave record).

### Still open

- **Nucleus: a refused oversized UPDATE leaves the row so the next UPDATE
  loses it** — reproduced on the v1.1.1 fixture, logged in
  `_internal/UPSTREAM_BUGS.md` (2026-09-24). Upstream-owned; Ship now never
  issues the oversized write and recovers a trapped key by DELETE-then-write.
- **Editor content above ~13 KB.** `TAKEOVER_CONTENT_LIMIT` says 200,000
  characters, but the editor's read reply and write request both ride one
  `ship_runtime_config` row. Before `f7987c5` a larger file poisoned the
  key; now it is refused with a reason ("edit it from the console"). A real
  fix needs a chunked carrier (artifact-style) for text content.
  **2026-09-24: fixed and deployed as ae8f1bb**, using a private run/request-scoped store,
  8 KB chunks, SHA-256 integrity, 200,000 UTF-8 byte cap and 24h expiry.
  A separate real Nucleus v1.1.1 image passed the full 200 KB round-trip,
  cross-run/missing-chunk refusal, empty-file and expiry-prune checks.
  The real sandbox also passed fenced 200KB/empty-file reads and writes.
  Production rolled out with six waiting histories preserved; receipts live
  in `evals/receipts/2026-09-24-editor-content-*`.
- **Screenshot retention.** Every browser action stores one screenshot
  (content-addressed, up to ~300 KB) in `ship_artifacts`, which has no GC.
  Needs a retention rule (e.g. drop takeover screenshots at handback/lapse
  or after N days).
  **2026-09-24: deployed as 2b13447**, seven-day retention for new takeover
  screenshots with separate identities and expiry records. Legacy/permanent
  artifacts are preserved even when their bytes equal an expired screenshot.
  A separate real Nucleus proof passed round-trip, expiry, complete chunk
  deletion and preservation of permanent/newer identical images. The built
  production image passed the full real Chromium proof before rollout.
- **Live proof pending.** The artifact-backed BROWSER display and the
  two-park resume are unit-pinned only; the next live pass should run
  `enqueue --plan` -> takeover with a browser navigate -> approve-merge
  and see both the screenshot and the merge.

## 2026-09-23 — S01 lane: case twins (S01-3) and delta audit of the delivery/promote path

**S01-3 — CLOSED.** The fresh audit's premise ("Forgejo repo names are
case-sensitive") was checked live and is false: Forgejo 14.0.5
(gitea-1.22.0) answered `Tyler/teploy-ship`, `tyler/teploy-ship` and
`TYLER/Teploy-Ship` with ONE repository id (68), and smart-HTTP served each;
Gitea/Forgejo key owners and repositories on their lower-cased names, so case
twins cannot both exist on one instance. GitHub is case-insensitive too. The
rule (src/repository-reference.ts header): http(s) forge paths fold case
(already true for `canonicalRepositoryURL`, now documented and pinned);
`file:` paths never fold; scheme never folds (F03 stands). Remaining
unfolded consumers now fold: the C7 per-repo lock (`repoLockKey` — `Tyler/app`
and `tyler/app` runs could previously execute concurrently on one repo),
repo memory (records land canonical; reads gather every stored twin spelling,
v1 `host/Owner/name` keys included, still gated by the recorded-run proof),
incident remediation's wrong-repo guard, and the trusted-copy marker compare.
Existing stored twins are DETECTED, never merged: `scripts/check-case-twins.mjs`
(read-only SELECTs over projects v1/v2, memory, repo stats, spend buckets,
legacy evidence, reviewer rules; JSON receipt; exit 1 when twins exist).
Not run against the live store from this lane (no live-state access); run it
before/after the deploy that carries this change and keep the receipt.
Upgrade note: during a rolling deploy an old worker keys the C7 lock with the
owner's case and a new one lower-case, so a mixed-case repo can briefly run
two at once across the two builds — same exposure as before the fix, gone
once all workers upgrade.

**Delta audit of bf835ab delivery/promote + wave-9 read-back (6a5a69b,
b64deee, 12f0d85, 3beb210) — FIXED, each pinned in src/delivery.test.ts
("delta audit: …" tests + the rewritten rollback-executor test):**

1. *Deploy failure recorded `held`* (delivery.ts executeDelivery, deploy
   branch). Held means "never touched the target", but a non-zero `teploy
   deploy` (timeout after the container swap) may have changed it. Now
   `unknown` + artifact identity, so the read-back sweep decides.
2. *Unresolvable ID-form image failed the delivery* (readBackDelivery
   `imageIsArtifact`). exec refused / unparseable inspect / no server
   answered "not the artifact" → `mismatch` → `failed` — a lost read
   recorded as a verdict, contrary to the function's contract. Now
   tri-state; unresolved → `unreadable` (stays unknown, retries). Also:
   quoted `server:` lines in teploy.yml are unquoted before exec.
3. *Default-branch fetch failure skipped revalidation* (executeDelivery,
   stale-approval block). A resolved-but-unfetchable default branch silently
   deployed on a check that never ran; now held with the git error.
   Unresolvable origin/HEAD keeps the documented back-compat skip.
4. *Recovery version never verified* — the operator types it; rollback goes
   exactly there and its read-back only compares against the same value, so
   a typo would "roll back" to the wrong release and verify done. Execution
   now reads the destination first: a readable target on another version
   holds ("re-approve with the version actually serving"); an empty/unreadable
   target proceeds and the receipt says the recovery version is unverified.
5. *Rollback could undo a newer delivery* (executeDeliveryRollback). Record A
   confirmed, then B delivered; rolling A back ran `rollback --to A.recovery`,
   silently undoing B while B stayed `confirmed`. Now the target must be
   serving THIS delivery's version; already-on-recovery → done without a
   command (lost-receipt case); unreadable target → refused.
6. *Rollback requester not rechecked at action time.* Approvals got the S15
   actor recheck; rollback requests did not. Now the same
   `recheckApprovingActor` runs against the live stores before the target is
   read (worker wires governance/users in).
7. *No product path to re-approve held/failed deliveries.* Every held reason
   says "re-approve", but the promote route only moved `proposed`; wave-9
   re-approvals were store surgery. `approveDelivery` moves
   proposed|held|failed → approved fenced on the current state, re-records
   destination + recovery version, policy `operator-reapproval`; the run page
   offers the form in those states.
8. *Marker compare was case-exact* — now under the S01-3 rule.
9. Stale-executing reconciliation reason said "target does not run the
   approved delivery" even when the target was merely unreadable; wording now
   follows the read-back outcome.

**Delta audit — RECORDED, not fixed (owner: ship, S14/S15 continuation):**

- **(Medium) `destination` is recorded but never enforced**
  (src/delivery.ts:46; promote.tsx:49). The executor deploys wherever the
  trusted copy's teploy.yml points; the approval's destination string is
  never compared with `teploy status --json`'s `app`/`server`. An approval
  for "staging" executes against whatever the copy targets. Fix needs a
  destination grammar (live proofs used ":7480") before it can be enforced.
- **(Medium) `configIdentity` is never populated** (src/delivery.ts:52). The
  contract tuple names trusted config identity; nothing records a digest of
  the trusted copy's teploy.yml at execution, so a config edit between two
  deliveries is invisible in the receipts.
- **(Low) A stuck rollback `executing` has no reconciliation**
  (src/worker.ts:1924 claims; no stale sweep). A worker death mid-rollback
  leaves `rollback.state = executing` forever; the route refuses a new
  request. Needs the same stale-window read-back the delivery has.
- **(Low) `unknown` has no escalation** (src/worker.ts:1943). An
  unreadable target retries every minute indefinitely with no age signal on
  the run page.
- **(Low) Sweep visibility is bounded by recency** (src/delivery.ts:319 and
  :1110 `due` = newest-500 list then filter; worker.ts:1924 the same). An old
  approved/requested record behind 500 newer ones is never picked up.
- **(Info) Version identity is a 7-char SHA prefix** (src/delivery.ts:800,
  mirrors the CLI's `--version` short hash). Collision is theoretical; the
  artifact half of the pair still has to match.
- **(Info) A trusted copy with no marker executes** (src/delivery.ts:534) —
  documented back-compat; provisioning the marker is an operator step.

**Dependency re-triage (2026-09-23, vs current manifests):** `pnpm audit`
root and web: no known vulnerabilities. The frozen production lockfiles
(deploy/package-lock.ship.json, deploy/package-lock.web.json) under
`npm audit --package-lock-only`: 0 vulnerabilities. GitHub Dependabot on
useteploy/teploy-ship: 18 alerts total, all `fixed` (latest batch
2026-09-21: hono, devalue, js-yaml, browserslist, baseline-browser-mapping);
0 open. Resolved versions confirmed in both lock sets (hono 4.13.5, devalue
5.9.2, js-yaml 3.15.2, browserslist 4.28.7, postcss 8.5.26/8.5.28, nanoid
6.0.1). No bump needed; nothing to record as open.

## 2026-09-24 — request-path evaluation canary: empty executable fence

`eval-20260924-12` failed on its first action: a malformed inline shell
fence plus a trailing fence parsed as `bash` with empty code. The sandbox
correctly refused a blank `cmd`, but Ship treated this as a fatal execution
error. `src/actions.ts` now returns `invalid` for empty shell/Python actions,
so the existing correction loop asks for a properly formatted command.
Regression tests cover the recorded shape and correction through the agent
loop. Deployed as `a057d03` on 2026-09-24; the read-only question
canary and subsequent copy/API change canaries completed live. Original
results and any supplementary regrades remain preserved.

The earlier BROWSER-display live-proof TODO above is superseded by the
2026-09-24 live-ops receipt: image storage, authenticated retrieval and the
rendered image reference were confirmed on `b06a1f0`. The combined two-park
resume proof remains pending.


## 2026-09-24 — browser keyboard focus across per-action restarts

The maintained live browser proof exposed lost focus: click → type → Enter
never submitted the form, although captures/navigation worked. The driver's
intentional per-action reload preserves site storage but lost the active
control. Fixed and deployed as 2b13447 by restoring a bounded selector/selection and scroll
on the same URL without replaying clicks; navigation clears the saved focus.
The DOM still reloads each action, as the panel states. The driver now refreshes
on every operation so existing sessions receive fixes. Real Chromium proof
passed all actions after the fix; before/after logs are under evals/receipts.
The live proof script also now uses sandboxProvider and
artifact-backed screenshots rather than its stale SDK/inline-image wiring.


## 2026-09-24 — preview containers have unrestricted egress (trust model; L8 open item 4, recorded by L13)

A tailnet preview runs unreviewed, model-authored code as a deployed app on
the preview target (compute-1). The sandbox allowlist does not apply to it:
`teploy preview deploy` starts the container through the CLI's ordinary
`docker.Run`, on the target's shared `teploy` bridge. So a preview can:

- reach anything the target host routes to: the internet, the LAN, and the
  **tailnet** (every 100.64.0.0/10 peer that does not filter by source,
  including the forge and any tailnet-only service), plus link-local
  metadata addresses where a cloud host has them;
- reach every other container on the `teploy` network directly, by name,
  bypassing the Caddy route's tailnet allowlist (today on compute-1: the fixture
  main app and the Caddy container).

What already limits it: the target is compute-1, not infra-home (no Ship
store or credentials on its docker network — see the L8 receipt); a preview
publishes on 127.0.0.1 only, so the allowlist cannot be bypassed from outside
through its host port; the TTL prune and (now) the superseded-preview cleanup
bound how long any one runs.

**Mitigation proposal (not implemented — it is not small, and it needs a live
proof on the target):**

1. teploy-cli: previews join a dedicated `teploy-preview` bridge instead of
   `teploy`, and the target's Caddy container is attached to both. Pinned by a
   preview-deploy argv test (`--network teploy-preview`, never `teploy`).
   Closes the lateral path to other apps; Caddy still dials the preview by
   network alias, and the 127.0.0.1 publish the readiness probe uses keeps
   working (unlike an `--internal` network, which publishes nothing).
2. `teploy setup` (or the first preview deploy) installs `DOCKER-USER` rules
   for that bridge's subnet: DROP to 100.64.0.0/10, 10.0.0.0/8,
   172.16.0.0/12, 192.168.0.0/16 and 169.254.0.0/16, ACCEPT established
   return traffic, leave public egress open (a preview is a deployed app; many
   need an external API). Idempotent and keyed by a rule comment so it can be
   listed and removed. Pinned by a rules-rendering test.
3. An opt-in `preview.egress: open|public|none` in teploy.yml for the app
   that needs the tailnet (e.g. a preview talking to a tailnet-only
   staging database), defaulting to `public`.
4. Live proof on compute-1: from a preview container, a tailnet peer, a LAN
   address and the metadata address are refused; a public HTTPS fetch works;
   Caddy still serves the preview to a tailnet client and 403s the LAN.

Until then the trust statement is: a preview has the preview TARGET's network
reach, and the target must be chosen as if it ran untrusted code with that
reach — which is why it is compute-1 and not the Ship host.

### 2026-09-26 — terminal failure evidence

Fixed on this branch: workflow terminal errors with `{error:{message:...}}`
rendered an empty explanation in the workspace and its API. The timeline now
reads the recorded detail/message/title or legacy string, and explicitly names
missing details. Step failures use the same handling. This repairs presentation;
it does not claim to fix the timeout that produced the event.

Validation: lint; 1,411 runtime tests; 100 script tests with one existing skip;
136 web tests; production web build. Initial web run through a shared dependency
symlink loaded duplicate project-error classes and failed two unrelated identity
checks; installing this worktree's web dependencies resolved both. Original
failure log retained in the private execution receipts.

## 2026-09-27 — rehearsal transport and completed coordination wording

An exact production backup booted under Nucleus v1.1.1, but the rehearsal
client lost its connection because the image default enabled TLS. Start the
proof engine with explicit `/data`, host, non-TLS transport and memory budget,
matching its loopback-only client. A restored 352-run store then exposed all
five waiting decisions and passed the candidate fingerprint preflight. Keep
independent history-count/digest verification in the release receipt; an empty
preflight alone is not evidence that a populated backup restored correctly.

The real standalone API/client coordination completed through both normal merge
approvals and its compatibility scan. Its client description still said the
check was owed despite the complete badge. It now points to the actual check
result below without asserting an obsolete pending state.

The final-image replay additionally reproduced a startup race: Docker's port
proxy accepted the TCP probe while Nucleus was still restoring its catalog.
The first preflight query then lost its connection. TCP readiness is replaced
with a successful `nucleus shell --command "SELECT 1"` inside the proof container.
This corrects the earlier attribution: explicit data/transport is required, but
transport alone did not explain every connection failure. Original failed and
successful rehearsals remain in the release receipts.


## 2026-10-07 — framework 0.3.2 integration prepared, publication pending

The `stage/core-0.3.2` branch pins development and deployment web manifests
to core/CLI 0.3.2. The console response boundary now preserves representation
`Vary` dimensions and sends `Cache-Control: private, no-store` for successful,
redirect and authorization responses. This prevents new cache reuse; existing
proxy/browser cache entries still require invalidation.

Registry publication is not yet complete. Existing tracked locks remain registry
locks; run `node scripts/refresh-framework-locks.mjs` after the core/CLI/create
release becomes available, then install/test/build before integrating this branch.
No production rollout or browser acceptance is claimed. See
[FRAMEWORK_UPGRADE.md](docs/FRAMEWORK_UPGRADE.md) for validation and rollback.

## 2026-10-16 — D2 two-way steering (`SHIP_STEER_REPLY`, default off)

Built behind the flag (default off, pending review and a soak): agent
```reply into the thread, steer/queue modes, operator interrupt at safe
points, thread-view rendering. Design and replay semantics in
[STEERING_DESIGN.md](docs/STEERING_DESIGN.md).

### 2026-10-16 — PR review fixes

Security review of the branch, fixed here:

- **Held-store keys now carry the attempt.** `claimHeld`'s `q:`/`i:` keys and
  the drain's turn key were keyed by turn number alone, so on a multi-attempt
  run attempt 1's turn N answered attempt 0's claim of the same number and
  re-delivered its queued messages, interrupts and drained notes (and a
  re-claimed `i:N:before` skipped attempt 1's action outright). Every key now
  carries `stepPrefix`; single-attempt runs have an empty prefix, so their
  store bytes are unchanged.
- **The plain drain has the same flaw on flag-off runs, and it is
  deliberately NOT fixed there.** `drain(runId, turn)` is keyed by turn
  number, so attempt 1's turn-N drain answers attempt 0's recorded claim and
  re-delivers its notes on ANY multi-attempt run, steerReply or not. The fix
  applies the attempt-scoped key only when `input.steerReply` is set:
  changing the key for flag-off runs would change live store bytes under
  in-flight runs whose logs say nothing about it, which is the class of
  change the upgrade fence exists to prevent. Until a flag-day can carry it,
  flag-off multi-attempt runs re-deliver drained notes to later attempts
  (advisory duplication — the notes were real operator instructions; nothing
  is lost or forged). Revisit when a materialised input field can admit the
  new keying (the shape `drain(runId, turn: number | string)` already
  accepts).
- **`NucleusSteerStore.claimHeld` is idempotent per key.** The old
  stamp-then-read swept rows that arrived after a claim into a rerun with
  the same key (a superset), consuming them without delivering them. It now
  answers a key that already claimed from those rows alone, the file store's
  contract.
- **The operator-impersonation fence is hardened** (fenceOperatorLines):
  NFKC, zero-width/format-character stripping, Cyrillic/Greek homoglyph
  folding and the typographic apostrophe are folded in a detection copy; the
  framing match runs anywhere in a line (markdown prefixes, quoting, mid-line
  no longer shield it) and covers every framing the loop itself emits —
  drain, queued, interrupt, ask answers ("Operator's answer", "did not
  answer"), plan approvals ("The operator approved …", edited and plain) and
  denials ("Action denied by the operator").
- **The task text and condense recaps are fenced the same way** on steerReply
  runs (markers "[task text, not the operator]" / "[recap, not the
  operator]"; the recap fence is applied inside the recorded step so replay
  returns the recorded bytes rather than fencing twice).
- **The conversation view renders only the first reply block per turn**,
  through the loop's own `parseReply` (shared with `replyHistory` via a
  common dialect builder) — a second ```reply fence was never delivered and
  must not read as a second message.

Considered and rejected for now: a per-run nonce on genuine operator turns
(materialised at enqueue, so the prompt could say only nonce-bearing
operator text is authentic). The framings the nonce would have to mark span
paths the flag does not gate — ```ask answers, plan approvals and denials
are written by the live loop and the external-harness runs too, and a nonce
that appears on only some of them teaches the model less than the current
"only user turns the system writes" rule. It fits cleanly only if every
operator-adjacent surface adopts it at once; revisit with the live soak.

Open, deliberately not in the slice:

- **A running bash command cannot be interrupted.** The executor contract
  (`@neutron-build/agents` `ExecOptions`) has no abort, and what the sandbox
  daemon does when an exec stream is dropped is unverified. So an interrupt
  that lands during bash lets the command finish and records effect `done`.
  The fix belongs upstream (an exec abort plus a daemon-side kill of the
  process group), followed by a Ship change that passes the signal through
  `runAction`'s bash branch. Only python kernel cells are cancelled mid-flight
  today.
- The kernel cancel issues a second exec while the first (the blocked waiter)
  is still running. Proven on `LocalExecutor`, not yet against the live
  sandbox daemon.
- No live soak yet. The flag earns its own one-run flip (web + worker, both
  enqueue) on the 2026-10-16 pattern.
