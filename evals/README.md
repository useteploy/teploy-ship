# Eval baselines

Point-in-time runs of `teploy-agent eval` against a real model, kept so
quality changes can be compared over time.

| Date | Model | Suite | pass@k | Note |
|------|-------|-------|--------|------|
| 2026-07-03 | claude-sonnet-5 | builtinSuite (3) | 3/3 (100%), 9/9 attempts | First live run. Stack works; suite saturated. |
| 2026-07-03 | claude-sonnet-5 | hardSuite (6) | 6/6 (100%), 12/12 attempts | Harder (6–7 steps/task) but Sonnet still saturates it. |
| 2026-07-03 | claude-haiku-4-5 | hardSuite (6) | 3/6 (50%), 5/12 attempts | **Discrimination confirmed** — the benchmark works. See below. |
| 2026-07-04 | claude-haiku-4-5 | hardSuite (6) | 6/6 (100%) pass@2 | Kernel + str_replace editor closed the gap — measured harness win. |
| 2026-07-05 | claude-haiku-4-5 | extremeSuite (4) | 2/4 (50%), repeats 1 | **Headroom restored.** Guard ON; both failures are premature finishes after one successful exploratory command (guard's designed limit — deliverable-aware finish check is the next lever). |

## The benchmark discriminates (validated 2026-07-03)

Same `hardSuite`, two models: Sonnet 5 **100%**, Haiku 4.5 **50%**
(pass@2; ~42% per-attempt). A benchmark that separates a strong model
from a weaker one is a working instrument — it can now measure whether a
model *or a harness change* is better.

**What the Haiku failures reveal (the tuning targets):**
- **Premature finishing** — several tasks (roman, brackets) failed at
  *1 step*: the agent emitted a finish without creating the file, and
  independent verification caught it. This is an agent-quality failure
  (not raw capability) and is plausibly fixable — e.g. a prompt that
  forbids finishing without a verifying action, or recovery that rejects
  an unverified finish. **Now measurable against the 50% baseline.**
- **Genuine capability gaps** — multi-file-bug and chunk failed some
  attempts *after* real work (5–15 steps), i.e. wrong fixes. Those track
  model strength.

This is the point of the harness: it turned "is the agent good?" into
"Haiku scores 50% on hardSuite, and here are the specific failure modes
to attack."

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

## 2026-07-04 — kernel + editor measured (Haiku, hardSuite)

| Metric | Before (2026-07-03) | After kernel+editor |
|---|---|---|
| pass@2 | 3/6 (50%) | **6/6 (100%)** |
| per-attempt | 5/12 (~42%) | 8/12 (67%) |

Same model (claude-haiku-4-5), same suite, same grader. The change under
test: the persistent python kernel + the ```edit/```create structured
actions, plus the prompt lines documenting them.

Per-task movement: balanced-brackets 0/2→2/2 (previously two 1-step
premature finishes — now it writes the file via ```create and passes in
3 steps), roman 0/2→1/2, chunk 0/2→1/2, config 1/2→1/2, csv 2/2 stays,
multi-file 1/2 stays. Remaining failures are still short-attempt
premature finishes (2–3 steps) — the known failure mode, next lever.

Caveats: n=12 attempts, so per-attempt movement (42→67%) is directional;
pass@2 saturating the suite means Haiku now ALSO needs a harder tier for
further tuning headroom. Sonnet unaffected (was already 100%).
