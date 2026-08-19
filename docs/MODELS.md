# Models — what "bring your own model" does and does not mean

LIVE. Written 2026-08-18. This is the single canonical statement of Ship's
model position; README, the changelog, the marketing site and the roadmap all
point here rather than restating it. If a number appears in two places, one of
them will go stale — so numbers live only in this file and in the dated
writeups under `evals/`.

---

## 1. What is model-agnostic — the architecture

Ship holds no model. It resolves an id to one of two adapter shapes, direct or
through a gateway you run, always with your credentials
(`src/cli.ts`, `baseModel()`):

| model id | with `AI_GATEWAY_URL` set | without |
|---|---|---|
| `anthropic/<id>` | Anthropic-shaped adapter against your gateway | Anthropic API directly |
| anything else | OpenAI-shaped adapter against your gateway | OpenAI API directly |

Any endpoint that speaks either wire format is reachable. That is how Ship runs
on GLM at all: z.ai exposes an Anthropic-compatible API, so it needed no code
change, only environment (`swebench/README-run.md`). The same is true of a
local runtime, a corporate proxy, or a second vendor.

Cost accounting has a matching seam: prefixes that run on your own hardware
(`ollama/`, `local/`, `lmstudio/`, `llamacpp/`, `llama-cpp/`, `vllm/`,
`localai/`, `jan/`, extensible via `SHIP_LOCAL_MODEL_PREFIXES`) are priced at zero, and an
unrecognised hosted model is priced at the highest known rate so a spend cap
cannot fail open. Declare a real rate with `SHIP_MODEL_PRICING`
(`src/pricing.ts`, and the table in `docs/DEPLOY.md`).

**That is a routing and accounting claim, and it holds. It is not a claim
about how well any given model does the work.** Those are different questions
and the rest of this file is about the second one.

## 2. What has actually been measured

| model | harness | result | date |
|---|---|---|---|
| `glm-5.3` | SWE-bench Lite, seeded 50 of 300, official evaluator | **35/50 resolved — 70.0%, 95% CI roughly 57–81%** | 2026-08-16 |
| `glm-4.6` | same 50 instances, same harness | 18/50 — 36% | 2026-08-18 |
| `claude-haiku-4-5` | 9-instance smoke, hand-picked from instances glm-5.3 resolved | 1/9 resolved; **5/9 produced no patch at all**; 4/9 reported `finished` having never edited a file | 2026-08-18 |
| `claude-sonnet-5` | in-house starter suites (3 and 6 tasks) | saturated — 3/3 and 6/6 | 2026-07-03 |
| `claude-haiku-4-5` | in-house suites (6 and 4 tasks) | 6/6 pass@2 on `hardSuite`, 4/4 on `extremeSuite` | 2026-07-04, 2026-07-07 |
| any OpenAI-shaped model | — | **never benchmarked.** Routing is implemented; no published number exercises it | — |
| local runtimes (`ollama/` etc.) | — | **never benchmarked.** Routing and zero-cost accounting implemented | — |

Writeups: `evals/2026-08-16-swebench-lite-50-glm53.md`,
`evals/2026-08-18-crossfamily-overfit.md`, `evals/README.md`.

Read the caveats with the numbers, not after them:

- **70% is Ship + GLM 5.3, not Ship.** No model control has been run at 50
  instances. n = 50 of 300, so the honest phrasing is "around seventy on a
  seeded quarter-sample", and it is not comparable to a full-300 leaderboard
  entry.
- **That configuration is barer than the product** — thinking 32768, step cap
  40, critic off, code index off. The product runs a richer loop, which has not
  been benchmarked.
- **The haiku row is n=9 and is not a random sample.** The instances were
  chosen from ones glm-5.3 had already resolved, precisely so a failure would
  be informative. It is enough to refuse a strong positive claim about
  cross-family portability. It is **not** enough to support a negative one —
  one model does not characterise a family, and the same model saturates our
  in-house suites.
- **The in-house suites are 3 to 6 tasks and saturated.** A 100% on them says
  the stack works end to end. It is a smoke test, not validation.
- **The SWE-bench harness cannot currently run an OpenAI-shaped model.**
  `swebench/run-inference.mjs` builds every chat model with
  `createAnthropic`/`anthropic`; the OpenAI adapter appears there only for
  embeddings. So the OpenAI routing path in the product has never been
  exercised by any published number, and nobody should read one into it.

## 3. The known limitation, named plainly

Ship's prompt and nudges were written and tuned while only ever being observed
against GLM. On `claude-haiku-4-5` that shows up as an agent that investigates
and never commits: 55% of its shell commands are pure inspection, and all 36 of
its `sed` invocations are `sed -n '<range>p'` to read — never `sed -i` to
write.

This is **not** an action-format problem. Haiku emits valid ```edit blocks, and
its parse-failure count is lower than GLM's in absolute terms over a fifth the
actions. The format works. The prompt produces commitment in GLM and
deliberation in haiku, and a benchmark harness that had only ever seen GLM had
no way to notice the difference. Full working:
`evals/2026-08-18-crossfamily-overfit.md`.

There is a gate for the dishonest half of this. `FINISH_NUDGE_CLEAN_TREE` holds
a finish when a workspace fingerprint exists and the tree is clean, bounded at
two holds. It cut declared-finish-over-untouched-tree from 3 to 1 on a repeat
of the same instances. It did **not** improve the empty-patch rate — 4/8 to
5/8, which at n=8 against a visibly stochastic model is noise in the wrong
direction, not a regression — and it must not be described as a portability
fix: it makes an ending honest; it cannot make a model produce a diff.

**Where it is on.** Checked against source 2026-08-19, because an earlier draft
of this file said "default off on both paths" and that is wrong:

| path | state |
|---|---|
| live loop (`runAgent`, `agent.ts:342`) | **on**, unconditionally, whenever `requireVerifiedFinish !== false` |
| durable loop (`durable.ts:686`) — the product | **off** unless the run input carries `requireEdit` |

So the numbers above were measured with the gate ON (the harness drives the
live loop), and a webhook-launched production run does **not** have it unless
`SHIP_REQUIRE_EDIT=1` is set (`runtime.ts:454` — the only way to turn it on;
there is no CLI flag). That asymmetry is a known gap, not a decision.

Closing this properly is per-family prompt tuning, and should be called that.

## 4. What we do not claim

- Not that every model works. One family is validated; another is measurably
  worse on the same harness for reasons upstream of the model's capability.
- Not that a benchmark number describes Ship. Every number here names a model.
- Not that the OpenAI or local-runtime paths are validated. They route. That is
  all that has been shown.
- Not that 70% is comparable to a published leaderboard entry. Different sample
  size, different loop.

## 5. The honest one-paragraph version

Ship is model-agnostic by architecture — two adapter shapes,
Anthropic-compatible and OpenAI-compatible, direct or through a gateway you
run, with your credentials and no markup. It is validated and prompt-tuned on
GLM. Other families run; how well varies, and we publish what we measured
rather than what we assume.

## 6. Re-deriving this file

| claim | command |
|---|---|
| the two adapter shapes | `sed -n '/^function baseModel/,/^}/p' src/cli.ts` |
| where the clean-tree gate is on | `grep -n FINISH_NUDGE_CLEAN_TREE src/agent.ts src/durable.ts` |
| local prefixes, zero-cost | `grep -n BUILTIN_LOCAL_PREFIXES src/pricing.ts` |
| harness is Anthropic-only for chat | `grep -n 'createAnthropic\|createOpenAI' swebench/run-inference.mjs` |
| every number above | the dated files in `evals/` |

If any row here disagrees with source, source wins and this file is wrong —
say so and fix it rather than working around it.
