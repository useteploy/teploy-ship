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
    SWEBENCH_THINKING_TOKENS=4096 \
    AI_GATEWAY_URL=https://api.z.ai/api/anthropic \
    AI_GATEWAY_KEY=<z.ai coding-plan key> \
    SWEBENCH_MODEL=glm-5.2 \
    node swebench/run-inference.mjs <ssh-host> \
      swebench/instances-lite-50.json swebench/preds-glm52-50.json

Verified against the live coding-plan endpoint 2026-08-12: `glm-5.2` is a real
model id (`glm-5` aliases to it; `glm-5.2-max` does not exist), `cache_control`
is ACCEPTED so `SWEBENCH_NO_CACHE` is not needed, and `thinking` blocks come
back populated. Use the CODING PLAN key against `/api/anthropic` — the standard
z.ai API is a different base path and a different product.

The predictions file records `model_name_or_path` as `teploy-agent+<model>`, so
two runs stay distinguishable when scored.

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
