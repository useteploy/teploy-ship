# SWE-bench Lite 3-instance gauge — 2026-07-03

First run of teploy-agent on the industry-standard benchmark, scored by
the **official swebench evaluator** (v4.1.0) on gold-validated instances,
compared per-instance against **OpenHands' official leaderboard entry**
(swe-bench/experiments repo).

## Result

| Instance | teploy-agent + claude-sonnet-5 | OpenHands CodeAct 2.1 + sonnet-20241022 |
|---|---|---|
| pallets__flask-4045 | **RESOLVED** | not resolved |
| psf__requests-2317 | fail (empty patch, max-steps) | **RESOLVED** |
| psf__requests-3362 | fail (empty patch, max-steps) | not resolved |
| **Total** | **1/3** | **1/3** |

OpenHands' aggregate on the full Lite (300): 125/300 = **41.7%**
(their leaderboard entry). Ours on 3 instances is not an aggregate claim.

## Honest caveats — read before quoting any of this

1. **n=3.** Statistically meaningless as a score. This run validates the
   *pipeline* (agent → real SWE-bench containers → official scoring) and
   gives directional signal, nothing more.
2. **Not model-controlled.** We used claude-sonnet-5 (2026); OpenHands'
   entry used claude-3-5-sonnet (Oct 2024) — a much older model. A true
   harness-vs-harness comparison requires the same model on both sides
   (OpenHands is open-source; that run is possible later).
3. What IS legitimate: same instances, same official grader, and the
   per-instance diff is interesting — we resolved one they didn't
   (flask-4045); they resolved one we didn't (requests-2317).

## Failure diagnosis (the actual value of this run)

Both failures were **empty patches** — the agent worked the full 40 steps
and produced no committed change. From the logs:

- **Missing environment briefing.** requests-3362's agent burned its
  final ~10 steps hunting for pytest (`find / -name pytest`...) — the
  SWE-bench containers use conda envs the prompt never described.
  OpenHands' SWE-bench scaffold injects environment/test instructions;
  ours gave none. Cheap fix, likely high impact.
- **Work not preserved.** The 3362 agent *did* edit
  `src/requests/utils.py` mid-run (visible in its own `git diff` action)
  but the final tree had no diff — it apparently reverted its change
  while thrashing on verification. The task prompt should state that the
  deliverable is the edited working tree and forbid reverting; the
  harness could also snapshot `git diff` every N steps and keep the last
  non-empty one.
- **Verification thrashing** near the step cap instead of settling on a
  best-effort patch — "when unsure, leave your best change in place"
  beats "keep probing until steps run out."

## Setup (reproducible)

- Box: tyler@192.168.1.115 (x86_64, Docker 29.6.1), swebench 4.1.0 venv
  at /tmp/sweb.
- Instances gold-validated first (`-p gold`): flask-4045 ✓,
  requests-2317 ✓, requests-3362 ✓. (Original pick psf__requests-863
  **fails its own gold patch** in this environment — swapped out; this is
  why gold validation runs first.)
- Inference: `swebench/run-inference.mjs` — official instance image per
  task, agent works at /testbed via ssh-docker-exec executor, patch =
  `git diff HEAD`, container destroyed after.
- Scoring: official `swebench.harness.run_evaluation` with our
  predictions.json.
- Cost: ~$2–4 API (requests tasks ran 142s/194s at 40 steps each).

## Next lever (measurable)

Add to the SWE-bench task prompt: (a) environment briefing (how to run
tests in the container), (b) "your deliverable is the edited working
tree — never revert your fix; if unsure, leave your best attempt in
place." Re-run the two failed instances (~$1–2) and see if empty-patch
→ real patch. That's the first real tuning iteration with a
before/after.
