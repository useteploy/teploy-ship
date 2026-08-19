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

---

# Follow-up: the fix measured, 2026-08-18

**The gate does its stated job and does not solve the problem.** Same 8
instances (a 9th was cut by the budget stop), haiku, clean-tree gate ON.

| | before | after |
|---|---|---|
| `finished` having never edited | 3 | **1** |
| empty patches | 4/8 | **5/8** |
| cost | $3.19 | **$4.08** (+28%) |

The specific defect improved: agents no longer *declare success* over an
untouched tree, which was the dishonest failure. The empty-patch rate did not,
and nominally worsened — at n=8 against a visibly stochastic model that is
noise, not a regression.

## What the runlog actually says

**All five empty runs have `everEdited: false`.** Nothing was written and then
lost — `recovered` is false everywhere. So this was never a work-preservation
problem, and the snapshot net has nothing to catch.

That reframes the original finding. It is not simply that the gate was overfit
to GLM: **haiku frequently never emits an edit action at all**, and no amount of
nudging conjures one. The gate can refuse a dishonest finish; it cannot make a
model produce a diff.

Three instances that previously produced substantial patches (pylint-7228 at
3241 chars, matplotlib-23913 at 1290, scikit-learn-11281 at 843) came back at
zero, never having edited. Nothing was reverted — these are simply different
trajectories from a model with high run-to-run variance. Do not read them as
the gate causing harm; do not read the two that improved as it causing good.

One run still finished having never edited, because the hold is bounded at two.
That bound is deliberate — an unbounded refusal loop is worse — so a determined
non-editor will always eventually escape.

## Where this leaves BYO-model

The honest state: **our action format works well with GLM and poorly with
haiku**, and the reason is upstream of the finish gate. The next question is why
haiku does not emit ```edit / ```create blocks — most likely the SEARCH/REPLACE
shape — and that needs reading transcripts, not another sweep.

Keep the gate, default off on both paths. It makes a run's ending honest and
costs nothing when unused. It is not a fix for cross-family compatibility and
must not be described as one.

Spend to date on this line of work: **$7.27**.

---

# Correction: it is not the action format, 2026-08-18

**The hypothesis published above — that haiku struggles with the `edit`
SEARCH/REPLACE shape — is WRONG.** Tested for free by reading the action stream
rather than running another sweep.

| | haiku | glm-5.3 |
|---|---|---|
| `edit`/`create` as a share of all actions | 6 of 225 = **2.7%** | 111 of 1281 = **8.7%** |
| `invalid-action` (a genuine parse failure) | 12 | 39 |
| read-only bash (`sed -n`, `cat`, `grep`, `head`, `find`, `ls`) | **55% of all bash** | — |
| `sed` used **in place** (`sed -i`) | **0 of 36** | — |

Haiku emits perfectly valid `edit` blocks six times, so the format parses. Its
`invalid-action` count is *lower* than GLM's, in absolute terms, over a fifth
the actions. And every one of its 36 `sed` calls is `sed -n '<range>p'` — using
sed to READ, never `sed -i` to write.

So haiku is not failing to express edits. **It is choosing to keep reading.**
It investigates at length — 55% of its shell commands are pure inspection — and
then concludes the code is already correct.

This holds despite the task prompt already stating, in capitals, that
`The DELIVERABLE IS YOUR EDITED WORKING TREE`. An explicit instruction does not
move it.

## What this means

The defect is real but its name was wrong. Not "the action format is overfit to
GLM" — the format is fine. Rather: **our prompt produces commitment in GLM and
deliberation in haiku**, and a benchmark harness that only ever saw GLM had no
way to notice the difference.

The clean-tree gate treats the symptom, a dishonest finish, and it should be
kept for that. It cannot address the cause, which is an agent that reads for
forty turns and never decides to act.

Anything further here is model-specific prompt tuning, and should be recognised
as that rather than dressed up as a portability fix. Worth doing before Ship
claims BYO-model works well with any model; not worth doing blind.

**Method note:** this correction cost nothing. The two sweeps that produced the
original hypothesis cost $7.27 and eight hours; reading the action stream took
two greps. Look at what the agent actually did before paying to watch it do it
again.
