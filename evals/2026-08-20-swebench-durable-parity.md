# The product loop, measured — SWE-bench Lite, 2026-08-20

**Result: `durableAgent` resolves 30 of 49 = 61.2%.** Every number Ship had
published before this described `runAgent`, the live loop. This one describes
`durable.ts` — the webhook -> intake -> worker -> PR path that `worker.ts`
drives, i.e. the thing the product actually runs. That was P0-1/P0-2.

| | resolved | 95% CI |
|---|---|---|
| **durable, parity arm** | **30/49 = 61.2%** | 47–74% |
| live baseline, same 49 instances | 34/49 = 69.4% | 55–80% |
| live baseline, as published (2026-08-16) | 35/50 = 70.0% | 56–81% |

Config: `SHIP_DURABLE=1 SHIP_CRITIC=1`, `glm-5.3`, thinking 32768, step cap 40,
code index OFF, same seeded 50-instance sample, official evaluator
(`swebench.harness.run_evaluation`, swebench 4.1.0). Predictions at
`swebench/preds-durable-parity-50.json`, per-instance process metrics at
`swebench/preds-durable-parity-50.runlog.jsonl`.

## Is the product loop worse?

**Nominally by 8 points, and this sample cannot tell whether that is real.**

Head to head on the identical 49 instances, durable **gained 4 and lost 8**:

```
gained: matplotlib-25332  scikit-learn-10508  sympy-16281  sympy-17655
lost  : django-11283  django-12125  django-15819  django-16400
        pylint-7228  pytest-7220  scikit-learn-25638  sympy-19487
```

Twelve discordant pairs, **McNemar exact two-sided p = 0.388**. The confidence
intervals overlap across most of their width.

Both halves of that matter and neither survives alone:

- **You cannot claim the loops are equivalent.** p = 0.388 is not evidence of
  no difference; with 12 discordant pairs the test has little power, and a real
  8-point gap is entirely compatible with this data. Ruling it out needs more
  instances, not a louder reading of these.
- **You cannot claim a regression either**, and nobody should publish 70% as
  the product's number. The product measured 61%.

The honest sentence is: *the durable loop resolved 30 of 49 (61.2%, 95% CI
47–74%); the live loop resolved 34 of the same 49; the difference is not
statistically distinguishable at this sample size.*

## What the parity arm cost

The arm forces `recovery` and `requireEdit` on so the LOOP is the only variable
against the baseline. Both change how runs end, and it shows:

| | live | durable parity |
|---|---|---|
| finished deliberately | 23 | **15** |
| hit the step cap | 12 | **20** |
| thrash-abort / stuck | 15 | 14 |
| empty patches | 4 | **6** |
| median steps | 33.5 | **40** (the cap) |
| median minutes | 6.1 | **9.4** |
| total wall-clock | 7.1 h | **9.2 h** |

Eight deliberate finishes became cap-outs. That is exactly what holding a
finish over an unchanged tree predicts, and it costs **30% more wall-clock per
instance**. The stuck/abort category is unchanged (15 -> 14) — the same
mechanism under two names.

## What did NOT explain the difference

- **Not parking.** `parked: false` on all 49; `autoApprove` held.
- **Not step failures.** `failedSteps: 0` across the sweep.
- **Not the critic misfiring.** It ran on exactly the 15 runs that attempted a
  finish and on no others — the designed correspondence, confirmed live.
- **Not lost work.** All 6 empty patches have `everEdited: false`: the agent
  never wrote to the tree, so there was nothing to preserve. Same finding as
  2026-08-16.
- **Not the kernel.** `durable.ts` has had the persistent kernel since
  `eb3ecab`; two planning docs claimed otherwise and were corrected on
  2026-08-18. **Do not read 61% as evidence of a kernel gap that never existed.**

Resolution rate by exit status is flat enough to be uninformative at this n:
finished 10/15 (67%), max-steps 11/20 (55%), stuck 9/14 (64%). A run that hits
the cap still resolves more than half the time, which is why the harness
publishes off a max-steps exit.

## Scoring integrity — read this before trusting any re-run

**The evaluator died without writing its report.** Tailscale MagicDNS on
infra-home stopped resolving external names mid-run (`pypi.org`,
`raw.githubusercontent.com`, `registry-1.docker.io` all failed), and the
resulting urllib3 exceptions took the process down after all 43 instances had
been dispatched. This is the **same failure as 2026-08-16**, which that writeup
documents and warns about.

Two things saved the run:

1. **SWE-bench caches per-instance `report.json` under
   `logs/run_evaluation/<run-id>/<model>/<instance>/`.** The score was
   reconstructed from those. The method was validated by reconstructing the
   LIVE baseline the same way: it came back 35/50, matching the published
   figure exactly.
2. **The 4 errored instances were all `sympy`** — errors clustered by repo,
   which the 2026-08-16 writeup names as the signature of an infrastructure
   failure rather than a model failure. Re-run with DNS working they produced
   **zero errors**, and 1 of the 4 resolved. Reporting the first pass would
   have published 29/49 with four false zeros.

DNS recovered on its own; an edit to `/etc/resolv.conf` was reverted by
`tailscaled` within milliseconds, so it cannot be credited with the fix and
nothing on that box was left modified.

**Check `error_instances` — or the count of missing `report.json` files —
before believing any score from this box.**

## What this does not cover

- **The code index arm.** Off. Its prerequisites are all in place and verified
  (nomic-embed-text pulled, gateway token valid, 768-dim embeddings, scratch
  Nucleus healthy), but the `repo-index` step spent ~3 minutes on
  scikit-learn-13779 and died with a connection timeout against the forwarded
  engine, and the harness aborted on the first instance by design. Measure it
  separately.
- **`sphinx-doc__sphinx-8627`**, skipped on an image-pull 404. 49 instances, not
  50. The comparison above puts the live arm on the same 49.
- **The product arm** (`SHIP_DURABLE=product`), which runs enqueueRun's own
  defaults rather than parity-forced ones. Not run. It answers a different
  question and is not comparable to 35/50 term by term.
- **Cost.** The runlog's `costCeilingUSD` sums to $125.49 and is fiction: it is
  `costUSD` pricing an unpriced model at the highest known rate so a spend cap
  cannot fail open. The z.ai coding plan is free. `priced: false` on every row.
