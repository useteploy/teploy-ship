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

Resist doing two at once in one sweep. The urge is strong and it costs the ability to
say which fix bought what.

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
