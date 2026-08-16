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

The predictions file records `model_name_or_path` as `teploy-agent+<model>`, so
two runs stay distinguishable when scored.

## Knobs

| env | default | why |
|---|---|---|
| `SWEBENCH_MAX_STEPS` | `40` | 28/50 runs hit 40 on 2026-08-12. OpenHands runs ~100. Default is left at 40 on purpose — see attribution below. |
| `SHIP_FINISH_WHEN_SETTLED` | off | offer a settled agent a finish instead of spinning to an abort. Read the caveat in run-inference.mjs: it reaches most runs, not just aborts, so the score can move DOWN |
| `SHIP_CRITIC` | off | run the independent critic pass. **This is what makes a sweep the PRODUCT's number** — every figure published so far came from a barer loop than users run. Costs a second model call per finishing run |
| `SHIP_CODE_INDEX` | off | index each instance's checkout into Nucleus vectors and give the agent the ```search action. Requires `NUCLEUS_URL` + `SHIP_EMBED_URL` + `SHIP_EMBED_KEY` (it refuses to start without them) — read **Index arm** below first; this is the one knob that is not just an env var |
| `SHIP_EMBED_MODEL` | `ollama/nomic-embed-text` | embedding model id, provider-prefixed as the gateway routes it. Only read when `SHIP_CODE_INDEX=1` |
| `SWEBENCH_PRUNE_IMAGES` | off | required for any sweep; images are 1-2 GB each |
| `SWEBENCH_THINKING_TOKENS` | `0` | extended thinking budget, where the model supports it |
| `SWEBENCH_NO_CACHE` | off | disable prompt caching on compat endpoints that reject it |
| `SWEBENCH_MODEL` | `claude-sonnet-5` | model id |

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

The scored baseline is **35/50 (70.0%) with GLM 5.3 + thinking 32768, 2026-08-16** (previously 22/50 with GLM 5.2, whose model id z.ai has since retired). Two known
losses are being fixed, and they must be measured separately or the delta is
meaningless:

1. **Empty patches** — fixed 2026-08-15 (`putFile` now snapshots). Measured
   2026-08-16 and it rescued **0 of 50**; the fix is latent, not load-bearing.
2. **Step cap** — still 40, and now worth less than it looked: only 24% hit it
   at 5.3 and the median run stops at 33.5 steps. Measure with
   `SWEBENCH_MAX_STEPS=100` against 35/50 if you run it.
3. **Termination** is now the biggest lever — 30% of runs end in a thrash-abort.
   `SHIP_FINISH_WHEN_SETTLED=1` is the experiment.
4. **The critic** (`SHIP_CRITIC=1`) is the one that changes what the number
   MEANS rather than how big it is: without it, the published figure is not the
   product's. Run it once the cheaper knobs are settled.

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
