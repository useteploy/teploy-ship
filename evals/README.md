# Eval baselines

Point-in-time runs of `teploy-agent eval` against a real model, kept so
quality changes can be compared over time.

| Date | Model | Suite | pass@k | Note |
|------|-------|-------|--------|------|
| 2026-07-03 | claude-sonnet-5 | builtinSuite (3) | 3/3 (100%), 9/9 attempts | First live run. See below. |

## 2026-07-03 — claude-sonnet-5, builtinSuite, repeats=3

100% (9/9 attempts). Steps: fizzbuzz 2, sum-numbers 3, fix-bug 4–5. Full
output in `2026-07-03-sonnet5-baseline.txt`.

**What it proves:** the full stack works end-to-end with a real model —
the CodeAct loop, `@neutron-build/ai` against the real Anthropic API,
independent verification. The agent genuinely solves these tasks (it
reads, reasons, edits, and verifies), not by luck.

**What it does NOT give us:** a discriminating signal. At 100% the
benchmark is saturated — it can't measure whether a prompt/recovery/
action change helps, because everything still passes. This suite is a
**smoke test**, not a tuning instrument.

**Next:** add a harder tier — multi-file tasks, real debugging that needs
several diagnostic steps, tasks that exercise recovery/condensation, and
some the agent *sometimes fails*. A useful benchmark sits well below
100% so improvements are visible. Grow toward SWE-bench-lite class.
