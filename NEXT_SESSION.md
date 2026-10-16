# Next session

Start with [docs/DECISIONS_OPEN_2026-10-04.md](docs/DECISIONS_OPEN_2026-10-04.md) (everything already decided, plus open Decisions 4–10 from the programme's E6), then this file. The single forward plan is [docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md](docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md); status lists live in its execution tables plus [AUDIT_OPEN.md](AUDIT_OPEN.md) wave-5 section. Update those rather than creating another plan.

## Where things stand (2026-10-16, end of the perception programme)

Production ship web+worker run `03748ab` (store: postgres). The S12/S13
perception programme is BUILT, SOAKED, and ON: `SHIP_LOOK=1` and
`SHIP_LOOK_IMAGE_MODEL=zai/glm-5.3-flash` live since the 2026-10-16 soak
(`evals/receipts/2026-10-16-look-soak.txt` — PASS; text looks + one image
look through flash, ~$0.05, zero unexpected refusals, approve-merge park
worked). The initial admin bootstrap ran on production ("Tyler" — the
postgres KV claim path's first live exercise). Gate 0 decision recorded
2026-10-15 (flash for screenshots; DECISIONS_OPEN).

Landed this wave (all default-off flags, equivalence-pinned, receipts
under evals/receipts/2026-10-1[456]-*): `look` text-first a11y perception
(#76), D3 open-tier rule + injection fencing + the grader-authored
browser-required journey `pj-d-live-board` (#77), image mode with
artifacts/flash routing/caps/pruning + the never-on-PR class guard (#78),
opencode >= 2.0.0 preflight guard (#79), steering thread view
`SHIP_THREAD_VIEW` (#80), class-aware admission/resource classes (#81),
delegation coordinator `SHIP_DELEGATE` (1 level, cap 2, context transfers;
COORDINATOR_DESIGN.md) (#82), admin bootstrap (#84), plus the soak (#83).

Next work: the programme's **End state and execution backlog** section
(E0–E6, 2026-10-16) is the single ordered queue — start at **E5 wave 6**
(A0 backup fix, A1 `SHIP_THREAD_VIEW=on` soak, A2 shadow review, B6, C1,
X11, G1 task capture; code lanes D1 MCP client, D2 two-way steering, D3
follow-up continuity, X7). Owner decisions it needs are Decisions 4–10 (E6). The ordered
lists that used to live here are folded into it.

Standing follow-ups: `scripts/ship-backup.sh` now handles the postgres store
(A0: online `pg_dump` + manifest row counts + scratch-container rehearsal,
`--cold` for the pgdata tar — docs/BACKUP.md); its first LIVE run + rehearsal
on infra-home is still owed (A0's exit receipt); the soak runbook's stale known-good answers are corrected
in the receipt; `SHIP_THREAD_VIEW`/`SHIP_DELEGATE` are merged but NOT yet
enabled in production (each earns its own one-run flip, the soak's
pattern); deploy prerequisite reminder — rerun `pnpm run build` + web
build before EVERY `teploy deploy` (a stale dist shipped the bootstrap's
first deploy inert; caught by its no-half-apply refusal, 2026-10-16).

Landed in wave 5, 2026-10-04 (history; all on green CI):
- **S02 batch executed** (A only, coding-plan key, $0 real): 24/33 recorded, effectively 27/33 after the grader fix — see [evals/product-journeys/BATCH_2026-10-04.md](evals/product-journeys/BATCH_2026-10-04.md).
- **Grader extraction defect fixed** (#61): the pj-s-question batch failures were layout-brittleness, not model variance; supplementary regrades PASS; matrix regenerated 61/61 + 13/13.
- **Retained runs re-graded** (#58): current graders flip nothing on substance; only publication-evidence preservation gaps.
- **S03** (#60): migration 008 + rehearsal on the restored real-store copy (receipt in `evals/receipts/`); write path stays future work.
- **S07** (#59): plan-grounding at the plan park, advisory, `SHIP_PLAN_GROUNDING` off.
- **S08** (#63): findings in PR body + webhook, `SHIP_TEST_INTEGRITY_SURFACING=off|shadow|on`, off.
- **S19** (#64): `teploy-ship snapshot` / `restore-check`, doctor store+clock probes, support bundle v2.
- **Routing policy live in shadow** (#65 mount + host file `/srv/ship-config/routing-policy.json`): destination gate cleared via `SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai`; the retention gate still refuses private data honestly — see DECISIONS_OPEN item 1.

## Next work, in order

See the programme's E5 waves. Status of the former list: the z.ai retention
stance was decided 2026-10-05 (keep the refusal; DECISIONS_OPEN) and is now
Decision 9 / Q9; S27 and S01 live proofs are A9 and A8; the shadow review
is A2; the wave-2 code lanes are L3, X2, X3/X4 (S15/S17), X5, and the rest of S07 is A5 (plan grounding) plus Q1 (critique) — no further S07 slice is scheduled; S12/D07 was decided
2026-10-05 (keep the harness); the S02 B leg is Q7.

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
