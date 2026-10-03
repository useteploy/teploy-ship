# Next session

The single forward plan is [docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md](docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md); its **Execution status** section is the only status list. Open audit items and deferred findings live in [AUDIT_OPEN.md](AUDIT_OPEN.md). Update both rather than creating another plan.

Suggested next slices, in order, each with its own small specification in the programme before implementation:

1. First-batch item 3 (S03): map existing run/intake/follow-up records to the task/requirements/acceptance contract and rehearse the additive migration on a restored copy.
2. First-batch item 2 (S02): deterministic preflight and canary, then propose the bounded model batch for authorisation.
3. S28: wire `runTiming` (`src/run-timing.ts`) into an authorised surface.
4. S01: credential mediation (needs Sandbox `env` support and a live proof) and the teploy-cli preview network change.

Before finishing any slice: `pnpm run lint`, `pnpm test`, and for `web/` changes `cd web && pnpm test && pnpm run build`. Install `web` dependencies first (`cd web && pnpm install --frozen-lockfile`) or the deployment-pin script test fails for an environmental reason.
