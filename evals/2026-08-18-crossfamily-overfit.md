# The harness was overfit to GLM — cross-family run, 2026-08-18

**A $3.65 test found a real defect in Ship's headline promise.** Ship sells
BYO-model. On a non-GLM model, **more than half of runs produced no patch at
all**, and four of nine declared themselves *finished* having never edited a
single file.

## The numbers that matter

| model | family | resolved | empty patches | `finished` having never edited |
|---|---|---|---|---|
| glm-5.3 | GLM (strong) | 35/50 = 70% | 4/50 = 8% | **0 / 50** |
| glm-4.6 | GLM (weak) | 18/50 = 36% | 3/50 = 6% | **0 / 50** |
| claude-haiku-4-5 | Anthropic | 1/9 | **5/9 = 56%** | **4 / 9** |

The controlling comparison is the middle row. glm-4.6 is a *much* weaker model —
half the resolve rate of 5.3, a 34-point gap — and its empty-patch rate is
**6%**, essentially identical to 5.3's 8%.

So model **strength** does not predict empty patches. Model **family** does.
That is what makes this a harness defect rather than a capability gap: a weak
model still edits the tree and fails honestly; a different-family model sails
past the gate having done nothing.

## Root cause

The verified-finish gate asked **"did any command succeed?"** — never **"did the
tree change?"**

An agent satisfies the first with `cat`, `grep` and `pytest`. GLM happens to
edit before claiming completion, so the gate looked sound for 100 instances.
Haiku narrates instead: it reads the code, runs the tests, concludes the code is
already correct, and finishes. Status `finished`, zero edits, empty patch,
automatic zero.

Note the shape — this is the house failure mode again. The gate was correct
about commands and correct about finishes, and the one thing that actually
defines the deliverable, the diff, was never consulted. The fingerprint was
already being computed a few lines away for the settle path.

## Fix

`FINISH_NUDGE_CLEAN_TREE`: before honouring a finish, if a workspace fingerprint
exists and the tree is **clean**, hold the finish and tell the agent plainly
that `git diff` is empty and a summary without a diff is worth nothing.

- Bounded at two holds, so a stubborn agent is still honoured rather than looped.
- Only fires where a fingerprint exists (a git repo), so tasks whose deliverable
  is not a diff are unaffected.
- Covered by a seam test that fails when the gate is removed — verified both
  ways, not assumed.

## Honest limits

- **n=9 for haiku.** Small. But 4/9 versus 0/100 is not a subtle effect, and the
  mechanism is identified in source rather than inferred from a rate.
- **The fix is unmeasured.** It should raise haiku's patch rate; whether that
  converts into *resolved* instances is a separate question, and the settle A/B
  is a standing reminder that a process metric is a hypothesis about the score,
  not a proxy for it.
- One model does not characterise a family. A GPT-class check would be the next
  cheap datapoint.

## Cost

**$3.65 actual**, against a $4 ceiling and a ~$3 estimate — the estimate held.
9 instances, one per repo, thinking off, chosen from instances GLM 5.3 had
resolved so a failure would be informative rather than ambiguous.

Cheapest finding of the week by a wide margin. The 50-instance sweeps cost
7 hours each and told us less.
