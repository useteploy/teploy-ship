# Claim ledger

<!-- GENERATED from docs/claims/ledger.json by scripts/claim-ledger.mjs --render. Do not edit by hand; `--check` fails if this file is out of date. -->

Each claim states what it covers, what kind of evidence stands behind it, and what it does not show. Evidence classes: implementation (the code or document exists), automated (a test or probe in this repository), system (observed in a real system), human (a recorded observation), comparative (matched measurement against an alternative). A claim is `supported` only with automated or system evidence; it is marked verified only with system evidence at an exact revision. Automated evidence carries the commit at which its tests were last run green; any later change to its cited path makes it a candidate for re-running (`node scripts/claim-ledger.mjs --check --stale`). No claim in the first seeding has system-class evidence at a known revision, so none is marked verified. Publication, tag and visibility decisions are not made by this file.

| id | status | verified | claim |
| --- | --- | --- | --- |
| [model.default-id](#modeldefault-id) | supported | no | The default model id is zai/glm-5.3, with precedence --model, then SHIP_MODEL, then config file, then default. |
| [model.default-quality](#modeldefault-quality) | provisional | no | glm-5.3 resolved 35 of 50 seeded SWE-bench Lite instances. |
| [harness.native-steering](#harnessnative-steering) | provisional | no | Steering notes are offered and accepted only for runs whose harness can consume them, which is the native harness only. |
| [harness.external-refuse-plan-review](#harnessexternal-refuse-plan-review) | supported | no | External harnesses refuse plan review: a run that requires plan review fails with an explicit error and starts no external agent. |
| [delivery.stale-executing](#deliverystale-executing) | supported | no | A delivery stuck in executing past the stale window is recognised as stale only by state and age, and stale rollback reconciliation reads the target before deciding. |
| [git.credential-scrub-same-shell](#gitcredential-scrub-same-shell) | supported | no | Authenticated clone and warm fetch scrub the remote in the same shell invocation as the credential, whatever the credentialed step returns. |
| [git.env-credential-mode](#gitenv-credential-mode) | provisional | no | SHIP_GIT_CREDENTIAL=env keeps the Git token out of every command line and out of .git/config. |
| [eval.retained-recount](#evalretained-recount) | supported | no | The retained product-journey records count 15 pass, 5 fail, 6 unknown and 2 harness-error over 28 attempts in 20 runs. |
| [eval.headline-21-13-2](#evalheadline-21-13-2) | disclaimed | no | The earlier headline of 21 passes, 13 failures and 2 human-gated harness errors over 36 attempts is not claimed. |
| [preview.egress-unrestricted](#previewegress-unrestricted) | open | no | A tailnet preview container can reach the internet, the LAN, the tailnet and other containers on the shared bridge; it is not restricted by the sandbox allowlist. |
| [authority.command-regex-advisory](#authoritycommand-regex-advisory) | open | no | Command-regex approval classification is advisory, not an enforcement boundary. |
| [comparative.superiority](#comparativesuperiority) | disclaimed | no | No claim is made that Ship is better than, faster than or more capable than any other product. |

Counts: supported 5, provisional 3, disclaimed 2, open 2. Claims marked verified: 0.

## model.default-id

**Status:** supported  **Owner:** teploy-ship

The default model id is zai/glm-5.3, with precedence --model, then SHIP_MODEL, then config file, then default.

**Scope / configuration:** Model id resolution only (src/model-id.ts). Says nothing about how well that model performs.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/model-id.ts` |  | not recorded |
| automated | `src/model-id.test.ts` | flag wins over env and config | dd682c7acc4e |
| automated | `src/model-id.test.ts` | an empty SHIP_MODEL falls through to config, then the default | dd682c7acc4e |

**Limitations:**
- Resolution of the id string only; whether the configured gateway serves it is not checked.

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

## harness.native-steering

**Status:** provisional  **Owner:** teploy-ship

Steering notes are offered and accepted only for runs whose harness can consume them, which is the native harness only.

**Scope / configuration:** The capability table in src/harness-capabilities.ts, as consulted by the run page and the steering route.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/harness-capabilities.ts` |  | not recorded |
| automated | `src/harness-capabilities.test.ts` | S13: only the native harness takes steering notes | dd682c7acc4e |
| automated | `src/harness-capabilities.test.ts` | S13: a multi-harness run supports a capability only if every attempt does | dd682c7acc4e |

**Limitations:**
- The table is tested; the route refusal itself has no automated test.
- No live steering of a real native run is recorded.
- External harnesses (claude-code, opencode) cannot be steered; that is a gap, not a feature.

## harness.external-refuse-plan-review

**Status:** supported  **Owner:** teploy-ship

External harnesses refuse plan review: a run that requires plan review fails with an explicit error and starts no external agent.

**Scope / configuration:** claude-code and opencode adapters, at admission (runtime) and on direct workflow execution.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/runtime.ts` |  | not recorded |
| implementation | `src/harness-external.ts` |  | not recorded |
| automated | `src/harness-external.test.ts` | direct external execution cannot bypass requested plan review | dd682c7acc4e |

**Limitations:**
- The test drives a fake claude binary; the admission-time check in src/runtime.ts has no dedicated cited test here.
- No real external harness run was observed.

## delivery.stale-executing

**Status:** supported  **Owner:** teploy-ship

A delivery stuck in executing past the stale window is recognised as stale only by state and age, and stale rollback reconciliation reads the target before deciding.

**Scope / configuration:** src/delivery.ts state machine with in-memory and fake targets. Delivery execution is off without SHIP_DELIVERY_DIR.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/delivery.ts` |  | not recorded |
| automated | `src/delivery.test.ts` | isStaleExecuting keys on state and age, above the execution ceiling | dd682c7acc4e |
| automated | `src/delivery.test.ts` | gap: stale rollback reconciliation reads the target | dd682c7acc4e |

**Limitations:**
- No live forge or deployment target was exercised.
- The stale window is a fixed 35 minutes by default.

## git.credential-scrub-same-shell

**Status:** supported  **Owner:** teploy-ship

Authenticated clone and warm fetch scrub the remote in the same shell invocation as the credential, whatever the credentialed step returns.

**Scope / configuration:** src/git.ts clone and warm-volume fetch through an executor.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/git.ts` |  | not recorded |
| automated | `src/git.test.ts` | S01: authenticated clone and fetch scrub the remote in the same shell invocation as the credential | dd682c7acc4e |

**Limitations:**
- The sequencing test fails on the previous code; the failed-fetch probe on a real checkout is a regression pin only (the old path also scrubbed).
- Not proven through the Sandbox daemon or a live private repository.

## git.env-credential-mode

**Status:** provisional  **Owner:** teploy-ship

SHIP_GIT_CREDENTIAL=env keeps the Git token out of every command line and out of .git/config.

**Scope / configuration:** LocalExecutor with a real git and a local HTTP server. Implemented, OFF by default (argv mode remains the default).

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `src/git.ts` |  | not recorded |
| automated | `src/git.test.ts` | S01: env credential mode keeps the token out of argv and the URL, argv mode does not | dd682c7acc4e |
| automated | `src/git.test.ts` | S01: a real git clone in env mode sends the credential as a header and never puts it in argv or config | dd682c7acc4e |

**Limitations:**
- Unproven live: the Sandbox daemon must forward per-exec env, and the sandbox git must be 2.31 or later.
- No private-repo clone or push on Forgejo or GitHub through the real sandbox has been run.
- Default unchanged; see AUDIT_OPEN.md before flipping it.

## eval.retained-recount

**Status:** supported  **Owner:** teploy-ship

The retained product-journey records count 15 pass, 5 fail, 6 unknown and 2 harness-error over 28 attempts in 20 runs.

**Scope / configuration:** evals/product-journeys/results at the recount of 2026-10-03, using the recorded outcome where present and outcomeOf otherwise. A development and regression set, not held-out, and not a model-quality number.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `evals/product-journeys/BASELINE_RECOUNT_2026-10-03.md` |  | not recorded |
| automated | `scripts/eval-report.test.mjs` | each outcome class is counted exactly once and unknown is neither pass nor fail | dd682c7acc4e |
| automated | `scripts/eval-report.test.mjs` | negative control: an unknown record is in no pass or fail count and no denominator | dd682c7acc4e |

**Limitations:**
- The counting rules are tested on synthetic trees; the figures themselves are the generated report, not a separate test.
- Costs: 12 records priced, 16 unknown; the priced sum is a lower bound.
- Supplements (one regrade, one reclassification) are listed but not applied.

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

## comparative.superiority

**Status:** disclaimed  **Owner:** teploy-ship

No claim is made that Ship is better than, faster than or more capable than any other product.

**Scope / configuration:** The programme treats competitor material as documented design references, not measured quality.

| class | path | test | revision |
| --- | --- | --- | --- |
| implementation | `docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md` |  | not recorded |

**Limitations:**
- A superiority claim needs matched direct comparative evidence on named dimensions; none exists.
