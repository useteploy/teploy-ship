# Capacity — what one worker box can carry

Measured 2026-08-25 on a named 4 vCPU / 4 GB VM, under real load, with the
ledger checked for every run. Nothing here is projected from a unit test;
where a number is a projection it says so.

## The hardware

| | |
|---|---|
| host | `deploy-test`, QEMU virtual CPU (2.5+), **4 vCPU**, 1 thread/core |
| memory | **3.8 GiB** RAM, 4.1 GiB swap |
| disk | 75 GB (54 GB used at the time), one partition |
| kernel / docker | Linux 6.12 (Debian 13), Docker 29.6.1 (API 1.55) |
| co-tenants | teploy-gateway (512 MB cap) + its ollama accessory (1 GB cap), a Forgejo runner, Caddy |
| ship | one image, `ship-web` + `ship-worker` at 1 GB cap each; Nucleus v0.1.8 at a **1500 MB** cgroup cap (`NUCLEUS_MAX_MEMORY_MB=1024`) |
| sandbox | `teploy-sandbox` daemon on the host, `golang:1.24` per run, egress network |
| idle footprint | ~1.3 GB used, load ~1 — the whole stack, before any run |

The worker process itself is not the resource: it sat at **24–47 MB and under
1 CPU** throughout. The cost of a run is the **sandbox container** it spawns
(clone, embeddings, `go test`, push) and the model round-trips it waits on.

## Method

- Throwaway private repo `Tyler/ship-load-test` on Forgejo: a one-function Go
  module with a passing test, a README, a notes file. Default evidence config
  (`go test ./...`), code index on, telemetry leg on (no data to compare, so it
  records "not enough data"), native harness, `anthropic/claude-sonnet-5`
  through teploy-gateway.
- Five one-line tasks rotated ("add a line under the Notes heading",
  "append a sentence to NOTES.md", "add a doc-comment line", "create
  CHANGELOG.md with one line", "create .gitattributes"). Every run opens a real
  pull request. Tasks were enqueued with `teploy-ship enqueue` in a burst, so
  the queue was full from second zero.
- The ceiling is `SHIP_MAX_CONCURRENT_RUNS` on the worker, changed with
  `teploy secret set` and a redeploy between batches.
- Sampled every 5 s: load average, memory, per-container CPU/memory
  (`docker stats`), live sandbox containers. Per-run timing comes from the
  event log (`run-started` → first step = queue wait; first step → terminal
  event = execution). Concurrency is reconstructed from the worker's own
  `picked up` / `→ completed` lines, not inferred.
- After every batch: the source ledger, the repo and actor attribution rows,
  and the sum of the per-run costs in `audit --format json` were compared.

## Results

| batch | ceiling (configured) | in flight (measured) | runs | completed | span | throughput | exec median / p90 | queue wait median / max | load1 max (mean) | mem used max | nucleus RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 2 | 10 | 10 | 6m 0s | **1.67 /min** | 57 s / 96 s | 158 s / 294 s | 6.9 (3.5) | 2.0 GB | 252 MB |
| 2 | 4 (pre-fix) | **2–3** | 25 | 25 | 12m 23s | 2.02 /min | 60 s / 73 s | 353 s / 684 s | 10.2 (5.3) | 1.8 GB | 257 MB |
| 3 | 4 (fixed) | **4** | 10 | 10 | 3m 1s | **3.32 /min** | 57 s / 68 s | 59 s / 114 s | 17.9 (10.5) | 2.1 GB | 257 MB |

Every run completed; none failed, none stuck, none double-settled (the
`ship:done:<runId>` claim held — 45 terminal outcomes, 45 claims). Selfwatch
raised nothing during the batches. Execution time per run **did not move**
between 2 and 4 in flight (57 s → 57 s median): at this size the run is bound
by model latency, not by the box, so throughput scaled linearly with the
ceiling once the ceiling was real. Queue wait is what the ceiling buys you.

**Backpressure, observed:** with 25 queued against a ceiling of 4, the live
sandbox count sat at the ceiling for 13 of 14 samples while the rest waited
in the index as `wake` and launched the moment a slot freed. Nothing was
dropped: 25 in, 25 pull requests out.

### What the load found (both fixed)

1. **The configured ceiling was about half real.** `launchDueBounded` summed
   `inflight.size + launching.size`, but an executing run is in both sets for
   its whole life, so it counted twice. Batch 2 — ceiling 4 — never held more
   than 3 runs and spent 570 s of its 743 s at 2. The unit test never put a run
   in both sets, which is the kind of mock-encodes-the-wrong-semantics gap this
   codebase already has a rule about. Fixed in `f0c6ac3` (count the union; a
   test that models the real membership); batch 3 held 4.
2. **One settlement out of 45 was lost.** `run-545ae7ee` completed, won its
   terminal claim, then the `loadMeta` read hit a transient pool rejection
   (`pg-pool` rejecting with `undefined`, surfacing as "Cannot read properties
   of undefined (reading 'name')" — the intermittent tick error noted on
   2026-08-24). The settle threw, the claim stayed taken, the run was no longer
   due: **$0.0278 in the audit export, absent from the budget ledger**, and the
   only trace was one log line. Fixed in `ef8bc97`: the settle's reads and
   ledger write retry (4 tries, 500 ms doubling), and a settle that still fails
   releases its own claim and says so, so the state reads as unsettled rather
   than done. That one run's cost remains outside the ledger on deploy-test —
   the artefact is left in place deliberately, like the 2026-08-24 double-settle.

The pool is `max: 4` connections (`src/nucleus-pgwire.ts`). Under a ceiling of
4 it was not observed to be the limiter, but it is the next suspect at 8 and
the retry above is what makes a transient there survivable.

## Cost

45 runs, **$1.37** by the audit export ($1.35 in the ledger — the gap is the
lost settlement above), so **~$0.03 per trivial run** on Sonnet 5 with the
index and evidence legs on. A real task costs whatever its turns cost; the
capacity figure is independent of that because execution is latency-bound.

## The recommendation

**On a 4 vCPU / 4 GB box, run `SHIP_MAX_CONCURRENT_RUNS=4`.** Measured:
3.3 runs/min on one-turn tasks, ~60 s per run, ~2.1 GB used, Nucleus flat at
~260 MB. Load average 18 on 4 cores is oversubscribed on paper, but the runs
are waiting on the model and did not slow down; what you would feel first is
memory.

Do not go to 8 on this box. Not measured (budget), so a projection, and
labelled as one: each in-flight run costs roughly **350–400 MB** of host memory
(the batch-1 delta from an idle 1.3 GB to 2.0 GB at 2 in flight; 2.1 GB at 4
with page cache absorbing some of it), which puts 8 at ~4 GB on a 3.8 GB box —
swap, then the OOM killer choosing between a sandbox, Nucleus and the gateway.
The default of 3 is a safe setting for this class of box, not the ceiling.

### Rule of thumb for a larger box

```
ceiling = min( vCPUs,  floor((RAM_GB - 1.5) / 0.4) )
```

- **1.5 GB** is the stack's base (web + worker + Nucleus + gateway + ollama),
  and Nucleus grows with run history, so revisit after a month.
- **0.4 GB per run** is the sandbox with a small Go/Node repo cloned, indexed
  and tested. A repo whose test suite needs 2 GB moves this term to 2 GB; the
  formula is only as good as your `SHIP_TEST_COMMAND`'s appetite.
- CPU did not bind at 4 with model-latency-bound runs. If your tests are
  CPU-heavy, `vCPUs` is the honest cap; if they are not, memory is.

Examples: 8 vCPU / 16 GB → min(8, 36) = **8**. 4 vCPU / 8 GB → min(4, 16) =
**4**. 2 vCPU / 4 GB → min(2, 6) = **2**.

Whatever you pick, the daily budgets bound cost, not the ceiling: a higher
ceiling spends the same money faster.

## Not measured, and why

- **Ceiling 8.** The whole test was budgeted under $1.50 of model spend and
  the two bug-finding batches used $1.06 of it. The 8 row is the projection
  above; it needs a bigger box anyway to be a useful number.
- **Multi-turn tasks.** One-line edits finish in 5–7 turns. Execution time
  scales with turns; throughput per ceiling scales inversely. The ceiling
  figure holds; the runs/min figure is for trivial tasks only.
- **Multiple workers.** One worker, one box. The claim and the lease are
  fleet-wide by design; their cost across boxes was not measured here.
- **Nucleus under history.** 257 MB RSS with ~100 runs of history. The
  1500 MB cap is far off; the engine's own accounting starts rejecting writes
  at 90% of `NUCLEUS_MAX_MEMORY_MB` (1024), which is the number to watch.
