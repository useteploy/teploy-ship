# Open founder decisions — 2026-10-04

The single list of decisions only the owner can make, with the context each
one needs. Everything else open is in [NEXT_SESSION.md](../NEXT_SESSION.md).
When a decision is made, record it here and in the programme row it affects.

## 1. Model-routing data gates (OPEN)

**The architecture is right; one fact is missing.** The routing layer gates
candidates on data class before any model choice: `private` data may only
go to a destination the task allows AND whose declared retention is `none`
(`internal` allows `short`, `public` allows `long`; unknown is treated as
the strictest). This is the standard governance pattern for LLM gateways
and fail-closed by design — it is working as intended, not a defect.

The routing shadow (live since 2026-10-04) records on every run:

> `refused: zai/glm-5.3: api.z.ai (hosted) is not a permitted destination
> for private data` (fixed by `SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai`)
> `refused: zai/glm-5.3: retention unknown exceeds none` (still refusing)

This is honest: every run today already sends private-repo data to z.ai via
the gateway — the shadow makes that explicit instead of implicit.

**The open fact:** what the z.ai coding-plan endpoint actually retains
(their terms/privacy policy — a lookup, not an engineering slice).

**The decision, once the fact is known:**
- If retention is effectively none: set `retention: "none"` in
  `/srv/ship-config/routing-policy.json` on infra-home (operator assertion
  with the terms cited in this file), and the shadow selections go clean.
- If retention is unclear/lasting: keep the refusals recorded (routing `on`
  stays blocked for private data) and treat hosted routing as
  internal/public-data only.

## 2. S12 browser harness — D07 (OPEN)

The last undecided design call (deferred as D07). Options: keep the current
harness approach and scope remaining S12 browser/interactive work on it, or
run a short evaluation slice of harness options first and then build. S12
remains the least-started package; nothing blocks on it.

## Decided 2026-10-04 (context)

- **S02 batch**: A-only via the coding-plan key ($0 real); B deferred.
- **S28**: percentile gate n>=20 confirmed.
- **S25**: service accounts stay id-only in policy inheritance.
- **S08**: PR-body + webhook surfacing approved — built in wave 5 (#63),
  flag `SHIP_TEST_INTEGRITY_SURFACING`, default off.
- **S10 UI**: the 79 sub-24px compact targets stay.
- **Shadows**: shadow-first approved and live (budget-reservation,
  model-routing, policy, tool-manifest, knowledge-provenance; safe-fetch
  defaults to shadow). Routing shadow findings to date: the plain-HTTP
  forge allowlist (fixed: `SHIP_SAFE_FETCH_ALLOW`), the destination gate
  (fixed: `SHIP_MODEL_ROUTING_DESTINATIONS`), and the retention gate
  (decision 1 above).
- **omni-analyst scheduler**: stopped again after a reboot revived it;
  restart policy disabled (a future `compose up` of that stack may re-enable
  it — check on sight).
