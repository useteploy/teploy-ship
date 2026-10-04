# Next session

Start with [docs/DECISIONS_OPEN_2026-10-04.md](docs/DECISIONS_OPEN_2026-10-04.md) (the two open founder calls and everything already decided), then this file. The single forward plan is [docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md](docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md); status lists live in its execution tables plus [AUDIT_OPEN.md](AUDIT_OPEN.md) wave-5 section. Update those rather than creating another plan.

## Where things stand (2026-10-04, end of wave 5)

Production ship web+worker run `acca080` (all wave-5 code merged #58-#66; gateway `c0b07dd`; six shadow flags live). The five waiting runs have survived every deploy. Backups: `pre-80c9187-shadow-deploy-2026-10-04` and `pre-acca080-wave5-2026-10-04`, both verified.

Landed this wave (all on green CI):
- **S02 batch executed** (A only, coding-plan key, $0 real): 24/33 recorded, effectively 27/33 after the grader fix — see [evals/product-journeys/BATCH_2026-10-04.md](evals/product-journeys/BATCH_2026-10-04.md).
- **Grader extraction defect fixed** (#61): the pj-s-question batch failures were layout-brittleness, not model variance; supplementary regrades PASS; matrix regenerated 61/61 + 13/13.
- **Retained runs re-graded** (#58): current graders flip nothing on substance; only publication-evidence preservation gaps.
- **S03** (#60): migration 008 + rehearsal on the restored real-store copy (receipt in `evals/receipts/`); write path stays future work.
- **S07** (#59): plan-grounding at the plan park, advisory, `SHIP_PLAN_GROUNDING` off.
- **S08** (#63): findings in PR body + webhook, `SHIP_TEST_INTEGRITY_SURFACING=off|shadow|on`, off.
- **S19** (#64): `teploy-ship snapshot` / `restore-check`, doctor store+clock probes, support bundle v2.
- **Routing policy live in shadow** (#65 mount + host file `/srv/ship-config/routing-policy.json`): destination gate cleared via `SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai`; the retention gate still refuses private data honestly — see DECISIONS_OPEN item 1.

## Next work, in order

1. **The z.ai terms lookup + retention stance** (DECISIONS_OPEN item 1) — a fact, then a one-line policy edit on infra-home; no image rebuild needed (the mount exists for this).
2. **S27 live proof**: real TeployAdapter deploy against a scratch target (`SHIP_DEPLOY_ADAPTER=teploy`, off; needs a scratch destination provisioned — compute-1 is the sandbox host).
3. **S01 live proof**: `SHIP_GIT_CREDENTIAL=env` on a real sandbox + private repo (daemon env forwarding, sandbox git >= 2.31, live proof on Forgejo+GitHub, then default-flip).
4. **Shadow soak + review** (days of calendar time): placement/policy/budget/tool-manifest/knowledge-provenance JSONL + `placement shadow-report` / `policy shadow-report`; routing shadow selections in worker logs. No `on` flips before review.
5. **Wave-2 code lanes** (delegate as wave 5 was): S10 follow-ups (offline/error states, other roles, screen readers), S04 preview isolation (teploy-cli repo — the AUDIT_OPEN mitigation proposal), rest of S07, S18 worker tree provisioning, S15/S17 wiring.
6. **S12/D07**: owner call first (DECISIONS_OPEN item 2).
7. **B-leg** of the S02 comparison: owner-gated real API spend.

## Working rules that paid off

- One branch and PR per slice; merge only on green CI, pinned to the checked head; resolve conflicts by merging main in, never rewriting history (the S19 lane's triple conflict was resolved this way).
- Parallel agents in isolated worktrees: own scratch dir each, skip `scripts/grader-sensitivity.test.mjs` locally (fixed port 8901); CI runs it. Give each lane the full spec in its prompt — truncated reports are cosmetic, verify by PR contents + CI.
- Every wiring change: default-off equivalence test, a real-path test with the flag on, a negative control per rule.
- Quote interpolated paths in command templates (PR #56).
- Never redeploy from a stripped teploy.yml — deploy from the repo that owns the full one (the gateway incident, recorded in AUDIT_OPEN).
- Production changes: coordinated stop + verified backup (`scripts/ship-backup.sh`), waiting runs must survive (audit states: 164 completed / 25 failed / 6 cancelled / 5 waiting), gateway stays up.
- Env changes need a teploy redeploy to take effect (container env is baked at create; `docker restart` reuses it).
- GitHub PR CI events occasionally dropped for lane-pushed branches this wave — a fresh push to the branch (merge main in) reliably re-fired it.

Before finishing any slice: `pnpm run lint`, `pnpm test`, and for `web/` changes `cd web && pnpm test && pnpm run build`. Install `web` dependencies first (`cd web && pnpm install --frozen-lockfile`).
