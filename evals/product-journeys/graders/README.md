# Graders

Acceptance graders for the product-journey scenarios. They verify claims
against the fixture's OWN tests plus independent assertions (probes,
behavioral checks, structural diffs) — never against the agent's summary.

## The contract

One file per scenario id, named `<scenario-id>.mjs` (see `../manifest.json`),
plus this shared `lib.mjs`. Each grader exports exactly:

```js
export async function grade({ workDir, fixture, scenario }) {
  return { pass: boolean, reasons: string[], evidence: object[] };
}
```

- `workDir` — absolute path to the evaluated checkout (the agent's result).
- `fixture` — absolute path to the pristine fixture for the family.
- `scenario` — the scenario object from `manifest.json`.

Rules:

1. **No grader passes on checks it cannot actually perform.** Checks that
   need run transcripts (PR behavior, review text, citations) are reported
   as `not-wired:` reasons until execution wiring exists. Until then, any
   grader with a not-wired check returns `pass: false` — deliberately.
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
