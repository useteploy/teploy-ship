# SWE-bench Lite 50-instance run, GLM 5.2 — scored 2026-08-15

First real aggregate number for teploy-agent. Inference ran 2026-08-12 (4.8 h,
zero cost, via z.ai's Anthropic-compatible coding-plan endpoint); scoring ran
2026-08-15 with the **official evaluator** (`swebench.harness.run_evaluation`,
v4.1.0) on infra-home.

Predictions: `swebench/preds-glm52-50.json`
Reports: `swebench/report-glm52-50.json`, `swebench/report-goldcheck-failures.json`

## Result

**22 / 50 resolved = 44.0%**

```
submitted           50
completed           37
resolved            22
unresolved          15
empty patch         12     automatic zeros — never reached the evaluator
error                1     sphinx-doc__sphinx-8273
```

Instance set is the seeded 50-instance sample from `make-sample.mjs`, a subset
of Lite's 300.

## Gold validation

All 16 failures (15 unresolved + 1 error) were re-run with the **gold patch** to
separate a real miss from a broken environment. 15 of 16 resolved on gold, so
the environment is sound and those failures are genuine.

The one exception is **`psf__requests-863`, which fails its own gold patch** —
it is unscoreable here, exactly as recorded when it was swapped out of the
3-instance gauge in July. Excluding it as unscoreable gives **22/49 = 44.9%**.
The official 44.0% is the number to quote; this is the honest ceiling of the
same data.

`sphinx-doc__sphinx-8273` errored during our run but resolves on gold, so it is
a real failure, not an environment fault.

## Honest caveats — read before quoting any of this

1. **This is Ship + GLM 5.2, not Ship.** Harness quality and model quality are
   not separated. A paid sonnet-5 run on the same 50 is the control, and it is
   deliberately deferred until the mechanical fixes below land.
2. **n=50 out of 300.** The 95% confidence interval on 44% at n=50 is roughly
   **30–58%**. Treat this as "somewhere in the low-to-mid forties", not as
   44.0%. Comparing it to a full-300 leaderboard figure is not like-for-like.
3. **24% of runs scored zero by construction.** 12 instances produced an empty
   patch — those are not failures of reasoning, they are a harness defect. The
   headline number is depressed by a bug, not only by model capability.
4. **56% hit the step cap** (`maxSteps: 40`, `run-inference.mjs:152`). OpenHands
   runs this benchmark at ~100. Most runs were cut off mid-work.
5. **The harness runs a barer loop than the shipped product** — no code index,
   no critic. This is not the product's number.

For rough context, OpenHands CodeAct 2.1 reports 125/300 = 41.7% on the full
Lite. Different model, different sample, no controls — directional only.

## What this changes

The two cheapest fixes (never end with an empty patch; raise the step cap) both
attack the largest measured losses, and neither needs model work. Fix them **one
at a time** — the current numbers are a clean baseline and changing both at once
destroys attribution.

## Reproducing

Scoring host was infra-home (29 GB RAM, 422 GB free). deploy-test is unsuitable:
3 GB RAM total with ship, nucleus and ollama resident — the test suites thrash
and risk the OOM killer taking a neighbour.

```
python3 -m venv /root/swebench-venv          # needs python3.13-venv on Debian
/root/swebench-venv/bin/pip install swebench==4.1.0

/root/swebench-venv/bin/python -m swebench.harness.run_evaluation \
  -p /root/preds-glm52-50.json --max_workers 2 -id glm52-50 \
  --cache_level env --clean True
```

`--cache_level env --clean True` keeps the per-repo env images and drops
instance images as it goes; the full run stayed under ~7 GB of image growth.
Gold-validate a failure set with `-p gold -i <ids...>`.
