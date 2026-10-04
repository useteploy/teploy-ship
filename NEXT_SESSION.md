# Next session

The single forward plan is [docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md](docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md); its **Execution status** section (the wave-2, wave-3 and wave-4 tables) plus the wave-5 notes at the top of [AUDIT_OPEN.md](AUDIT_OPEN.md) are the only status lists. Update both rather than creating another plan.

## Where things stand (2026-10-04, after wave 5)

Wave 4's state ("implemented and checked by automated tests only") is now partly superseded by live receipts:

- **S02 batch executed** (A only, glm-5.3 via the gateway's coding-plan key, $0 real spend): canary + 33 runs, 24/33 first-attempt passes, $1.81 priced. Read [evals/product-journeys/BATCH_2026-10-04.md](evals/product-journeys/BATCH_2026-10-04.md) first — including the `pj-s-question` 0/3 variance signal.
- **Production upgraded** `dd5b13e` -> `80c9187`: coordinated stop, pre-deploy backup verified, five waiting runs intact, gateway untouched at `c0b07dd`.
- **Shadows are ON in production** (budget-reservation, model-routing, policy, tool-manifest, knowledge-provenance = shadow; policy-shadow = on). They need soak time and then a log review before any `on` flip.
- **Founder decisions recorded 2026-10-04**: S28 n>=20 confirmed; S25 service-account stays id-only; S08 findings WILL reach PR body + webhook (approved, **not yet built** — new work); the 79 sub-24px targets stay compact; upstream reports filed (neutron#6 404 page, teploy-cli#18/#19/#20).
- **Known live variance**: `pj-s-question` canary pass + 0/3 batch — compare the four transcripts before touching prompts.

## Next work, in order

1. **Shadow-log review** after soak (placement/policy/budget/tool-manifest/knowledge-provenance JSONL + reports); set `SHIP_MODEL_ROUTING_POLICY` so the routing shadow has something to record. Only then discuss any `on` flips.
2. **S08 wiring** (approved): findings into PR body + webhook behind a default-off flag; worker-path change, so shadow-first per the standing rule.
3. **Live proofs still open**: S01 credential proofs on a real sandbox with a private repo; S03 storage migration (write the additive migration, rehearse on a restored copy — backup `pre-80c9187-shadow-deploy-2026-10-04` is available and verified); S27 real teploy-adapter run against a scratch target; S19 doctor probes against the real store/clock; human observation of dashboard users.
4. **Code still unfinished**: S04 and S12 barely started; most of S07 beyond the grounding check; S10 follow-ups (offline/error states, other roles, screen readers); wiring the inert modules (S15/S17 into delivery+incidents, S19 snapshot producer + restore-check, S18 worker tree provisioning, S07 into the plan-park point).
5. **Re-grade retained runs where possible**: only transcripts were preserved for pre-batch runs, so regrades are limited to transcript+fixture-verifiable scenarios; write supplementary `regrade-*.json` beside the records, never replacing originals.
6. **Deferred**: configuration B of the S02 comparison (needs real API spend, owner-gated).

## Working rules that paid off

- One branch and PR per slice; merge only on green CI, pinned to the checked head; resolve conflicts by merging main in, never rewriting history.
- Agents in parallel worktrees: give each its own scratch directory (the shared one caused a backup collision) and tell them to skip `scripts/grader-sensitivity.test.mjs` locally (fixed port 8901); CI runs it.
- Every wiring change: default-off equivalence test, a real-path test with the flag on, a negative control per rule.
- Quote interpolated paths in any command template a test executes (PR #56 was the spaced-checkout lesson).
- Never redeploy a teploy app from a hand-copied or stripped teploy.yml — deploy from the repo that owns the full one, or you fight the original deployment's shape (the 2026-10-04 gateway incident: ad-hoc deploy from a stripped yml removed the running container; restored by redeploying the exact revision from the real repo with no data loss, but it did not need to happen).
- Production changes: coordinated stop + verified backup first (scripts/ship-backup.sh), waiting runs must survive, gateway is a separate app and stays up.

Before finishing any slice: `pnpm run lint`, `pnpm test`, and for `web/` changes `cd web && pnpm test && pnpm run build`. Install `web` dependencies first (`cd web && pnpm install --frozen-lockfile`) or the deployment-pin script test fails for an environmental reason.
