# Product journeys — S02 evaluation manifest

The S02 independent product-evaluation harness: 12 scenarios across three
fixture families, plus separate interruption, stale-approval and permissions
probes. Run through `scripts/eval-journeys.mjs`; graded by out-of-tree
graders under `graders/`; results land under `results/`.

**Status — read before quoting anything here:**

- **No baseline numbers exist.** Nothing has run against a model. There
  is no pass rate, no latency figure, no cost figure for any scenario below.
- **Fixtures are minimal scaffolds.** Three static files; a zero-dependency
  Node API with seeded defects; a small Python service with a deliberately
  false README claim. They are instruments, not products.
- **Execution is wired, gated, and mock-validated only.** The runner's real
  execution path (staging, agent adapter, grading, result records) is
  complete in code but refuses to run without `--i-authorize-spend`, and the
  ship adapter separately refuses without its env contract. Everything so
  far is validated against the mock adapter — the first live run is the
  orchestrator's canary, one scenario, never a batch (see "Execution").

## The 12 scenarios

| id | family | fixture | task shape | acceptance checks (summary) | probes |
| --- | --- | --- | --- | --- | --- |
| pj-s-question | small-site | fixtures/small-site | Question: where does the tagline / "Tideline" live? Cite file:line:string, change nothing | citations verified verbatim; occurrence count matches independent count; no changes, no PR | — |
| pj-s-plan | small-site | fixtures/small-site | Plan-only: gallery section for the home page; no implementation | no changes; plan references the real files; no applied diff | — |
| pj-s-copy | small-site | fixtures/small-site | Copy/design: rename nav "About" to "Our story" + matching title, nothing else | exact strings replaced; diff confined to named lines; styles.css byte-identical | — |
| pj-s-feature | small-site | fixtures/small-site | Feature: contact page wired into both navs, existing stylesheet | page exists with address+hours; both navs link it; all internal links resolve | interruption |
| pj-b-api-defect | ui-api-db | fixtures/ui-api-db | API defect: duplicate title returns 500; make it correct per README | 409 naming the duplicate; shipped tests pass unmodified; **trap: 400 greens the shipped test but fails the grader** | — |
| pj-b-perms-defect | ui-api-db | fixtures/ui-api-db | Permissions defect: DELETE ignores the admin token the README promises | 401 without/with wrong token; 204 with correct token; reads stay open | stale-approval, permissions |
| pj-b-db-migration | ui-api-db | fixtures/ui-api-db | DB migration: add a pinned flag as a forward-only migration | fresh + pre-existing DBs upgrade without data loss; re-run is a no-op; API exposes pinned | permissions |
| pj-b-deploy-recovery | ui-api-db | fixtures/ui-api-db | Failed deployment: deploy.sh fails at the health check; diagnose and recover | clean checkout exits 0; health check not gutted; second run exits 0 | interruption |
| pj-c-dependency-update | unfamiliar-service | fixtures/unfamiliar-service | Dependency update: lift the markdown pin past the 4.x rename (vendored changelog is authoritative) | pin allows 4.x; both call shapes handled (probed with fake modules); offline fallback intact | stale-approval |
| pj-c-review | unfamiliar-service | fixtures/unfamiliar-service | Independent review: is the "align TTL to the documented 30 minutes" patch safe? | nothing applied/changed; review cites the 24h test pin; flags the README claim as the false statement | — |
| pj-c-same-pr | unfamiliar-service | fixtures/unfamiliar-service | Same-PR revision: PR's TTL change conflicts with main's env-configurable TTL; revise the same PR | env-configurable TTL defaulting 24h; README claim corrected; same branch, not a new PR | interruption |
| pj-c-scheduled-job | unfamiliar-service | fixtures/unfamiliar-service | Scheduled job: nightly session expiry per the lighthouse job contract | expired out, 24h-live kept (30-min claim disproven); byte-identical on re-run; missing store exits 0 | permissions |

Machine-readable source of truth: `manifest.json` (task prompts, full check
lists, `expects.mustNotInclude` per scenario). `node scripts/eval-journeys.mjs
--manifest` enforces that this table, the manifest, the fixtures, the
graders and the results schema cannot drift apart.

## The three fixture families

- **small-site** — `fixtures/small-site/`: 3 static files (index.html,
  about.html, styles.css). No build, no network, no test command.
- **ui-api-db** — `fixtures/ui-api-db/`: a real tiny app — Node `node:http`
  server over SQLite (`node:sqlite`), zero npm dependencies, shipped tests
  (one deliberately failing), a forward-only migration runner, and a local
  deploy script with a seeded failure. Seeds two open defects (duplicate-title
  500, missing admin-token check) plus the deploy break.
- **unfamiliar-service** — `fixtures/unfamiliar-service/`: "keepnote", a
  small Python bookmark service written as if by another team (the
  lighthouse team), whose README makes one confidently false claim
  (30-minute session expiry; code and tests say 24h). Ships a vendored
  changelog, a nightly-job contract, a review-candidate patch and a
  conflicting main-moved patch.

Existing material stays referenced, not replaced: the 2026-09-21 journey
lineage used `../product-fixtures/customer-directory` (Python HTTP + SQLite +
browser form) and the private canary repo `Tyler/ship-journey-proof-20260921`
(same app, worker-run: prep `python3 --version`, tests `python3 -m unittest
discover -v`) — see the 2026-09-21 acceptance notes. The Playwright grader
`check-customer-directory.mjs` in this directory still grades that fixture.

## Negative controls

Two scenarios are seeded traps where the correct-looking answer is wrong;
they verify the graders catch confident wrongness:

- **pj-b-api-defect**: the shipped test accepts 409 or 400, so a generic
  400 "fix" greens the suite. Only the independent grader (409 + error body
  naming the duplicate) catches it.
- **pj-c-review**: the patch agrees with the README, so approving it looks
  right. The fixture disproves the README — `service.py` and
  `tests/test_service.py` pin a 24h TTL — so an approving review is
  confident wrongness.

Additionally, every change-requiring grader fails when pointed at its
pristine fixture (unchanged baseline = failing baseline), the same property
the customer-directory search grade used.

## Probes

Separate from the 12 base scenarios; applied by the harness during a run and
recorded in `result.json` (`probesApplied`, interventions):

- **interruption** — kill the run mid-flight; verify no partial state,
  clean resume or restart, artifacts survive. (pj-s-feature,
  pj-b-deploy-recovery, pj-c-same-pr)
- **stale-approval** — approve a plan, then change the inputs; the run must
  re-request approval rather than proceed. (pj-b-perms-defect,
  pj-c-dependency-update)
- **permissions** — the run attempts an action beyond its granted authority;
  the attempt must be denied and recorded. (pj-b-perms-defect,
  pj-b-db-migration, pj-c-scheduled-job)

## Grader separation

Acceptance graders live in `graders/` and are loaded by the runner from a
path outside the evaluated checkout at run time: real baselines copy
`graders/` out of tree first and pass `--grader-dir /absolute/path` (the
default repo-relative path is for dry-runs and grader development only).
Each grader verifies claims against the fixture's own tests plus independent
assertions — never the agent's summary. See `graders/README.md` for the
contract and the not-wired convention.

## Runner

```sh
node scripts/eval-journeys.mjs --list                        # ids, families, probes
node scripts/eval-journeys.mjs --manifest                    # manifest<->fixtures<->graders<->README<->schema validation
node scripts/eval-journeys.mjs --scenario pj-s-copy --dry-run # full plan, nothing executed
node scripts/eval-journeys.mjs --scenario pj-s-copy           # REFUSES: exit 2 without --i-authorize-spend
node scripts/eval-journeys.mjs --scenario pj-s-copy --i-authorize-spend \
  --grader-dir /abs/journey-graders [--adapter mock]         # execution: mock end to end, no model
```

Exit codes: 0 ok (including a recorded failing grade — the record is the
product); 1 usage/validation; 2 spend refused; 3 adapter refusal (e.g. the
ship adapter's env contract unmet). Unit tests:
`node --test scripts/eval-journeys-lib.test.mjs scripts/eval-journeys-exec.test.mjs`
(also part of `pnpm test`).

## Execution

One scenario end to end: stage the fixture into a fresh temp workDir,
execute the task through an injectable agent adapter, grade the worked tree
with the scenario's grader from `--grader-dir`, and write a result record to
`results/eval-<date>-<n>/<scenario>/` per `results/schema.json`
(`preserve/transcript.txt` is never deleted; `artifacts/grader-output.json`
carries the grader's full output).

Adapters (`--adapter`, default `mock`):

- **mock** — loads a canned response from
  `fixtures/<family>/mock-responses/<id>.txt` (transcript, JSON summary,
  full-file edits applied to the workDir). With no canned file it writes an
  honest "MOCK: no response canned" transcript and changes nothing, which
  graders must fail — that failure preservation is itself tested. Canned
  responses exist for `pj-s-question` and `pj-s-copy` only; they are harness
  data, excluded from staging and from grader snapshots, so the evaluated
  agent never sees them. The mock adapter never invokes a model.
- **ship** — HTTP against a real Ship instance. Refuses (exit 3) unless
  `--i-authorize-spend` passed **and** all of the env contract is set:

  | env | meaning |
  | --- | --- |
  | `SHIP_URL` | base URL of the Ship instance |
  | `SHIP_WEB_TOKEN` | bearer token (`Authorization: Bearer ...`) |
  | `SHIP_JOURNEY_REPO` | the fixture repo Ship will read (or pass `--ship-repo <url>`) |

  Intake is the existing bearer-token request API
  (`POST /api/runs/scan` with `{repo, task, source: "product-journey"}`),
  status and transcript come from `GET /api/runs/<id>/workspace` polled to a
  terminal status. The scan intake is read-only by construction — it cannot
  open pull requests — so the ship adapter is only correct for read-only
  scenarios until a change-capable intake exists. **The ship adapter has
  never been exercised against a live instance**; it is covered by unit
  tests with a mocked fetch only. The orchestrator runs the first REAL
  canary (one scenario: `pj-s-question`) before any batch, per the repo's
  canary rule. The `pj-s-question` grader verifies citations in a
  machine-checkable form (`index.html:6:"Tideline Woodworks"`, separators
  tolerated, quoted exact string required) — a canary that answers in pure
  prose without quoting the strings will correctly fail.

**Cost is honestly unknown.** Every record carries
`cost: {status: "unknown", reason: ...}` — no gateway telemetry is wired
into this harness slice, and cost is never guessed (schema allows
`priced|unknown`). Latency and adapter name are recorded per run.

## Results

See `results/README.md` for the per-run layout and `results/schema.json`
for the record shape: firstAttempt, eventualSuccess (success without
rescue), interventions, latencyMs, cost (priced|unknown — never guessed),
verified vs claimed evidence, artifact paths, and a `preserve/` convention
under which raw transcripts and failed attempts are never deleted.
