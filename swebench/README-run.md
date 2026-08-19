# Running a SWE-bench sweep

Build the instance list once (seeded, reproducible):

    node swebench/make-sample.mjs 50

## Against Anthropic (the paid baseline)

    SWEBENCH_PRUNE_IMAGES=1 \
    ANTHROPIC_API_KEY=... \
    node swebench/run-inference.mjs <ssh-host> \
      swebench/instances-lite-50.json swebench/preds-sonnet5-50.json

## Against GLM via z.ai (Anthropic-compatible endpoint)

z.ai exposes an Anthropic-compatible API, and the harness builds its model with
`createAnthropic({ baseURL, apiKey })` — so this needs no code change, only env:

    SWEBENCH_PRUNE_IMAGES=1 \
    SWEBENCH_THINKING_TOKENS=32768 \
    AI_GATEWAY_URL=https://api.z.ai/api/anthropic \
    AI_GATEWAY_KEY=<z.ai coding-plan key> \
    SWEBENCH_MODEL=glm-5.3 \
    node swebench/run-inference.mjs <ssh-host> \
      swebench/instances-lite-50.json swebench/preds-glm53-50.json

**Models available on the coding plan** (probed 2026-08-16, all free):
`glm-5.3` (what `glm-5`/`glm-5.2` now resolve to), `glm-4.6`, `glm-4.5`,
`glm-4.5-air` -> served as **glm-4.7**, `glm-4.6v` (vision). `glm-5.3-flash`
does not exist. A second GLM is a free way to vary the MODEL while holding the
harness constant — but it cannot tell you whether the harness is overfit to
GLM.

**It is. That was measured on 2026-08-18 and the answer was yes.** A
9-instance cross-family smoke on `claude-haiku-4-5` (instances hand-picked from
ones glm-5.3 had resolved, so a failure would be informative) produced **no
patch in 5 of 9 runs**, and 4 of 9 reported `finished` having never edited a
file — against 0 of 100 GLM runs. glm-4.6, a far weaker model, has a 6% empty
rate against 5.3's 8%, so model *strength* does not predict this; model
*family* does.

The cause is **not** the action format — haiku emits valid ```edit blocks and
has fewer parse failures than GLM. Every prompt and nudge in this harness was
written while only ever being observed against Zhipu models, and it produces
commitment in GLM and deliberation in haiku: 55% of haiku's shell commands are
pure inspection, and all 36 of its `sed` calls read (`sed -n`) rather than
write. Full working in `evals/2026-08-18-crossfamily-overfit.md`; the product's
position is `docs/MODELS.md`.

Consequences for anyone running a sweep here: **a number from this harness is a
number for Ship plus that model**, and a non-GLM arm needs its empty-patch and
`everEdited` rates read before its score means anything.

Re-verified 2026-08-16 against the live coding-plan endpoint:

- **`glm-5.2` is gone.** Every 5.x id (`glm-5`, `glm-5.2`, `glm-5.3`) now serves
  **glm-5.3**. `glm-4.6` still pins, so z.ai retires point releases within a
  major line rather than keeping them addressable — **do not expect to reproduce
  an old run's model.** Record the served `model` from the response, not the id
  you asked for.
- `cache_control` is ACCEPTED, so `SWEBENCH_NO_CACHE` is not needed.
- `thinking` blocks come back populated, at budgets up to at least 32768.
- Use the CODING PLAN key against `/api/anthropic`. The standard z.ai API is a
  different base path and a different product.

The predictions file records `model_name_or_path` as `teploy-agent+<model>` —
or `teploy-agent-durable+<model>` on the durable arm — so two runs stay
distinguishable when scored, and a durable result can never be graded as the
live-loop baseline even if its runlog is lost.

## Arms: which loop, and what each one answers

Every number this harness has published was measured on **`runAgent`**
(`src/agent.ts`) — the live loop, which serves the CLI's one-shot `run`, the
eval suite and this file. The **product** is **`durableAgent`**
(`src/durable.ts`): the webhook -> intake -> worker -> PR path that `worker.ts`
drives. They are different loops, so a live-loop figure does not describe the
shipped thing. `SHIP_DURABLE` closes that.

**What is NOT different, contrary to two planning docs** (checked against
source and then against a real container, 2026-08-18): the durable path DOES
have the persistent kernel. `durable.ts:824` calls `executeAction(executor,
action, timeout, "t<turn>")` with four arguments and the fifth parameter is
`useKernel = true` (`agent.ts:523`). Proved live in the astropy canary image: a
variable set in one `turn-N-exec` was still bound in the next
(`kernel says 42` -> `kernel remembered 42`). The only kernel-related
difference is that the live loop calls `stopKernel` on the way out
(`agent.ts:501`) and durable does not — irrelevant here, the container is
destroyed after every instance.

**What IS different** — three defaults, all of which change when a run ends:

| | live (`runAgent`) | durable (`durableAgent`) |
|---|---|---|
| stuck detection | ON by default (`agent.ts:220`) | OFF unless the run input carries `recovery` — or `settle`, which implies it (`durable.ts:522`) |
| clean-tree finish hold | unconditional (`agent.ts:342`) | gated on `input.requireEdit` (`durable.ts:686`) |
| `maxSteps` default | 20 | 40 — moot, the harness passes it |

So a durable sweep at durable's own defaults differs from the 35/50 baseline in
three ways at once and its delta would mean nothing. Hence two arms:

- **`SHIP_DURABLE=1` — parity.** `recovery` (thresholds materialized) and
  `requireEdit` forced on, matching the live loop's defaults, so the **loop** is
  the only variable against 35/50. Answers: *is the durable loop worse?*
- **`SHIP_DURABLE=product` — product.** Exactly what `enqueueRun`
  (`src/runtime.ts`) bakes into a webhook-launched run: `steer`/`index`/`guard`
  on, no `recovery`, no `requireEdit`. Answers: *what does a real run score?*
  It is NOT term-by-term comparable to 35/50.

**Whichever number is published must be named with its arm. Never average them
and never compare them to each other without saying which is which.**

### The product configuration in one shot (P0-2)

    SHIP_DURABLE=1 SHIP_CRITIC=1 SHIP_CODE_INDEX=1 \
    NUCLEUS_URL=... SHIP_EMBED_URL=... SHIP_EMBED_KEY=... \
    ... the usual model env ... \
    node swebench/run-inference.mjs <ssh-host> <instances.json> <out.json>

The operator setup under **Index arm** below is unchanged and still mandatory —
the harness refuses to start without those three variables.

One product change was required to make this runnable at all, and it is worth
knowing about. The critic, the ```search action, the prompt's search
advertisement and the `repo-index` refresh were ALL gated on the run having
cloned a repository, and **a SWE-bench container cannot be a repo run**:
/testbed is pip-installed editable, so an agent editing a clone elsewhere is
graded against the untouched original. `DurableAgentInput.workspaceKey` (absent
by default) says "no repo, but this workspace is a git tree — scope its index
here", which opens exactly those four gates. Without it a `SHIP_DURABLE=1
SHIP_CRITIC=1 SHIP_CODE_INDEX=1` sweep would run with **neither** feature and
report a number that looked real; the stale-dist guard now refuses to start if
the build predates the field.

On the durable arm the index is refreshed by **durable.ts's own `repo-index`
step**, not by the harness — that step is part of what a product-configuration
sweep is measuring, and running both would double an already minutes-long
index cost. The scope key is the same `instance_id` either way, so the
per-instance vector cleanup is unchanged.

### What the durable arm adds to the runlog

`loop` (`live`/`durable`) is on **every** row of every run, so a result can
never be misattributed after the fact. The durable rows add `arm`, the verbatim
`durableInput`, `outcome` (the raw RunOutcome status), `turns`, and counts read
off the event log: `thinks`, `execs`, `searches`, `criticDiffs`, `criticRuns`,
`condenses`, `steers`, `fingerprints`, `treeChecks`, `failedSteps`, `parked`,
and `indexNote` (the `repo-index` step's own account of itself).

**Read `execs` and `thinks` first.** A durable row with zero execs means the
provider never attached and the arm measured nothing — the durable equivalent of
the `searches: 0` trap. **`parked` must be false**: a parked run has no operator
to approve it, so the harness aborts if the first instance parks.

Two fields are **not comparable across arms**: `snapshots` (durable's
fingerprint, critic-diff and index reads all go through the wrapped executor,
while the live arm deliberately indexes off `baseExecutor`) and `steps` (model
turns in both cases, but counted from `result.steps` live and from
`turn-N-think` steps durable).

The durable arm also writes `<out-preds>.durable-events/<instance>.events.jsonl`
— one fsynced event log per instance, from the product's own `FileEventStore`.
With no `onEvent` hook on this path those logs are the **only** post-mortem
record of what a run did: the thing the 2026-08-12 sweep did not have.

**Re-running.** A durable run REPLAYS its event log rather than re-running it,
so the harness refuses to start an instance whose
`<out-preds>.durable-events/<instance>.events.jsonl` already exists. Write to a
new predictions path, or move that directory aside — otherwise a second sweep
would report the first one's outcomes against a fresh, empty container.

**Approvals.** A sweep passes `autoApprove`, not the `defaultApprovalPolicy`
the CLI (`cli.ts:637`) and the worker (`worker.ts:275`) use, and never sets
`plan`. Do not "match the product" here: the product has a human attached to
answer a park, and a sweep does not — a parked run hangs forever. (The live arm
already runs with no approval policy at all, so this is the parity choice too.)

## Knobs

| env | default | why |
|---|---|---|
| `SWEBENCH_MAX_STEPS` | `40` | 28/50 runs hit 40 on 2026-08-12. OpenHands runs ~100. Default is left at 40 on purpose — see attribution below. |
| `SHIP_FINISH_WHEN_SETTLED` | off | offer a settled agent a finish instead of spinning to an abort. Read the caveat in run-inference.mjs: it reaches most runs, not just aborts, so the score can move DOWN |
| `SHIP_CRITIC` | off | run the independent critic pass. **This is what makes a sweep the PRODUCT's number** — every figure published so far came from a barer loop than users run. Costs a second model call per finishing run |
| `SHIP_DURABLE` | off | **which loop runs.** Unset = `runAgent` (src/agent.ts), the loop every published number was measured on. `1` = the durable loop (src/durable.ts) in its PARITY arm; `product` = the durable loop at the product's own enqueue defaults. Read **Arms** below before running either — they answer different questions and are not interchangeable |
| `SHIP_CODE_INDEX` | off | index each instance's checkout into Nucleus vectors and give the agent the ```search action. Requires `NUCLEUS_URL` + `SHIP_EMBED_URL` + `SHIP_EMBED_KEY` (it refuses to start without them) — read **Index arm** below first; this is the one knob that is not just an env var |
| `SHIP_EMBED_MODEL` | `ollama/nomic-embed-text` | embedding model id, provider-prefixed as the gateway routes it. Only read when `SHIP_CODE_INDEX=1` |
| `SWEBENCH_BUDGET_USD` | unset (no cap) | **hard spend ceiling for the whole sweep.** Checked after every instance; stops the run and exits 3. Set it for ANY paid model |
| `SWEBENCH_PRUNE_IMAGES` | off | required for any sweep; images are 1-2 GB each |
| `SWEBENCH_THINKING_TOKENS` | `0` | extended thinking budget, where the model supports it |
| `SWEBENCH_NO_CACHE` | off | disable prompt caching on compat endpoints that reject it |
| `SWEBENCH_MODEL` | `claude-sonnet-5` | model id |

**Harness limitation — this rig is Anthropic-shaped only.** `buildModel()`
(`run-inference.mjs`) constructs every chat model with `createAnthropic` or
`anthropic`; `createOpenAI` appears in this file solely for the code-index
embedder. So `SWEBENCH_MODEL` reaches anything speaking the Anthropic wire
format — including GLM via z.ai — and **cannot** reach an OpenAI-shaped
endpoint, even though the product routes to one (`src/cli.ts`, `baseModel()`).
An OpenAI-shaped arm is therefore not runnable today and no published number
covers that path. Do not let a result from here be read as one. Adding it is a
`run-inference.mjs` change, not an env var.

Each run also writes `<out-preds>.runlog.jsonl` — one line per instance with
`status`, `steps`, `patchLen`, `everEdited` and `recovered`. **`everEdited` is
the one that matters after an empty patch:** false means the agent never
touched the tree (a termination problem), true means it edited and the tree
lost it (a harness problem). The 2026-08-12 run kept no log at all, which is
why its 12 empty patches could not be attributed afterwards.

With `SHIP_CODE_INDEX=1` each line also carries `searches`, `indexFiles`,
`indexChunks`, `indexCapped`, `indexMs` and `indexError`. **Read `searches`
first.** An index arm in which the agent never issued a `search` measures
nothing at all — it is a prompt experiment, not an index experiment — and
without that field the difference is invisible after the money is spent. A
nonzero `indexError` count invalidates the arm outright: those instances ran
the baseline loop, not the index one.

## Attribution: change one thing per sweep

The scored baseline is **Ship + `glm-5.3` resolving 35 of 50 — 70.0%, 95% CI
roughly 57–81% — on a seeded 50-instance sample of SWE-bench Lite's 300, scored
with the official evaluator, thinking 32768, step cap 40, critic off, code
index off, 2026-08-16.** (Previously 22/50 with GLM 5.2, whose model id z.ai
has since retired.)

Quote it in that shape or not at all. It is a property of **Ship together with
GLM 5.3**, not of Ship — no model control at 50 instances has been run — and a
quarter-sample is not comparable to a full-300 leaderboard entry. Bare "70%"
is not a legitimate figure.

Two known losses are being fixed, and they must be measured separately or the
delta is meaningless:

1. **Empty patches** — fixed 2026-08-15 (`putFile` now snapshots). Measured
   2026-08-16 and it rescued **0 of 50**; the fix is latent, not load-bearing.
2. **Step cap** — still 40, and now worth less than it looked: only 24% hit it
   at 5.3 and the median run stops at 33.5 steps. Measure with
   `SWEBENCH_MAX_STEPS=100` against 35/50 if you run it.
3. **Termination — RUN AND SETTLED, 2026-08-18. Do not buy this sweep again.**
   `SHIP_FINISH_WHEN_SETTLED=1` against the same seeded set, same model, same
   thinking budget, same step cap: **36/49 on vs 34/49 off**. Eight instances
   flipped, 5 gained and 3 lost, **McNemar p = 0.73** — indistinguishable from
   noise. The mechanism worked exactly as designed (thrash-aborts 10 -> 1 on the
   partial data) and the score did not move, so the 30% thrash-abort rate was a
   labelling problem, not lost fixes. Keep the flag, default off, because it
   makes an ending honest — but it is not a quality win.
   `evals/2026-08-18-settle-ab.md`.
4. **The critic** (`SHIP_CRITIC=1`) is the one that changes what the number
   MEANS rather than how big it is: without it, the published figure is not the
   product's. Run it once the cheaper knobs are settled.

   **On the durable arm the critic needs `workspaceKey`, which the harness
   now sets.** Before 2026-08-18 the critic was unreachable on any run without
   a repo checkout, which includes every SWE-bench run — so `--durable
   --critic` was a silent no-op. The stale-dist guard refuses to start against
   a build that predates the fix.

5. **The code index** (`SHIP_CODE_INDEX=1`) is now wired — `runAgent` takes a
   `codeSearch` option and the harness can supply one — but it is **not
   runnable from a cold checkout**. It needs the operator setup below, and it
   carries two confounds that bound what any result can claim:

   - **The chunk cap truncates large repos.** `MAX_CHUNKS_PER_REFRESH = 3000`
     with a hard break (`src/code-index.ts:49`), against repos that produce well
     over 10,000 chunks — django, sympy, matplotlib, scikit-learn, which
     dominate SWE-bench Lite. `git ls-files` is path-sorted, so what gets
     indexed is roughly an **alphabetical prefix of the tree**, and
     `indexCapped` will be true on most instances. A null result from such an
     arm does not mean "the index does not earn its RAM", it means "a fraction
     of an index does not". Raising the cap is a `src/code-index.ts` change and
     a prerequisite for any strong claim.
   - **Searches spend the same step budget as actions.** The index arm and
     `SWEBENCH_MAX_STEPS` confound each other. Run the arm at 40 steps against
     the 35/50 baseline, and change one thing.

6. **The LOOP itself** (`SHIP_DURABLE=1`) is the one experiment that decides
   whether any of the numbers above describe the product at all — every one of
   them was measured on `runAgent`, and `worker.ts` runs `durableAgent`. Run
   the parity arm against the same seeded 50 and the same model, change nothing
   else, and compare to 35/50. **Not yet run at time of writing.**

Resist doing two at once in one sweep. The urge is strong and it costs the ability to
say which fix bought what.

## Index arm (task 12): what an operator must set up first

Do not treat `SHIP_CODE_INDEX=1` as a knob like the others. Each of the
following was verified in source; none of it was verified as *done* on the eval
box, and the harness refuses to start rather than guess.

1. **A reachable Nucleus, and not ship's production one.** `ship-nucleus` is an
   accessory with no host port: `teploy-ship/teploy.yml` sets `port: 5432` on
   it, and the CLI uses that field only to build a connection string — host
   publishing needs `publish:`, which is not set (`teploy-cli`
   `internal/accessories/accessories.go`). So the harness machine cannot reach
   it, full stop. Run a **scratch Nucleus** with a published loopback port on
   the eval box and SSH-forward it. That is also the safe choice: ship's engine
   is capped at `memory: 1500m`, and 50 instances of vectors in it reproduces
   the known write-reject-under-memory-pressure failure — which would take the
   ship worker down as collateral damage on a benchmark run. Point `NUCLEUS_URL`
   at the forwarded scratch engine.
2. **The gateway, SSH-forwarded.** `ship-gateway` binds `127.0.0.1`
   (`teploy-gateway/teploy.yml`), so forward `8089` and set `SHIP_EMBED_URL` to
   the forwarded **root with NO `/v1` suffix** — the OpenAI adapter appends
   `/v1/embeddings` itself.
3. **A gateway project token.** `/v1/embeddings` is behind `projectAuth`
   (`teploy-gateway/internal/gateway/server.go`), so `SHIP_EMBED_KEY` must be a
   minted gateway project token. The z.ai key in `AI_GATEWAY_KEY` will 401, and
   the harness deliberately does **not** fall back to it the way ship's own
   `resolveCodeSearch` does (`src/cli.ts`) — in this harness `AI_GATEWAY_URL` is
   the Anthropic-shaped *chat* endpoint, and inheriting it would point
   embeddings at a messages path and fail on every instance, mid-sweep.
4. **`nomic-embed-text` pulled, once**:
   `docker exec ship-gateway-ollama ollama pull nomic-embed-text`
   (`teploy-gateway/teploy.yml`). **This was not verified as done.** The umbrella
   queue's claim that `ship_code_chunks` "has real rows" suggests the path has
   worked at some point, but that is a doc claim, not an engine check.
5. **A scratch engine also avoids a dimension mismatch.** `ship_code_chunks` is
   created at the first vector's dimension and `CREATE TABLE IF NOT EXISTS` will
   not re-shape an existing table, so a table built against a different
   embedding model is a silent trap.

Then, and only then:

    SHIP_CODE_INDEX=1 \
    NUCLEUS_URL=postgres://nucleus@127.0.0.1:5433/nucleus \
    SHIP_EMBED_URL=http://127.0.0.1:8089 \
    SHIP_EMBED_KEY=<gateway project token> \
    ... the usual model env ... \
    node swebench/run-inference.mjs <ssh-host> <one-instance.json> <out.json>

**Canary ONE instance and read `indexMs` before committing to 50.** `refresh()`
does one Docker `getArchive` round trip per tracked file over the SSH-forwarded
socket, plus one serial `INSERT` per chunk over pgwire, with no batching on
either side — per-instance index time is plausibly minutes, and a 50-instance
arm could add hours to an already ~5h sweep. If it does, the arm needs work in
`src/code-index.ts` (batching, a higher cap) before it is worth running, not a
bigger budget.

Housekeeping the harness already does: the index is keyed by `instance_id`, not
by repo name. That costs a full re-embed per instance and is **deliberate** —
instances of one repo sit at different base commits, and a cap-truncated refresh
could leave another instance's post-fix source searchable, which is gold-patch
leakage into a published number. Rows are deleted after each instance, and the
run aborts if the *first* instance fails to index.

## Cost — read before pointing this at a paid model

**Thinking tokens bill as OUTPUT.** On `claude-sonnet-5` ($15/1M output) a
32768 thinking budget across ~33 steps can reach **$2-3 for a single
instance**, so a 50-instance sweep is a three-figure bill that only becomes
visible after it is spent. The GLM coding-plan endpoint is free, which makes
this easy to forget between runs.

Controls, in order of leverage:

1. `SWEBENCH_BUDGET_USD=10` — hard stop. Always set it on a paid model.
2. `SWEBENCH_THINKING_TOKENS=0` — the single biggest lever; thinking is most of
   the output bill.
3. Fewer instances. A **smoke test does not need 50**: if the question is "does
   the harness work with this model at all" — action-block parsing, the nudges,
   the finish gate — 8 to 12 instances answers it.
4. `SWEBENCH_MAX_STEPS` — fewer turns, less context replayed per turn.

Per-instance `costUSD` is recorded in the runlog sidecar, and the running total
prints after each instance, so a sweep going hot is visible within minutes
rather than at the end.

**A budget-stopped sweep is PARTIAL.** It exits 3 and says so. Score it out of
the instances that actually ran — scoring it out of 50 counts every unrun
instance as unresolved and silently understates the model.

## Notes that cost time if ignored

- **Disk.** Every instance pulls a different 1-2 GB image.
  `SWEBENCH_PRUNE_IMAGES=1` is required for a run of this size; without it the
  disk fills and the run dies partway, after spending on the instances it did
  complete.
- **Gold-validate first.** Some instances fail their own gold patch in a given
  environment (`psf__requests-863` did, and was swapped out of the 3-instance
  gauge for exactly this).
- **Re-score a single FAIL before believing it.** The older requests/flask-era
  instances contain live-network tests; the 3-instance gauge had a patch marked
  FAIL that was RESOLVED on a re-run of the byte-identical patch.
