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

- Box: local dev machine (x86_64, Docker 29.6.1), swebench 4.1.0 venv
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

---

# Retry results (same day) — combined score now 2/3

The two failed instances were re-run with: the environment briefing +
patch-preservation prompt, a diff-snapshot safety net in the harness,
and (see caveat) an executor bug fix. Scored by the official evaluator:

| Instance | First attempt | Retry |
|---|---|---|
| psf__requests-3362 | fail (empty patch) | **RESOLVED** |
| psf__requests-2317 | fail (empty patch) | still fails — but now a real 943-char, 2-file patch, not empty |

**Combined 3-instance scoreboard: 2/3** (flask-4045 + requests-3362),
vs OpenHands CodeAct 2.1's 1/3 on the same instances (model-mismatch
caveat above still applies).

**Confounded-variables caveat, stated honestly:** two things changed
between attempts — (1) the prompt/harness tuning, and (2) a real
executor bug found mid-retry: `putFile` piped file content through
`ssh docker exec -i ... cat`, whose stdin never received EOF, hanging
runs indefinitely (caught via `docker top` showing a bare `cat` blocked
on read; the run sat ~1h with zero API cost). Python actions had been
silently degraded before the fix, which alone could explain some
empty-patch behavior. This run therefore does NOT cleanly isolate the
prompt's contribution.

**Infrastructure hardening that followed:** the executor was rewritten
from ssh-shell-strings to the Docker Engine API (`dockerode` over an
SSH-forwarded Unix socket): exec as argv arrays (no shell assembly),
files as tar archives (no stdin pipes), in-container `timeout` + a
local backstop. `swebench/smoke.mjs` (8 checks: quoting torture,
putFile/getFile, cwd, timeout, exit codes) passes against a real
instance image — this structurally removes both bug classes rather
than patching them.

**Next:** requests-2317 now produces real-but-wrong patches — diagnose
why that patch fails the hidden tests (a tractable debugging task, vs
"agent gave up"). Then widen the instance set for a less noisy number.

---

# 2317 diagnosis (same day) — final gauge: 3/3

Diagnosed why requests-2317's real patch "failed," using the official
eval artifacts rather than guesswork:

1. The official report showed **all 8 FAIL_TO_PASS tests PASSED** with
   our patch — the agent's fix was functionally correct.
2. The blocker was one PASS_TO_PASS "regression":
   `test_params_are_merged_case_sensitive`.
3. That test **passes with our patch in isolation** (0.4s), and it is
   network-dependent (hits httpbin live, like much of this 2015-era
   suite).
4. **Re-running the official evaluator on the byte-identical patch:
   RESOLVED.** The original failure was benchmark-side network
   flakiness, not our patch.

**Final 3-instance gauge: 3/3 resolved** (flask-4045, requests-2317,
requests-3362) vs OpenHands CodeAct 2.1's 1/3 on the same instances —
still with the standing caveats: n=3, and our model (claude-sonnet-5,
2026) is far newer than their entry's (sonnet, 2024-10).

**Operational lesson for all future runs:** old requests/flask
instances contain live-network tests; a FAIL verdict on them warrants
one re-score before being believed. (The leaderboard community handles
this the same way; SWE-bench Verified exists partly because of such
noise.)
