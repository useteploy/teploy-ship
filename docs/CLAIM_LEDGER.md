# Claim ledger

<!-- GENERATED from docs/claims/ledger.json by scripts/claim-ledger.mjs --render. Do not edit by hand; `--check` fails if this file is out of date. -->

Each claim states what it covers, what kind of evidence stands behind it, and what it does not show. Evidence classes: implementation (the code or document exists), automated (a test or probe in this repository), system (observed in a real system), human (a recorded observation), comparative (matched measurement against an alternative). A claim is `supported` only with automated or system evidence; it is marked verified only with system evidence at an exact revision. Automated evidence carries the commit at which its tests were last run green; any later change to its cited path makes it a candidate for re-running (`node scripts/claim-ledger.mjs --check --stale`). No claim in the first seeding had system-class evidence at a known revision. The 2026-10-16 re-check (X7) re-ran every cited test at 477529a and added claims for later work at the level reached; three carry production evidence at an exact revision and are marked verified. The check runs in CI. Publication, tag and visibility decisions are not made by this file.

| id | status | verified | claim |
| --- | --- | --- | --- |
| [model.default-id](#modeldefault-id) | supported | no | The default model id is zai/glm-5.3, with precedence --model, then SHIP_MODEL, then config file, then default. |
| [model.default-quality](#modeldefault-quality) | provisional | no | glm-5.3 resolved 35 of 50 seeded SWE-bench Lite instances. |
| [harness.native-steering](#harnessnative-steering) | supported | no | Steering notes are offered and accepted only for runs whose harness can consume them, which is the native harness only. |
| [harness.external-refuse-plan-review](#harnessexternal-refuse-plan-review) | supported | no | External harnesses refuse plan review: a run that requires plan review fails with an explicit error and starts no external agent. |
| [delivery.stale-executing](#deliverystale-executing) | supported | no | A delivery stuck in executing past the stale window is recognised as stale only by state and age, and stale rollback reconciliation reads the target before deciding. |
| [git.credential-scrub-same-shell](#gitcredential-scrub-same-shell) | supported | no | Authenticated clone and warm fetch scrub the remote in the same shell invocation as the credential, whatever the credentialed step returns. |
| [git.env-credential-mode](#gitenv-credential-mode) | provisional | no | SHIP_GIT_CREDENTIAL=env keeps the Git token out of every command line and out of .git/config. |
| [eval.retained-recount](#evalretained-recount) | supported | no | The retained product-journey records count 15 pass, 5 fail, 6 unknown and 2 harness-error over 28 attempts in 20 runs. |
| [eval.headline-21-13-2](#evalheadline-21-13-2) | disclaimed | no | The earlier headline of 21 passes, 13 failures and 2 human-gated harness errors over 36 attempts is not claimed. |
| [preview.egress-unrestricted](#previewegress-unrestricted) | open | no | A tailnet preview container can reach the internet, the LAN, the tailnet and other containers on the shared bridge; it is not restricted by the sandbox allowlist. |
| [authority.command-regex-advisory](#authoritycommand-regex-advisory) | open | no | Command-regex approval classification is advisory, not an enforcement boundary. |
| [comparative.superiority](#comparativesuperiority) | disclaimed | no | No claim is made that Ship is better than, faster than or more capable than any other product. |
| [perception.look-live](#perceptionlook-live) | supported | yes | With SHIP_LOOK=1 and SHIP_LOOK_IMAGE_MODEL=zai/glm-5.3-flash, a production run recorded text accessibility look steps and one image look under the cap, and the facts it reported matched the live page. |
| [resource.browser-class](#resourcebrowser-class) | provisional | no | A run whose recorded input carries look is admitted as a browser resource class: its memory limit is raised by the measured browser delta and admission accounts for it, while plain runs are unchanged. |
| [delegate.coordinator](#delegatecoordinator) | provisional | no | With SHIP_DELEGATE set at enqueue, a native run can delegate one level of child runs (cap 2 per task root) that inherit its gates, and each child's terminal result returns to the parent as an observation. |
| [thread.view](#threadview) | provisional | no | With SHIP_THREAD_VIEW=on, the run page and API show a follow-up chain as one read-only thread with each run's steering notes and ask parks; with it off, the payload is unchanged. |
| [auth.admin-bootstrap](#authadmin-bootstrap) | supported | yes | On a store with no local accounts, the web process creates the first admin from SHIP_BOOTSTRAP_ADMIN_USER and SHIP_BOOTSTRAP_ADMIN_PASSWORD exactly once, never overwrites an existing principal, and never logs the password. |
| [store.postgres](#storepostgres) | supported | yes | Ship runs its shared-store runtime on PostgreSQL: KV claims, run event streams and documents work on plain tables, with Nucleus left as the default dialect. |

Counts: supported 9, provisional 5, disclaimed 2, open 2. Claims marked verified: 3.

## model.default-id

**Status:** supported  **Owner:** teploy-ship

The default model id is zai/glm-5.3, with precedence --model, then SHIP_MODEL, then config file, then default.

**Scope / configuration:** Model id resolution only (src/model-id.ts). Says nothing about how well that model performs.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/model-id.ts` |  | not recorded |
| automated | `src/model-id.test.ts` | flag wins over env and config | 477529a602c0 |
| automated | `src/model-id.test.ts` | an empty SHIP_MODEL falls through to config, then the default | 477529a602c0 |

**Limitations:**
- Resolution of the id string only; whether the configured gateway serves it is not checked.

Re-checked 2026-10-16 (X7) against origin/main 477529a: DEFAULT_MODEL_ID is still zai/glm-5.3 (src/model-id.ts); both cited tests re-run green.

## model.default-quality

**Status:** provisional  **Owner:** teploy-ship

glm-5.3 resolved 35 of 50 seeded SWE-bench Lite instances.

**Scope / configuration:** Seeded 50-of-300 Lite subset, official evaluator, bare configuration (not the product path), recorded 2026-08-16. Not a Ship product result and not a held-out result.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `docs/MODELS.md` |  | not recorded |
| system | `evals/2026-08-16-swebench-lite-50-glm53.md` |  | unknown (not counted) |

**Limitations:**
- The writeup does not pin a Ship commit; the system evidence is therefore not counted.
- Other models have little or no evidence: claude-haiku-4-5 was 1/9 on a hand-picked set with prompts tuned against GLM; claude-sonnet-5 3/3 and 6/6 on small saturated in-house suites; none for OpenAI-shaped, Gemini, DeepSeek, Opus or local models.
- Not the product path, so it does not support any claim about Ship tasks.

Re-checked 2026-10-16 (X7) against origin/main 477529a: the writeup still pins no Ship commit, so the system evidence stays uncounted and the claim stays provisional. Not upgraded.

## harness.native-steering

**Status:** supported  **Owner:** teploy-ship

Steering notes are offered and accepted only for runs whose harness can consume them, which is the native harness only.

**Scope / configuration:** The capability table in src/harness-capabilities.ts, as consulted by the run page and the steering route.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/harness-capabilities.ts` |  | not recorded |
| automated | `src/harness-capabilities.test.ts` | S13: only the native harness takes steering notes | 477529a602c0 |
| automated | `src/harness-capabilities.test.ts` | S13: a multi-harness run supports a capability only if every attempt does | 477529a602c0 |
| automated | `web/src/lib/steer-refusal.test.ts` | steering a run on an external harness is refused and nothing is stored | 477529a602c0 |
| automated | `web/src/lib/steer-refusal.test.ts` | steering a native run is accepted and queued (negative control for the refusal) | 477529a602c0 |
| automated | `web/src/lib/steer-refusal.test.ts` | the run page does not offer a steer box for an external-harness run | 477529a602c0 |

**Limitations:**
- No live steering of a real native run is recorded.
- External harnesses (claude-code, opencode) cannot be steered; that is a gap, not a feature.

Re-checked 2026-10-16 (X7) against origin/main 477529a: the route refusal now has automated tests (web/src/lib/steer-refusal.test.ts, with a native negative control), which removes the limitation that kept this provisional. Upgraded to supported on automated evidence; still not verified live.

## harness.external-refuse-plan-review

**Status:** supported  **Owner:** teploy-ship

External harnesses refuse plan review: a run that requires plan review fails with an explicit error and starts no external agent.

**Scope / configuration:** claude-code and opencode adapters, at admission (runtime) and on direct workflow execution.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/runtime.ts` |  | not recorded |
| implementation | `src/harness-external.ts` |  | not recorded |
| automated | `src/harness-external.test.ts` | direct external execution cannot bypass requested plan review | 477529a602c0 |
| automated | `web/src/lib/workspace-actions.test.ts` | an external harness cannot silently bypass requested plan approval | 477529a602c0 |

**Limitations:**
- The workflow test drives a fake claude binary; the admission check is pinned through enqueueRun in the web suite (nothing recorded on refusal), not through the CLI.
- No real external harness run was observed.

Re-checked 2026-10-16 (X7) against origin/main 477529a: flagged stale (src/harness-external.test.ts changed after dd682c7); the cited test re-run green, and the admission-time refusal now has a cited test.

## delivery.stale-executing

**Status:** supported  **Owner:** teploy-ship

A delivery stuck in executing past the stale window is recognised as stale only by state and age, and stale rollback reconciliation reads the target before deciding.

**Scope / configuration:** src/delivery.ts state machine with in-memory and fake targets. Delivery execution is off without SHIP_DELIVERY_DIR.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/delivery.ts` |  | not recorded |
| automated | `src/delivery.test.ts` | isStaleExecuting keys on state and age, above the execution ceiling | 477529a602c0 |
| automated | `src/delivery.test.ts` | gap: stale rollback reconciliation reads the target | 477529a602c0 |

**Limitations:**
- No live forge or deployment target was exercised.
- The stale window is a fixed 35 minutes by default.

Re-checked 2026-10-16 (X7) against origin/main 477529a: the 35-minute default is still the staleMs default of isStaleExecuting / isStaleRollbackExecuting (src/delivery.ts); cited tests re-run green.

## git.credential-scrub-same-shell

**Status:** supported  **Owner:** teploy-ship

Authenticated clone and warm fetch scrub the remote in the same shell invocation as the credential, whatever the credentialed step returns.

**Scope / configuration:** src/git.ts clone and warm-volume fetch through an executor.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/git.ts` |  | not recorded |
| automated | `src/git.test.ts` | S01: authenticated clone and fetch scrub the remote in the same shell invocation as the credential | 477529a602c0 |

**Limitations:**
- The sequencing test fails on the previous code; the failed-fetch probe on a real checkout is a regression pin only (the old path also scrubbed).
- Not proven through the Sandbox daemon or a live private repository.

Re-checked 2026-10-16 (X7) against origin/main 477529a: flagged stale (src/git.test.ts changed after dd682c7); the cited test re-run green.

## git.env-credential-mode

**Status:** provisional  **Owner:** teploy-ship

SHIP_GIT_CREDENTIAL=env keeps the Git token out of every command line and out of .git/config.

**Scope / configuration:** LocalExecutor with a real git and a local HTTP server. Implemented, OFF by default (argv mode remains the default).

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/git.ts` |  | not recorded |
| automated | `src/git.test.ts` | S01: env credential mode keeps the token out of argv and the URL, argv mode does not | 477529a602c0 |
| automated | `src/git.test.ts` | S01: a real git clone in env mode sends the credential as a header and never puts it in argv or config | 477529a602c0 |

**Limitations:**
- Unproven live: the Sandbox daemon must forward per-exec env, and the sandbox git must be 2.31 or later.
- No private-repo clone or push on Forgejo or GitHub through the real sandbox has been run.
- Default unchanged; see AUDIT_OPEN.md before flipping it.

Re-checked 2026-10-16 (X7) against origin/main 477529a: flagged stale; both cited tests re-run green. AUDIT_OPEN's S01 open list (daemon env forwarding, sandbox git version, live private-repo clone and push) is unchanged, so it stays provisional.

## eval.retained-recount

**Status:** supported  **Owner:** teploy-ship

The retained product-journey records count 15 pass, 5 fail, 6 unknown and 2 harness-error over 28 attempts in 20 runs.

**Scope / configuration:** evals/product-journeys/results at the recount of 2026-10-03, using the recorded outcome where present and outcomeOf otherwise. A development and regression set, not held-out, and not a model-quality number.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `evals/product-journeys/BASELINE_RECOUNT_2026-10-03.md` |  | not recorded |
| automated | `scripts/eval-report.test.mjs` | each outcome class is counted exactly once and unknown is neither pass nor fail | 477529a602c0 |
| automated | `scripts/eval-report.test.mjs` | negative control: an unknown record is in no pass or fail count and no denominator | 477529a602c0 |

**Limitations:**
- The counting rules are tested on synthetic trees; the figures themselves are the generated report, not a separate test.
- Costs: 12 records priced, 16 unknown; the priced sum is a lower bound.
- Supplements (one regrade, one reclassification) are listed but not applied.
- The 2026-10-04 S02 batch and its supplementary regrades added records under evals/product-journeys/results, so the current tree no longer reproduces these figures; they describe the 2026-10-03 recount only. The batch's own result is in evals/product-journeys/BATCH_2026-10-04.md and is not claimed here.

Re-checked 2026-10-16 (X7) against origin/main 477529a: counting-rule tests re-run green; scope limitation added for records added after the recount.

## eval.headline-21-13-2

**Status:** disclaimed  **Owner:** teploy-ship

The earlier headline of 21 passes, 13 failures and 2 human-gated harness errors over 36 attempts is not claimed.

**Scope / configuration:** It cannot be reproduced from the retained records; 8 of the 36 attempts are not in this repository. The private receipts it may come from were not available.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `evals/product-journeys/BASELINE_RECOUNT_2026-10-03.md` |  | not recorded |

**Limitations:**
- Do not quote 21/13/2. Use eval.retained-recount, with its scope.
- Not shown to be wrong either: the missing records were not checked.

Re-checked 2026-10-16 (X7) against origin/main 477529a: still disclaimed; nothing new recovers the missing attempts.

## preview.egress-unrestricted

**Status:** open  **Owner:** teploy-cli

A tailnet preview container can reach the internet, the LAN, the tailnet and other containers on the shared bridge; it is not restricted by the sandbox allowlist.

**Scope / configuration:** Previews started by teploy preview deploy on the preview target. The defect is in the CLI, so the owning layer is teploy-cli.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `AUDIT_OPEN.md` |  | not recorded |

**Limitations:**
- No Ship-side change made; any isolation claim for previews is withheld until the CLI change and a live proof on the preview target exist.
- A successful preview is not evidence that production isolation guarantees exist.

Re-checked 2026-10-16 (X7) against origin/main 477529a: still open; the teploy-cli plan in AUDIT_OPEN (2026-09-24) has no landed change or live proof recorded.

## authority.command-regex-advisory

**Status:** open  **Owner:** teploy-ship

Command-regex approval classification is advisory, not an enforcement boundary.

**Scope / configuration:** defaultApprovalPolicy and sandboxApprovalPolicy classification of raw Bash and Python source, most relevant to the trusted-local executor. Open item teploy-ship-04.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `AUDIT_OPEN.md` |  | not recorded |

**Limitations:**
- Equivalent operations through other commands, APIs, indirection or argument forms may not be recognised.
- Deferred as a design project: capability-scoped executor boundaries and a policy corpus of equivalent spellings are not built.
- This is not evidence of an escape from the separate sandbox implementation.

Re-checked 2026-10-16 (X7) against origin/main 477529a: still open; teploy-ship-04 remains DEFERRED (design) in AUDIT_OPEN's resolution log.

## comparative.superiority

**Status:** disclaimed  **Owner:** teploy-ship

No claim is made that Ship is better than, faster than or more capable than any other product.

**Scope / configuration:** The programme treats competitor material as documented design references, not measured quality.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md` |  | not recorded |

**Limitations:**
- A superiority claim needs matched direct comparative evidence on named dimensions; none exists.

Re-checked 2026-10-16 (X7) against origin/main 477529a: still disclaimed; no comparative evidence exists.

## perception.look-live

**Status:** supported (verified)  **Owner:** teploy-ship

With SHIP_LOOK=1 and SHIP_LOOK_IMAGE_MODEL=zai/glm-5.3-flash, a production run recorded text accessibility look steps and one image look under the cap, and the facts it reported matched the live page.

**Scope / configuration:** One completed soak run (run-9d75d86d) against example.com on the production instance at the receipt's revision, native harness, zai/glm-5.3, postgres store, publication parked at approve-merge and approved by the operator.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/look.ts` |  | not recorded |
| automated | `src/look.test.ts` | runLook: url then snapshot comes back as the observation, parameters riding the script | 477529a602c0 |
| automated | `src/look.test.ts` | the open-tier refusal names the D3 rule: plan review, operator decision, no in-run workaround | 477529a602c0 |
| system | `evals/receipts/2026-10-16-look-soak.txt` |  | 25d592a0ac0e |

**Limitations:**
- n = 1 completed run on one public page; not a quality or reliability measure.
- Vision routing is inferred from the next model turn describing a pixel-only fact; the gateway's own usage count for the flash model was not read.
- The no-PR-attachment rule for look screenshots (D4) is unit-tested only; it was not visually confirmed on the forge PR.
- Production now runs a later revision (03748ab) than the one soaked; the look code did not change between them, but that run was not repeated.

## resource.browser-class

**Status:** provisional  **Owner:** teploy-ship

A run whose recorded input carries look is admitted as a browser resource class: its memory limit is raised by the measured browser delta and admission accounts for it, while plain runs are unchanged.

**Scope / configuration:** src/resource-class.ts and the worker's admission seams. Applies only to runs enqueued with SHIP_LOOK set.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/resource-class.ts` |  | not recorded |
| automated | `src/resource-class.test.ts` | a browser run's resolved limit carries the delta on every base, a plain run's is unchanged | 477529a602c0 |
| automated | `src/resource-class.test.ts` | flag-off equivalence: a plain run's overrides carry no class and are shape-identical to before | 477529a602c0 |
| automated | `src/resource-class.test.ts` | the raised limit reaches the daemon and the class itself never does | 477529a602c0 |

**Limitations:**
- Not verified live on a memory-squeezed host. The soak's look run was admitted with this code present, but the receipt does not record the raised limit or any hold.
- The 512 MB delta is the top of one measured page's overhead, not a measured ceiling; the pids limit is unchanged and unmeasured for multi-page sites.
- Placement enforcement is still shadow-only.

## delegate.coordinator

**Status:** provisional  **Owner:** teploy-ship

With SHIP_DELEGATE set at enqueue, a native run can delegate one level of child runs (cap 2 per task root) that inherit its gates, and each child's terminal result returns to the parent as an observation.

**Scope / configuration:** src/delegate.ts and the durable delegate action. Default off; scans and children never get delegation.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/delegate.ts` |  | not recorded |
| automated | `src/delegate.test.ts` | spawn is idempotent per (parent, turn) and the cap is hard per task root | 477529a602c0 |
| automated | `src/delegate.test.ts` | a delegate action parks on the child and merges its transfer back as the observation | 477529a602c0 |
| automated | `src/delegate.test.ts` | enqueue materialises SHIP_DELEGATE and suppresses it for scans and children | 477529a602c0 |

**Limitations:**
- Merged but not enabled in production; no live delegation run is recorded.
- Tests use scripted models and in-memory stores.

## thread.view

**Status:** provisional  **Owner:** teploy-ship

With SHIP_THREAD_VIEW=on, the run page and API show a follow-up chain as one read-only thread with each run's steering notes and ask parks; with it off, the payload is unchanged.

**Scope / configuration:** web/src/lib/thread-chain.server.ts and the thread API route. Read-only; no write surface.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `web/src/lib/thread-chain.server.ts` |  | not recorded |
| automated | `web/src/lib/thread-view.test.ts` | flag off (the default): the API says it is disabled, and the run page payload is unchanged | 477529a602c0 |
| automated | `web/src/lib/thread-chain.test.ts` | the thread contract: chain ordered by follow-up, per-run steer notes and ask parks | 477529a602c0 |
| automated | `web/src/lib/thread-chain.test.ts` | negative control: a run whose parent chain leaves the family is not a member | 477529a602c0 |

**Limitations:**
- Merged but not enabled in production; its one-run flip (backlog A1) has not happened.
- Descendants are found in a bounded recent-run window; a full window reports truncated.

## auth.admin-bootstrap

**Status:** supported (verified)  **Owner:** teploy-ship

On a store with no local accounts, the web process creates the first admin from SHIP_BOOTSTRAP_ADMIN_USER and SHIP_BOOTSTRAP_ADMIN_PASSWORD exactly once, never overwrites an existing principal, and never logs the password.

**Scope / configuration:** src/bootstrap-admin.ts at web boot. File, nucleus and postgres runtimes.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/bootstrap-admin.ts` |  | not recorded |
| automated | `src/bootstrap-admin.test.ts` | an install with existing principals is skipped entirely, even with the env set | 477529a602c0 |
| automated | `src/bootstrap-admin.test.ts` | the password never appears in any log line, result, or refusal reason | 477529a602c0 |
| automated | `src/bootstrap-admin.test.ts` | nucleus runtime: two web processes on one store — the KV setNX decides, the loser creates nothing | 477529a602c0 |
| system | `AUDIT_OPEN.md` |  | 03748ab2bc87 |

**Limitations:**
- The live evidence is the production observation recorded in AUDIT_OPEN (2026-10-16 bootstrap entry: one log line naming the user, on the postgres store), not a standalone receipt file.
- The cross-process race is seam-tested over a shared KV map, not raced live.
- No CLI for account management exists.

## store.postgres

**Status:** supported (verified)  **Owner:** teploy-ship

Ship runs its shared-store runtime on PostgreSQL: KV claims, run event streams and documents work on plain tables, with Nucleus left as the default dialect.

**Scope / configuration:** --store postgres / SHIP_STORE=postgres (src/nucleus-pgwire.ts postgres dialect). Production web and worker run on it.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/nucleus-pgwire.ts` |  | not recorded |
| automated | `src/nucleus-pgwire.test.ts` | postgres setNX acquires once and refuses a live holder, TTL lapse re-opens the key | 477529a602c0 |
| automated | `src/nucleus-pgwire.test.ts` | postgres streams round-trip fields in insertion order, per stream | 477529a602c0 |
| automated | `src/nucleus-pgwire.test.ts` | the postgres dialect reaches the store from nucleusRuntime; nucleus stays the default | 477529a602c0 |
| system | `evals/receipts/2026-10-16-look-soak.txt` |  | 25d592a0ac0e |

**Limitations:**
- The system evidence is a production soak whose subject was perception: a full run with a park and approval on the postgres store, not a store load or failure test.
- scripts/ship-backup.sh does not support the postgres layout yet (AUDIT_OPEN 2026-10-16); backups need teploy accessory backup or a cold pgdata tar.
- The pgvector code-index path is not exercised by the receipt.
