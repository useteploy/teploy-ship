# SWE-bench Lite 50-instance run, GLM 5.3 — scored 2026-08-16

**35 / 50 resolved = 70.0%**, official evaluator (`swebench.harness.run_evaluation`
v4.1.0). Up from 22/50 (44.0%) on GLM 5.2 the day before.

Predictions `swebench/preds-glm53-50.json` · diagnostics
`swebench/preds-glm53-50.runlog.jsonl` · reports `swebench/report-glm53-50.json`,
`swebench/report-glm53-goldcheck.json`

```
resolved     35        70.0%
unresolved   11
empty patch   4
error         0
```

Same seeded 50-instance sample as the 5.2 run, so the instance set is
controlled. Config: `glm-5.3`, thinking budget 32768, step cap **left at 40**,
image pruning on. 7.1 h wall (vs 4.8 h at 5.2 — the thinking budget).

## Gold validation

The 11 unresolved were re-run with the gold patch: **10 of 11 resolve**, so they
are real misses. The exception is `psf__requests-863`, which fails its own gold
patch — unscoreable in this environment, and the third consecutive run to find
that (it was dropped from the July 3-instance gauge for the same reason).

Excluding it: **35/49 = 71.4%**. Quote 70.0%.

## What actually changed — read this before crediting anything

**The harness fix contributed nothing measurable.** The 2026-08-15 `putFile`
snapshot fix (`49ff40b`) rescued **0 of 50** instances — `recovered` is false on
every row of the runlog, and all four remaining empty patches have
`everEdited: false`, meaning the agent never wrote to the tree at all. There was
nothing for the safety net to preserve. The hole it closes is real and
test-covered, but it is **latent, not load-bearing**, and it is not what moved
this number.

**Attribution to the model is also imperfect**, because z.ai retired `glm-5.2`
between the two runs — every 5.x id now serves 5.3, so a controlled re-run of
the old baseline is impossible. This run changed model *and* thinking budget
(4096 → 32768) *and* carried the harness fix. The honest statement is: **the
combination scores 70%**; the split between 5.3 and the larger thinking budget
is unmeasured.

## Process metrics

| metric | 5.2 baseline | 5.3 |
|---|---|---|
| empty patches | 12/50 — 24% | **4/50 — 8%** |
| hit the 40-step cap | 28/50 — 56% | 12/50 — 24% |
| thrash-abort | 5/50 — 10% | **15/50 — 30%** |
| finished deliberately | 18/50 — 36% | 23/50 — 46% |
| scoreable (non-empty) | 38/50 — 76% | **46/50 — 92%** |

**The bottleneck moved.** Cap-outs more than halved while thrash-aborts tripled.
Median steps is 33.5 against a cap of 40, so most runs no longer die of running
out of room — they die of not stopping: *"the agent kept running commands
without changing anything after repeated nudges"*. 10 of the 15 aborts still
carried a usable patch, which is why the score held up.

Consequences for the roadmap:

- **Task 3 (raise the cap to 100) is now worth less than the 5.2 data implied.**
  Only 24% hit the cap, and the median run stops well short of it.
- **Task 4 (termination) is now the largest single failure mode at 30%**, and is
  the item most likely to buy the next real gain.

## Integrity checks

A 26-point jump deserves scrutiny. Checked before publishing:

- **0 of 50 patches touch a test file or `conftest.py`** — the "do not edit
  tests" instruction held, so the score is not gamed by weakening assertions.
- 64 files touched across 50 patches (mean 1.3); **no patch touches more than 3
  files**. These are focused fixes, not shotgun edits.
- No `.teploy-agent` kernel scratch leaked into any patch.

## Caveats — read before quoting

1. **n=50 of 300.** The 95% CI at 70% is roughly **57–81%**. This is "around
   seventy", not 70.0%, and it is not comparable to a full-300 leaderboard entry.
2. **Ship + GLM 5.3, not Ship.** No model control has been run. A paid sonnet-5
   run on the same 50 is still the missing comparison.
3. **The harness still runs a barer loop than the product** — no code index, no
   critic. This is not the product's number.

## Scoring gotcha that cost a re-run

The first scoring pass reported 17/50 with **25 error instances**. Those were not
failures: Tailscale MagicDNS on infra-home (`fd7a:115c:a1e0::53`) was failing to
resolve `registry-1.docker.io`, so 25 instances never pulled an image and never
ran. Re-running exactly those 25 completed 25/25 with zero errors, and the two
passes merge to 35/50.

It hit this run and not the last because inference ran with
`SWEBENCH_PRUNE_IMAGES=1`, deleting every instance image, so the evaluator had to
re-pull all 46 and a transient DNS wobble became 25 failures.

**If a scoring pass reports a suspicious number, check `error_instances` before
believing it** — and check whether the errors cluster by repo, which is the
signature of an image-pull failure rather than a model failure.

infra-home's only resolvers are `100.100.100.100` and the Tailscale IPv6 one,
with no public fallback, so any MagicDNS hiccup breaks every pull on that box.
`resolv.conf` there is Tailscale-managed; a fallback resolver would remove this
class of failure.
