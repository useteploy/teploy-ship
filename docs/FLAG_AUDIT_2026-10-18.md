# Flag audit — 2026-10-18

Scope: every `SHIP_*` key in [FLAGS.md](FLAGS.md) — 192 rows (189 named keys plus the three read patterns `SHIP_EVENT_SECRET_<...>`, `SHIP_HARNESS_MODEL_<...>`, `SHIP_MCP_SECRET_<...>`). Non-`SHIP_*` rows (`OBSERVE_*`, `AI_GATEWAY_*`, OIDC-vendor keys, `PORT`, …) are out of scope.

Method. Read sites were verified on this branch with `grep -rn <FLAG> src web/src scripts` (test files excluded) — the line numbers below are from that grep, not from FLAGS.md, and every key was confirmed live. Production values are the non-secret `SHIP_*` values set on the production worker on 2026-10-18 (unsetting is not implied by absence: the list carries no secrets, so a secret key's absence is not evidence). Receipt evidence is `evals/receipts/*.txt`; soak runbooks and dispositions live in [SOAK_2026-10-16.md](SOAK_2026-10-16.md), [SHIP_RELEASE_PROGRAMME_2026-09-21.md](SHIP_RELEASE_PROGRAMME_2026-09-21.md) §E2, [AUDIT_OPEN.md](AUDIT_OPEN.md) and [DECISIONS_OPEN_2026-10-04.md](DECISIONS_OPEN_2026-10-04.md). A flag set in production to its default value still counts as wanted. Credential, URL, path, model-name and numeric rows are treated as deployment values, not feature gates: they land in KEEP-TUNING; only feature gates that are off pending evidence, code or an owner decision land in KEEP-OFF.

Classes: **DEFAULT-ON** (merged, proven in production and/or by a PASS receipt, no owner decision pending — flip the code default, keep the flag as an off-switch; rows already default-on in code are marked "already on"), **DELETE** (dead, superseded, or a one-off proof/migration knob that served its purpose), **KEEP-TUNING** (a value that legitimately varies per deployment), **KEEP-OFF** (stays off — experimental, shadow-only, or waiting on code, a credential or an owner decision; each says what would promote it).

## Summary

| Class | Count | Action |
| --- | ---: | --- |
| DEFAULT-ON | 33 | 22 need the code default flipped (11 are already default-on in code and only need the off-switch kept) |
| KEEP-TUNING | 132 | None — legitimate per-deployment values |
| KEEP-OFF | 22 | None now — promotion condition stated per row |
| DELETE | 5 | Remove the flag and its dead branch (all are script-only one-off knobs) |
| **Total** | **192** | |

## Flip list (DEFAULT-ON, safe order)

Read-only views first, then advisory wiring, then background workers, then flags materialised into run inputs, then the enqueue-materialising interactive features, then capability assertions, and the ACP harness last (its driver PR is still in security review).

1. `SHIP_THREAD_VIEW` — web-only read-only view; A1 PASS.
2. `SHIP_MISSION_VIEW` — read-only view; A7 PASS.
3. `SHIP_HARNESS_RECORD` — records identity rows only; A7 PASS.
4. `SHIP_STACK_DETECT` — read-only detection/proposals; A7 PASS.
5. `SHIP_PLAN_GROUNDING` — advisory report; A5 PASS (prose-refinement fix already merged).
6. `SHIP_FINDING_CONTINUITY` — advisory, review runs only; A5 PASS.
7. `SHIP_SCHEDULE_OVERLAP` — prevents duplicate runs; A6 PASS.
8. `SHIP_PR_WATCH` — background, forge reads only; B1 PASS (first-enable flood fixed).
9. `SHIP_LIVE_VIEW` — read-only panel + endpoint; D5 PASS.
10. `SHIP_STEER_REPLY` — materialised at enqueue, set web+worker; D2 PASS.
11. `SHIP_CHANGE_CLASS` — gates the merge park and auto boards; on in production through every 2026-10-17/18 soak.
12. `SHIP_TESTS` — deployment ask; suites ran on PRs in the stacked/skills soaks.
13. `SHIP_TELEMETRY` — deployment ask; inert without `OBSERVE_*` config, so safe to default on.
14. `SHIP_LOOK` — S12 text perception; look soak PASS ("leave on").
15. `SHIP_LOOK_RECORD` — Q3b recordings; skills/look-record soak PASS after six fixes.
16. `SHIP_SKILLS` — Q4 registry; skills soak PASS.
17. `SHIP_DELEGATE` — read-only children since #111; A4 re-soak PASS, DT soak PASS.
18. `SHIP_WARM_PARKS` — daemon capability assertion; used by the warm-thread PASS soak.
19. `SHIP_WARM_THREAD` — D4-c2 re-soak PASS (needs `SHIP_WARM_PARKS`; flip after it).
20. `SHIP_FORK` — DF1 PASS.
21. `SHIP_STACKED_PRS` — DS1 PASS.
22. `SHIP_ACP_HARNESS` — H0 contract receipts for all five agents; flip only after PR #145 (driver) passes review and one H4 live canary (needs a Gemini API key).

Already default-on in code (no flip owed; keep the `0`/`off` escape hatch): `SHIP_AUTO_MERGE`, `SHIP_CREDENTIAL_SCAN`, `SHIP_CRITIC_ADVISORY`, `SHIP_GIT_CREDENTIAL` (A8 default flip landed), `SHIP_MERGE_GATE`, `SHIP_RECOVERY`, `SHIP_REQUIRE_EDIT`, `SHIP_ROLLBACK`, `SHIP_TEST_DETECT`, `SHIP_TESTS_FEEDBACK`, `SHIP_WARM_CACHE`.

## Delete list

All five are read only by one-off check/proof scripts (zero reads in `src/` or `web/src`), are not wired into CI, and guard no production behaviour:

1. `SHIP_CHECK_REPO` — scripts/check-setup-sandbox.mjs only.
2. `SHIP_CHECK_COMMAND` — scripts/check-setup-sandbox.mjs only.
3. `SHIP_CHECK_EXPECTED` — scripts/check-setup-sandbox.mjs only.
4. `SHIP_TEST_NUCLEUS_URL` — scripts/probe-akiroo-receipts.mjs only (served-purpose probe).
5. `SHIP_TEST_RUN` — scripts/followup-browser-check.mjs + scripts/workspace-browser-check.mjs only (dev-time proofs; if the checks are kept, take the run id from argv).

`SHIP_ISOLATED_CHECK` is deliberately NOT on this list: it is the safety interlock for the whole `scripts/check-*.mjs` suite and stays.

## DEFAULT-ON (33)

| Flag | Read site (verified) | Prod | Receipt | Note |
| --- | --- | --- | --- | --- |
| `SHIP_ACP_HARNESS` | src/runtime.ts:1620 | `on` | 2026-10-18-h0-summary.txt (+ acp-gemini/grok/cursor/pi/qwen-code.txt) | E7 H3. Credential-gated at enqueue, so on-by-default is safe once the image carries the driver; H4 live canary owed. |
| `SHIP_AUTO_MERGE` | src/runtime.ts:1594 | unset (defaults on) | a4-a5-a7 (approve-merge parks) | Already on: deployment kill switch; per-repo `autoMerge` is the real switch. |
| `SHIP_CHANGE_CLASS` | src/runtime.ts:1534 | `1` | 2026-10-17-a4-a5-a7-soak.txt | Gates the merge park and auto boards; every 2026-10-17/18 soak ran under it. |
| `SHIP_CREDENTIAL_SCAN` | src/thread-warm.ts:329 | unset (defaults on) | — | Already on: h2-hardened scan; `off`/`warn` remain the escape hatch. |
| `SHIP_CRITIC_ADVISORY` | src/runtime.ts:1506 | unset (defaults on) | — | Already on: `0` restores the old retry. |
| `SHIP_DELEGATE` | src/runtime.ts:1399 | `1` | 2026-10-17-a4-a5-a7-soak.txt, 2026-10-17-dt-delegate-targets-soak.txt | Read-only children since #111; A4 re-soak PASS. |
| `SHIP_FINDING_CONTINUITY` | src/finding-continuity-wiring.ts:45 | `on` | 2026-10-17-a4-a5-a7-soak.txt | A5 PASS (second review classified against the first). |
| `SHIP_FORK` | src/fork.ts:35 | `on` | 2026-10-18-warm-thread-fork-soak.txt | DF1 PASS; set on both web and worker. |
| `SHIP_GIT_CREDENTIAL` | src/git.ts:170 | `env` | 2026-10-17-a8-git-credential-env.txt | A8 PASS; default already flipped to `env` — `argv` opts out for old-git images. |
| `SHIP_HARNESS_RECORD` | src/harness-identity.ts:37 | `on` | 2026-10-17-a4-a5-a7-soak.txt, 2026-10-17-harness-soak.txt | A7 PASS; identity rows proved in the harness soak. |
| `SHIP_LIVE_VIEW` | src/live-view.ts:100 | `on` | 2026-10-17-d2-d5-b1-soak.txt | D5 PASS; read-only, off = strict no-op. |
| `SHIP_LOOK` | src/runtime.ts:1391 | `1` | 2026-10-16-look-soak.txt | Soak verdict: "Leave SHIP_LOOK=1 … on". |
| `SHIP_LOOK_RECORD` | src/runtime.ts:1426 | `1` | 2026-10-18-skills-look-record-soak.txt | PASS after six live fixes; never linked on the PR. |
| `SHIP_MERGE_GATE` | src/runtime.ts:1538 | unset (defaults on) | a4-a5-a7 (approve-merge parks) | Already on: C1 boundary park; `0` restores old routing. |
| `SHIP_MISSION_VIEW` | src/mission-view.ts:58 | `on` | 2026-10-17-a4-a5-a7-soak.txt | A7 PASS; derived read-only projection. |
| `SHIP_PLAN_GROUNDING` | src/plan-grounding.ts:38 | `on` | 2026-10-17-a4-a5-a7-soak.txt | A5 wiring PASS; prose-refs precision fix merged (AUDIT_OPEN 2026-10-17). |
| `SHIP_PR_WATCH` | src/pr-watch.ts:89 | `on` | 2026-10-17-d2-d5-b1-soak.txt, 2026-10-18-stacked-pr-soak.txt | B1 PASS; flood defect fixed by `SHIP_PR_WATCH_MAX_AGE_DAYS`; stack-rebase proved 2026-10-18. |
| `SHIP_RECOVERY` | src/runtime.ts:1361 | unset (defaults on) | — | Already on: `0` turns the recovery leg off. |
| `SHIP_REQUIRE_EDIT` | src/runtime.ts:1385 | unset (defaults on) | — | Already on (since 2026-08-20): holds a finish over an unchanged tree. |
| `SHIP_ROLLBACK` | src/runtime.ts:1603 | unset (defaults on) | — | Already on: pure judgement/watch step; acting stays per-project `autoDeploy`. |
| `SHIP_SCHEDULE_OVERLAP` | src/workflow-schedules.ts:102 | `on` | 2026-10-17-a4-a5-a7-soak.txt | A6 PASS; overlap `skip`, no duplicate run. |
| `SHIP_SKILLS` | src/skills.ts:453 | `on` | 2026-10-18-skills-look-record-soak.txt | Q4 PASS; advice never authority. |
| `SHIP_STACKED_PRS` | src/stacked-pr.ts:32 | `on` | 2026-10-18-stacked-pr-soak.txt | DS1 PASS (full cycle incl. squash-merge rebase). |
| `SHIP_STACK_DETECT` | src/stack-propose.ts:28 | `on` | 2026-10-17-a4-a5-a7-soak.txt | A7 PASS; proposals only. |
| `SHIP_STEER_REPLY` | src/steer-reply.ts:14 | `on` | 2026-10-17-d2-d5-b1-soak.txt | D2 PASS; materialised at enqueue — default flip must note web+worker. |
| `SHIP_TELEMETRY` | src/runtime.ts:1476 | `1` | 2026-10-17-ev0-deploy.txt (Observe legs live) | Deployment ask; records a disabled step without `OBSERVE_*`, so default-on is safe. |
| `SHIP_TEST_DETECT` | src/test-detect.ts:202 | unset (defaults on) | — | Already on: `0` turns suite detection off. |
| `SHIP_TESTS` | src/cli.ts:891 (ask), src/runtime.ts:1474 | `1` | 2026-10-18-stacked-pr-soak.txt ("tests passed") | Deployment ask; per-project verification stays the authority. |
| `SHIP_TESTS_FEEDBACK` | src/runtime.ts:1490 | unset (defaults on) | — | Already on: `0` restores the plain retry loop. |
| `SHIP_THREAD_VIEW` | web/src/lib/thread-chain.server.ts:39 | `on` | 2026-10-16-a1-c1-soak.txt | A1 PASS; web-only, API 503s when off. |
| `SHIP_WARM_CACHE` | src/warm.ts:76 | unset (defaults on) | — | Already on: "on unless switched off". |
| `SHIP_WARM_PARKS` | src/runtime.ts:1920 | `1` | 2026-10-18-warm-thread-fork-soak.txt | Daemon capability assertion (teploy-sandbox 2a89f72+); off-switch for old daemons. |
| `SHIP_WARM_THREAD` | src/thread-warm.ts:114 | `on` | 2026-10-18-warm-thread-fork-soak.txt | D4-c2 re-soak PASS; cold path always completes. |

## KEEP-TUNING (132)

Deployment values — endpoints, credentials, models, paths, limits, durations, allowlists. Nothing to flip; listed with their verified read site, prod value where set, and receipt where one proves the wiring.

| Flag | Read site (verified) | Prod | Note / receipt |
| --- | --- | --- | --- |
| `SHIP_ACP_CANCEL_GRACE_MS` | src/harness-acp.ts:669 | unset | Driver default 15000 ms. |
| `SHIP_ACP_DRIVER` | src/harness-acp.ts:564 | unset | Test/probe override; image bakes the default. |
| `SHIP_ANTHROPIC_WIRE_PREFIXES` | src/model-id.ts:37 | unset | Provider prefix list. |
| `SHIP_ATTEMPTS` | src/runtime.ts:1673 | unset | Default 3, max 5. |
| `SHIP_BACKUP_DIR` | src/cli.ts:2492 | unset | A0 receipt ran backups via defaults. |
| `SHIP_BOOTSTRAP_ADMIN_PASSWORD` | src/bootstrap-admin.ts:50 | unset (secret) | Install-time break-glass; empty after bootstrap. |
| `SHIP_BOOTSTRAP_ADMIN_USER` | src/bootstrap-admin.ts:49 | `Tyler` | First-run bootstrap ran on production 2026-10-16. |
| `SHIP_CLASS_SENSITIVE_PATHS` | src/change-class.ts:147 | unset | Extra sensitive-path globs. |
| `SHIP_CLAUDE_BARE` | src/harness-external.ts:152 | unset | claude `--bare` mode. |
| `SHIP_CONFIG_KEY` | src/runtime-config.ts:123 | unset (secret) | Seals stored pull tokens at rest. |
| `SHIP_DAILY_AUTO_LIMIT` | src/worker.ts:1810 | `12` | Fleet-wide daily auto-launches. |
| `SHIP_DAILY_BUDGET_USD` | src/worker.ts:1420 | `30` | Per-source daily cap. |
| `SHIP_DELEGATE_MAX` | src/delegate.ts:47 | `2` | Cap 16; A4/DT soaks. |
| `SHIP_DELEGATE_TARGETS` | src/runtime.ts:2105 | `flash=native:zai/glm-5.3-flash` | Deployment allowlist; DT soak PASS. |
| `SHIP_DELEGATE_WAIT_MS` | src/delegate.ts:76 | unset | Default 30 min, ceiling 6 h (2026-10-17 live finding). |
| `SHIP_DELIVERY_DIR` | src/worker.ts:2228 | `/srv/ship-delivery/ship-journey-proof` | Trusted delivery working copy. |
| `SHIP_DELIVERY_STALE_MS` | src/worker.ts:2229 | unset | Default 35 min. |
| `SHIP_DEPLOY_LEASE_DIR` | src/teploy-adapter.ts:421 | unset | Lease dir beside the delivery clone. |
| `SHIP_DISK_PATH` | src/host-load.ts:63 | unset | Mount to measure when docker root is elsewhere. |
| `SHIP_EMBED_KEY` | src/cli.ts:1037 | unset | Embedding endpoint key. |
| `SHIP_EMBED_MODEL` | src/cli.ts:1034 | set but empty | Deliberately empty on prod: repo-index embedding leg off. |
| `SHIP_EMBED_URL` | src/cli.ts:1036 | unset | OpenAI-compatible /v1/embeddings. |
| `SHIP_ESTIMATED_RUN_COST_USD` | src/worker.ts:1419 | unset | Default 0.5 in-flight reservation. |
| `SHIP_EVENT_SECRET_<...>` | src/event-rules.ts:191 | unset | Per-source HMAC/token; the EV2 gate itself is KEEP-OFF. |
| `SHIP_FIX_RETRIES` | src/runtime.ts:1498 | unset | Default 2. |
| `SHIP_GITHUB_TOKEN` | src/repo-policy.ts:116 | unset (secret) | github.com credential; exercised by the A8 proof. |
| `SHIP_GIT_TOKEN` | src/repo-policy.ts:115 | unset (secret) | Origin-less credential; needs the allowlist. |
| `SHIP_GIT_TOKENS` | src/repo-policy.ts:114 | unset (secret) | Recommended credential + origin allowlist; A8 receipt. |
| `SHIP_HARNESS` | src/runtime.ts:1613 | unset (`native`) | Deployment default harness. |
| `SHIP_HARNESS_ATTEMPTS` | src/runtime.ts:1619 | unset | Adapter fallback chain. |
| `SHIP_HARNESS_ENV` | src/harness-external.ts:140 | unset | Forwarded env names for external harnesses. |
| `SHIP_HARNESS_MODEL` | src/harness-external.ts:139 | `glm-5.3` | Shared external-harness model. |
| `SHIP_HARNESS_MODEL_<...>` | src/harness-external.ts:138 | `_OPENCODE=zai-coding-plan/glm-5.3` | Per-harness override; used by the 2026-10-17 harness soak (#105). |
| `SHIP_HARNESS_TIMEOUT_MS` | src/harness-external.ts:133 | unset | Default 30 min per attempt. |
| `SHIP_INCIDENT_INTAKE_SECRET` | web/src/lib/incident-intake.server.ts:48 | secret (set per EV0 receipt) | EV0: intake live 2026-10-17. |
| `SHIP_INCIDENT_RECOVERY_MINUTES` | src/worker.ts:2060 | `10` | Sustained-healthy window. |
| `SHIP_INCIDENT_RECOVERY_POLL_SECONDS` | src/worker.ts:208 | `60` | Poll spacing. |
| `SHIP_INDEX_TIMEOUT_MS` | src/durable.ts:1810 | unset | Default 120 s repo-index cap. |
| `SHIP_INTAKE_POLICIES` | src/cli.ts:2148 | `{"forgejo":"auto"}` | Per-source propose/auto; kept pr-watch proposals from launching (B1 receipt). |
| `SHIP_ISOLATED_CHECK` | scripts/check-setup-sandbox.mjs:9 (+9 more check scripts) | unset | Safety interlock for the check suite — do not delete. |
| `SHIP_JOURNEY_FORGE_TOKEN` | scripts/eval-journeys-ship.mjs:272 | unset (secret) | Journey-eval forge token; G1 parity runs still ahead. |
| `SHIP_LINEAR_SIGNING_SECRET` | web/src/routes/hooks/linear.tsx:17 | unset (secret) | Decision 7: a self-hoster feature; route proven by tests. |
| `SHIP_LOCAL_MODEL_PREFIXES` | src/pricing.ts:149 | unset | Zero-cost local models. |
| `SHIP_LOOK_IMAGE_MAX` | src/runtime.ts:1415 | unset | Per-run screenshot cap, default 3 (look soak). |
| `SHIP_LOOK_IMAGE_MODEL` | src/runtime.ts:1409 | `zai/glm-5.3-flash` | Decision 3; names this deployment's vision model — value is deployment-specific, unset refuses loudly. |
| `SHIP_MAX_CONCURRENT_RUNS` | src/support.ts:298 (env read), src/host-load.ts:206 | `4` | Override; unset = measured capacity. |
| `SHIP_MAX_INODE_USED_PCT` | src/worker.ts:1439 | unset | Default 95. |
| `SHIP_MAX_LOAD_PER_CPU` | src/worker.ts:1437 | `4` | Default 1.5. |
| `SHIP_MAX_OUTPUT_TOKENS` | src/worker.ts:972 | unset | Adapter default 4096. |
| `SHIP_MAX_RUN_COST_USD` | src/worker.ts:950 | `1.00` | A4 soak cap; delegated children narrow it. |
| `SHIP_MAX_STEPS` | src/worker.ts:878 | `160` | Default 40. |
| `SHIP_MCP_REMOTE_HOSTS` | src/mcp.ts:193 | unset | Remote MCP host allowlist; unset = none contacted. |
| `SHIP_MCP_REMOTE_PORTS` | src/mcp.ts:194 | unset | Non-default ports; unset = 443/80 only. |
| `SHIP_MCP_SECRET_<...>` | src/mcp.ts:524 | unset | Per-server bearer credentials; never recorded. |
| `SHIP_MIN_FREE_DISK_MB` | src/worker.ts:1438 | unset | Default 2048. |
| `SHIP_MIN_FREE_MB` | src/worker.ts:1436 | `600` | Matches the documented sizing. |
| `SHIP_MODEL` | src/model-id.ts:21 | `zai/glm-5.3` | Deployment model. |
| `SHIP_MODEL_PRICING` | src/pricing.ts:206 | set (glm-5.3 rates) | Explicit rates for unlisted models. |
| `SHIP_MODEL_ROUTING_CONTEXT_TOKENS` | src/model-routing-wire.ts:184 | unset | Task-fact default 32k. |
| `SHIP_MODEL_ROUTING_DATA_CLASS` | src/model-routing-wire.ts:178 | unset | Task-fact override; default `private`. |
| `SHIP_MODEL_ROUTING_DESTINATIONS` | src/model-routing-wire.ts:179 | `api.z.ai` | Cleared the destination gate (2026-10-16 routing mount). |
| `SHIP_MODEL_ROUTING_MAX_OUTPUT_TOKENS` | src/model-routing-wire.ts:185 | unset | Routing-plan fact, default 8k. |
| `SHIP_MODEL_ROUTING_MAX_RETENTION` | src/model-routing-wire.ts:180 | unset | Routing-plan fact. |
| `SHIP_MODEL_ROUTING_POLICY` | src/model-routing-policy.ts:113 | `/srv/ship-config/routing-policy.json` | Policy file (2026-10-16.1, Decision 9). |
| `SHIP_MODEL_TIMEOUT_MS` | src/provider.ts:145 | `600000` | Per-call timeout. |
| `SHIP_NOTIFY_SECRET` | src/notify.ts:446 | unset (secret) | Signs the return leg. |
| `SHIP_NOTIFY_URL` | src/notify.ts:445 | set (akiroo webhook) | Akiroo return leg; unset refuses to start (src/akiroo.ts:102). |
| `SHIP_OBSERVE_MAX_SKEW_S` | web/src/lib/webhook.server.ts:205 | unset | Replay window for the observe hook (route pending Decision 14 retirement). |
| `SHIP_OIDC_ADMIN_GROUP` | web/src/lib/oidc.server.ts:74 | unset | SSO role mapping. |
| `SHIP_OIDC_CLIENT_ID` | web/src/lib/oidc.server.ts:59 | unset | Required to enable SSO. |
| `SHIP_OIDC_CLIENT_SECRET` | web/src/lib/oidc.server.ts:67 | unset | Omit for PKCE-only clients. |
| `SHIP_OIDC_DEFAULT_ROLE` | web/src/lib/oidc.server.ts:77 | unset | Least-privilege fallback. |
| `SHIP_OIDC_EDITOR_GROUP` | web/src/lib/oidc.server.ts:75 | unset | SSO role mapping. |
| `SHIP_OIDC_GROUPS_CLAIM` | web/src/lib/oidc.server.ts:73 | unset | Default `groups`. |
| `SHIP_OIDC_ISSUER` | web/src/lib/oidc.server.ts:58 | unset | Required to enable SSO. |
| `SHIP_OIDC_LABEL` | web/src/lib/oidc.server.ts:70 | unset | Button text. |
| `SHIP_OIDC_REDIRECT_URL` | web/src/lib/oidc.server.ts:68 | unset | Behind a Host-rewriting proxy. |
| `SHIP_OIDC_ROLE_CLAIM` | web/src/lib/oidc.server.ts:72 | unset | Default `teploy_role`. |
| `SHIP_OIDC_SCOPES` | web/src/lib/oidc.server.ts:69 | unset | Add `groups` for group mapping. |
| `SHIP_OIDC_USERNAME_CLAIM` | web/src/lib/oidc.server.ts:71 | unset | Default `preferred_username`. |
| `SHIP_OIDC_VIEWER_GROUP` | web/src/lib/oidc.server.ts:76 | unset | SSO role mapping. |
| `SHIP_ORACLE_PATHS` | src/test-integrity-surface.ts:174 | unset | Oracle-path globs for the integrity panel. |
| `SHIP_PLACEMENT_DRAINING` | src/placement-shadow.ts:475 | unset | Drain a host in the shadow/placement model. |
| `SHIP_PLACEMENT_REQUIRE` | src/placement-shadow.ts:179 | unset | Deployment-wide placement requirement (shadow phase). |
| `SHIP_PLACEMENT_SHADOW_FILE` | src/placement-shadow.ts:72 | unset | Shadow record path. |
| `SHIP_PLACEMENT_TARGETS` | src/placement-shadow.ts:170 | unset | Declared host facts (shadow phase). |
| `SHIP_POLICY_LAYERS_FILE` | src/policy-shadow.ts:101 | unset | Operator policy layers for the shadow. |
| `SHIP_POLICY_SHADOW_FILE` | src/policy-shadow.ts:99 | unset | Shadow record path. |
| `SHIP_PREVIEW_BIN` | src/deploy.ts:530 | unset | Image ships the pinned CLI; override only. |
| `SHIP_PREVIEW_DESTINATION` | src/deploy.ts:532 | unset | `-d` overlay so previews cannot hit prod. |
| `SHIP_PREVIEW_DIR` | src/deploy.ts:528 | `/srv/ship-preview` | The preview switch; per-worker clone. |
| `SHIP_PREVIEW_MAIN_URL` | src/deploy.ts:535 | `ship-preview-proof=http://100.107.192.39/` | visual-diff rung main URL. |
| `SHIP_PREVIEW_TAILNET_IP` | src/deploy.ts:534 | `100.107.192.39` | 2026-09-24 tailnet preview ruling; set on web too. |
| `SHIP_PREVIEW_TIMEOUT_MS` | src/deploy.ts:533 | unset | Per-command ceiling. |
| `SHIP_PREVIEW_TTL` | src/deploy.ts:531 | unset | Passed to the CLI's prune. |
| `SHIP_PR_WATCH_INTERVAL_SEC` | src/pr-watch.ts:93 | unset | Min 30 s. |
| `SHIP_PR_WATCH_MAX_AGE_DAYS` | src/pr-watch.ts:104 | unset | Default 14, clamp 1-90 (flood fix). |
| `SHIP_PR_WATCH_MAX_PER_SWEEP` | src/pr-watch.ts:98 | unset | Cap 1-200. |
| `SHIP_PUBLIC_URL` | src/cli.ts:2101 | `http://100.108.123.49:7460` | Authoritative external URL. |
| `SHIP_PUBLISH_HARD_MAX_FILES` | src/publish-policy.ts:239 | unset | Blast-radius refusal cap. |
| `SHIP_QUOTA_MODEL_PREFIXES` | src/pricing.ts:181 | `zai/,zai-coding-plan/` | Subscription-billed prefixes. |
| `SHIP_REPO_ALLOWLIST` | src/repo-policy.ts:113 | set (forge + proof repo) | A8 receipt added the GitHub proof origin. |
| `SHIP_ROOT` | src/cli.ts:2579 | unset | State root; A0 receipt. |
| `SHIP_SAFE_FETCH_ALLOW` | src/forge-egress.ts:63 | `100.108.123.49:49152` | Trusted forge hosts (pairs with SAFE_FETCH). |
| `SHIP_SANDBOX_APPROVAL` | src/approval.ts:98 | unset | auto/boundary/strict policy. |
| `SHIP_SANDBOX_IMAGE` | src/cli.ts:731 | `ship-sandbox-harness:dev` | h2 image promoted 2026-10-17 (harness soak). |
| `SHIP_SANDBOX_NETWORK` | src/cli.ts:741 | `egress` (old spelling of `allowlist`) | Tier per deployment; project narrows. |
| `SHIP_SANDBOX_TOKEN` | src/cli.ts:723 | secret (set) | Daemon credential. |
| `SHIP_SANDBOX_TTL_SEC` | src/cli.ts:708 | `86400` | Daemon max; sized for long thinking-model runs. |
| `SHIP_SANDBOX_URL` | src/cli.ts:721 | compute-1 + compute-2 | C1 second host PASS (2026-10-16-a1-c1-soak.txt). |
| `SHIP_SECRETS_FILE` | src/cli.ts:489 | unset | Secrets file for CLI runs. |
| `SHIP_SELFWATCH_INTERVAL_S` | src/worker.ts:2167 | unset | Default 60 s; `0` disables. |
| `SHIP_SESSION_SECRET` | web/src/lib/session.server.ts:64 | unset (secret) | Session survival across token rotation. |
| `SHIP_SLACK_SIGNING_SECRET` | web/src/routes/hooks/slack.tsx:17 | unset (secret) | Decision 7: self-hoster intake; tests proven, live route pending B6. |
| `SHIP_SLACK_WEBHOOK_URL` | src/notify.ts:217 | unset | Outbound Slack webhook (opt-in). |
| `SHIP_SMOKE_REPO` | scripts/smoke-e2e.mjs:260 | unset | Throwaway repo for the CI smoke workflow. |
| `SHIP_STORE` | src/install-doctor.ts:270 | unset (postgres in prod via config) | file | nucleus | postgres. |
| `SHIP_TAKEOVER_TTL_SEC` | src/workspace-requests.ts:611 | unset | Takeover lease TTL. |
| `SHIP_TEPLOY_VERSION` | src/support.ts:511 | unset | Support-bundle CLI version override. |
| `SHIP_TEST_COMMAND` | src/tests.ts:40 | `go test ./...` | Last-resort suite. |
| `SHIP_TEST_TIMEOUT_MS` | src/tests.ts:42 | unset | Timeout = "not run", never failed. |
| `SHIP_TOOL_MANIFEST_FILE` | src/tool-manifest-shadow.ts:105 | unset | Manifest file for the shadow/on gate. |
| `SHIP_TOOL_MANIFEST_SHADOW_FILE` | src/tool-manifest-shadow.ts:53 | unset | Shadow record path. |
| `SHIP_TRUST_PROXY` | web/src/lib/oidc.server.ts:154 | unset | Only behind a real proxy. |
| `SHIP_URL` | scripts/launch-browser-check.mjs:5 (+7 more) | unset | Tooling base URL (checks/eval journeys; docs/WORKSPACE.md). |
| `SHIP_VERSION` | web/src/routes/health.tsx:42 | unset | Health endpoint build version. |
| `SHIP_WARM_THREAD_TTL_SEC` | src/thread-warm.ts:123 | unset | Decision 16 default 7200. |
| `SHIP_WEBHOOK_MAX_BYTES` | web/src/lib/webhook.server.ts:24 | unset | Body cap before signature work. |
| `SHIP_WEBHOOK_SECRET` | src/worker.ts:1924 | secret (set) | Forge webhook signing (akiroo registration). |
| `SHIP_WEB_PORT` | src/cli.ts:2532 | unset | Default 7460. |
| `SHIP_WEB_TOKEN` | src/cli.ts:2381 | secret (set) | Dashboard auth token. |
| `SHIP_WORKER_ONLY_SECRETS` | web/src/routes/settings.tsx:65 | unset | Settings-page redaction list. |

## KEEP-OFF (22)

| Flag | Read site (verified) | Prod | Evidence | Stays off because / promotion |
| --- | --- | --- | --- | --- |
| `SHIP_ALLOW_FORGE_COLOCATION` | src/colocation.ts:107 | unset | — | Escape hatch that overrides a colocation refusal; set only after reading the refusal. Promote: never by default — it exists to be exceptional. |
| `SHIP_ALLOW_UNSANDBOXED_INTAKE` | src/cli.ts:761 | unset | — | "Only for a disposable box." Promote: never — a security floor, not a setting. |
| `SHIP_BUDGET_RESERVATION` | src/budget-gate.ts:56 | `shadow` | A2 | Pre-decided in E2: `on` is refused off the file runtime; stays shadow until C8 (cross-process reservation on postgres). Promote: C8 landing + soak. |
| `SHIP_DEPLOY_ADAPTER` | src/teploy-adapter.ts:57 | unset | — | S27 opt-in. Promote: A9 live proof (approved deploy + readback + rollback receipt). |
| `SHIP_EVENT_ENVELOPE` | src/notify.ts:410 | unset | — | Outbound envelope default off; EV2/B2 reuse the format. Promote: with the EV2 notification decision. |
| `SHIP_EVENT_RULES` | src/event-rules.ts:23 | unset | — | EV2 merged but not live-proven. Promote: EV3 built-ins in `shadow`, resolve the shadow diffs (install-doctor flow), then one soak per source. |
| `SHIP_HARNESS_CRED` | src/harness-credentials.ts:97 | unset | — | H2 sealed credentials: PR #135 in security review (round 3). Promote: review pass + one sealed-credential live run. |
| `SHIP_INCIDENT_EVIDENCE` | src/worker.ts:229 | unset | — | EV5 merged, not live-proven. Promote: one live incident diagnosis with evidence readers (X4). |
| `SHIP_INCIDENT_FIX` | src/incidents.ts:169 (gate at src/runtime.ts:1547) | unset | — | EV6 repro-test gate, not live-proven. Promote: one authorised remediation soak end to end. |
| `SHIP_INTEGRATION_CHECK` | src/integration-check.ts:32 | unset | — | X5: needs worker tree provisioning code first. Promote: X5 slice + a recorded producer/consumer run. |
| `SHIP_KNOWLEDGE_PROVENANCE` | src/knowledge-provenance.ts:32 | `shadow` | A2 | Shadow wrote nothing before the 2026-10-16 chown; clock restarted. Promote: Q5 acceptance against a frozen retrieval baseline. |
| `SHIP_MCP` | src/mcp.ts:181 | unset | — | D1 complete but unsoaked in production. Promote: A2 disposition + one run calling a declared server. |
| `SHIP_MCP_REMOTE_PRIVATE` | src/mcp.ts:200 | unset | — | Decision 6: leave unset; private data flows only via routing-policy retention `none`. Promote: an owner explicitly allowing one policy-covered server. |
| `SHIP_MODEL_ROUTING` | src/model-routing-policy.ts:30 | `shadow` | A2, Decision 9 | Decision 9 cleared the data gate, but routing `on` needs Q9 (tool-call journal, mid-run switches). Promote: Q9 slice + fixed-vs-routed comparison. |
| `SHIP_OBSERVE_SIGNING_SECRET` | web/src/routes/hooks/observe.tsx:43 | unset (prod 503s by EV0 receipt) | 2026-10-17-ev0-deploy.txt | Decision 14: retire `/hooks/observe` once the incident intake is proven live. Promote: never — after one live signed Observe delivery, DELETE this secret and the route. |
| `SHIP_PLACEMENT` | src/placement-shadow.ts:65 | `shadow` | A2 (clock restarted 2026-10-16) | Shadow vs pool. Promote: A2 disposition (promote the shadow's choice or document the gap). |
| `SHIP_POLICY_SHADOW` | src/policy-shadow.ts:95 | `on` | A2 (clock restarted 2026-10-16) | S25 shadow, `on` = shadow mode here. Promote: X9 enforcement at the covered decision points. |
| `SHIP_PREVIEW` | src/runtime.ts:1474 | unset (per-project asks carry it) | look/skills soaks on ship-preview-proof | Deployment-wide ask would override repos that want none. Promote: an owner wanting previews everywhere; per-project `verification.preview` stays the authority. |
| `SHIP_SAFE_FETCH` | src/forge-egress.ts:61 | unset (default shadow) | A3 | Promote per A3: reviewed shadow log with no false refusals, then `on`. |
| `SHIP_SETTLE` | src/runtime.ts:1364 | unset | — | Opt-in settle leg, never set in production, no receipt. Promote: a soak that shows the settle step's value; otherwise candidate for DELETE at the next audit. |
| `SHIP_TEST_INTEGRITY_SURFACING` | src/test-integrity-surface.ts:49 | `shadow` | 2026-10-17-a4-a5-a7-soak.txt | "Stays shadow until its log is reviewed" (A5). Promote: shadow-log review + the enqueue-vs-publish read reconciliation (E2 A5 note). |
| `SHIP_TOOL_MANIFEST` | src/tool-manifest-shadow.ts:48 | `shadow` | A2 | E2: needs executor host/secret-effect reporting before `on` (folds into D1). Promote: that code + shadow review. |

## DELETE (5)

| Flag | Read site (verified) | Prod | Why delete |
| --- | --- | --- | --- |
| `SHIP_CHECK_REPO` | scripts/check-setup-sandbox.mjs:9 | unset | Zero reads in `src/`/`web/src`; one-off isolated fixture guard, not CI-wired. |
| `SHIP_CHECK_COMMAND` | scripts/check-setup-sandbox.mjs:9 | unset | Same script, same purpose — a served-purpose proof knob. |
| `SHIP_CHECK_EXPECTED` | scripts/check-setup-sandbox.mjs:31 | unset | Same script; a default-hiding assertion toggle. |
| `SHIP_TEST_NUCLEUS_URL` | scripts/probe-akiroo-receipts.mjs:10 | unset | One-off Akiroo receipts probe; served its purpose. |
| `SHIP_TEST_RUN` | scripts/followup-browser-check.mjs:5, scripts/workspace-browser-check.mjs:9 | unset | Dev-time browser proofs; if the checks are kept, take the run id from argv so the product flag surface shrinks. |

## Notes and anomalies

- **Prod sets keys the code does not read.** `SHIP_WEB_HOST=0.0.0.0` has no read anywhere in `src/`/`web/src`/`scripts/` (it is deploy-level). Harmless, but it is not a flag.
- **Scanner gap.** `SHIP_SANDBOX_HOST_MEMORY_MB` / `SHIP_SANDBOX_HOST_CPUS` are read through a helper at src/host-load.ts:349-350 (both set on prod: `7800` / `3`) yet have no FLAGS.md row — the generated reference misses helper-indirected reads. Both are KEEP-TUNING (box-sizing facts when the daemon runs elsewhere); the reference should grow rows.
- **Secrets are invisible to the prod list by design.** Absence of `SHIP_*_SECRET`/token keys above is not evidence they are unset; where a receipt proves one live (EV0: `SHIP_INCIDENT_INTAKE_SECRET`; A8: git tokens) it is cited.
- **`SHIP_EMBED_MODEL=` is set but empty on prod** — a deliberate off switch for the embedding leg, not an oversight.
- `SHIP_WARM_THREAD` requires `SHIP_WARM_PARKS`; flip them together (18 then 19 in the flip list).
- Deleting the five DELETE rows also means regenerating FLAGS.md (`node scripts/flag-reference.mjs`) once the scripts' reads are removed — CI's `--check` will otherwise keep the rows alive.
