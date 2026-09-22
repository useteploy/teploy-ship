# Graders

Acceptance graders for the product-journey scenarios. They verify claims
against the fixture's OWN tests plus independent assertions (probes,
behavioral checks, structural diffs) — never against the agent's summary.

## The contract

One file per scenario id, named `<scenario-id>.mjs` (see `../manifest.json`),
plus this shared `lib.mjs`. Each grader exports exactly:

```js
export async function grade({ workDir, fixture, scenario, transcriptPath, summary }) {
  return { pass: boolean, reasons: string[], evidence: object[] };
}
```

- `workDir` — absolute path to the evaluated checkout (the agent's result).
- `fixture` — absolute path to the pristine fixture for the family.
- `scenario` — the scenario object from `manifest.json`.
- `transcriptPath` — absolute path to the run transcript, when the runner
  executed the scenario through an adapter (null for direct grader
  development calls).
- `summary` — the adapter-reported summary object (e.g. `{prOpened: false}`).

Rules:

1. **No grader passes on checks it cannot actually perform.** Checks the
   grader cannot verify with what it was given are reported as `not-wired:`
   reasons and force `pass: false` — deliberately. Execution wiring now
   exists (`pj-s-question` verifies transcript citations against the
   pristine fixture); transcript-dependent checks in other graders (PR
   behavior, review text) stay `not-wired` until they are wired the same
   way, with tests.
2. **Structural and behavioral checks are real today.** Graders boot the
   worked tree's own server, probe HTTP, run the fixture's shipped tests,
   build pre-existing databases, inject fake dependency modules and diff
   snapshots against the pristine fixture.
3. **Negative-control property:** every grader whose scenario requires a
   change MUST fail when pointed at the pristine fixture. The two seeded
   traps (`pj-b-api-defect`, `pj-c-review`) additionally verify the grader
   rejects correct-looking wrong answers (a 400 that greens the sloppy
   shipped test; an approving review of a README-aligned but wrong patch).
4. Graders import only the Node standard library and `./lib.mjs`, so the
   directory can be copied anywhere and still work.

## Out-of-tree grading (REQUIRED for real baselines)

The evaluated agent must never be able to read or edit its grader. Before
any real baseline run, copy this directory out of the agent-writable
checkout and point the runner at the copy:

```sh
cp -r evals/product-journeys/graders /secure/location/journey-graders
node scripts/eval-journeys.mjs --scenario pj-s-copy \
  --grader-dir /secure/location/journey-graders --i-authorize-spend
```

`--grader-dir` must be an absolute path. The runner's default is the
repo-relative `evals/product-journeys/graders/`, which is fine for
`--dry-run`, `--manifest` and local grader development, and wrong for any
run against a real agent checkout — the agent could read the acceptance
criteria and the probes.
