# Next session

The single forward plan is [docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md](docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md); its **Execution status** section (the wave-2, wave-3 and wave-4 tables) is the only status list. Open audit items and deferred findings live in [AUDIT_OPEN.md](AUDIT_OPEN.md). Update both rather than creating another plan.

## Where things stand (2026-10-04)

Everything below is **implemented and checked by automated tests only**. No row has a verified outcome: no live Ship, Nucleus, sandbox, forge, preview target or model gateway was reachable, and nothing was spent. Most wave-2 modules are tested but not called by any route or worker; waves 3 and 4 wired many of them behind flags that are **off by default** (or observe-only), so default behaviour is unchanged.

## Needs a human decision first

1. **Paid evaluation batch** (S02, propose-only): 66 runs, hard cap $25, details in the programme's S02 slice. It must run from somewhere that can reach a Ship instance. The graders were tightened in PR #34, so the retained results were scored under looser graders and were not re-graded.
2. S28 percentile threshold (n>=20) was an agent's choice.
3. S25 service-account role (shadow treats service accounts as id-only matches).
4. Whether S08 test-integrity findings should reach the PR body and webhook (would change the worker path).
5. The 79 sub-24px compact targets from the UI audit (keep or enlarge).
6. File the upstream reports: Neutron plain-text 404 page (`docs/UI_AUDIT_2026-10-03.md`), and the Teploy CLI feature requests in `AUDIT_OPEN.md`. Nothing has been filed.
7. When each wired flag should be turned on (shadow first, read the logs).

## Needs live systems or the owner's side

S01 credential proofs on a real sandbox with a private repo; preview isolation (teploy-cli); end-to-end journeys; real-Nucleus checks; the S03 storage migration rehearsal on a restored copy; real deployment adapters; real placement targets; human observation of dashboard users; re-grading retained runs where their trees exist; shadow-log review before enabling any flag.

## Safe next work (no live system needed)

- Turn shadow findings into decisions once logs exist; otherwise wire the remaining pure modules (S15/S17 into delivery and incidents, S07 into the plan-park point without adding a durable step, S19 snapshot producer and restore-check command, S18 worker wiring).
- The untouched or barely started packages: S04, S12, S10 follow-ups (offline and error states, other roles), remaining S07 parts.
- Add `./plan-grounding`, `./deployment-adapter`, `./policy-inheritance`, `./tool-manifest` and `./teploy-adapter` subpath exports only when something imports them.

## Working rules that paid off

- One branch and PR per slice; merge only on green CI, pinned to the checked head; resolve conflicts by merging main in, never rewriting history.
- Agents in parallel worktrees: give each its own scratch directory (the shared one caused a backup collision) and tell them to skip `scripts/grader-sensitivity.test.mjs` locally (fixed port 8901); CI runs it.
- Every wiring change: default-off equivalence test, a real-path test with the flag on, a negative control per rule.

Before finishing any slice: `pnpm run lint`, `pnpm test`, and for `web/` changes `cd web && pnpm test && pnpm run build`. Install `web` dependencies first (`cd web && pnpm install --frozen-lockfile`) or the deployment-pin script test fails for an environmental reason.
