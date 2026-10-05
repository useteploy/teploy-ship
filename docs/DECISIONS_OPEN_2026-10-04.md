# Open founder decisions — 2026-10-04

The single list of decisions only the owner can make, with the context each
one needs. Everything else open is in [NEXT_SESSION.md](../NEXT_SESSION.md).
When a decision is made, record it here and in the programme row it affects.

## 1. Model-routing data gates (OPEN — terms lookup DONE 2026-10-04, awaiting operator assertion)

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

**The lookup (done 2026-10-04, sources cited):**

- **z.ai Data Processing Addendum for API Services, §4(b)**
  (docs.z.ai/legal-agreement/privacy-policy.md, appended DPA): "The Company
  do not store any of the content the Customer or its End Users provide or
  generate while using our Services. This includes any texts, or other data
  you input. This information is processed in real-time to provide the
  Customer and End Users with the API Service and is not saved on our
  servers."
- **z.ai Privacy Policy, §3 purpose table**: the "improve and develop our
  Services and conduct research … including when we train and improve our
  models" row lists account/communication/log/usage/device/cookie data —
  **User Content (prompts) is not among the training-purpose categories**;
  prompts appear only under "provide … the Services" (contract basis). §5:
  deleted conversations "will be removed immediately … and automatically
  deleted from our back-end."
- **GLM Coding Plan usage policy** (docs.z.ai/devpack/usage-policy.md) and
  subscription terms: no retention or training carve-out for the coding-plan
  endpoint; the plan is provisioned on the API platform
  (z.ai/manage-apikey/* console paths).

**Residual ambiguity (why this still needs the operator, not the agent):**
the DPA is framed for "business and enterprises users … through API
Services", and the coding plan is an individual subscription riding the API
platform's endpoint — no document states in words that the *coding-plan
endpoint specifically* retains nothing. The evidence is strong (API surface
= no content storage; the consumer policy never trains on prompt content)
but the seam between the two policies is exactly where a cautious reading
keeps the refusal.

**Recommended assertion (one line, when accepted):** in
`/srv/ship-config/routing-policy.json` on infra-home set the
`api.z.ai`/coding-plan destination to `"retention": "none"`, citing the two
clauses above, with a re-check trigger on any z.ai privacy-policy date
bump (current: 2025-09-29). Until asserted, the shadow refusals keep
recording — routing stays honest either way.

## 2. S12 browser harness — D07 (OPEN — recommendation recorded 2026-10-04)

The last undecided design call (deferred as D07). Options: keep the current
harness approach and scope remaining S12 browser/interactive work on it, or
run a short evaluation slice of harness options first and then build. S12
remains the least-started package; nothing blocks on it.

**Recommendation (agent, for the owner to accept or overrule): keep the
current harness; skip the evaluation slice.** Rationale: nothing blocks on
S12, so the only thing the eval buys is optionality; the eval itself costs
a full session; and any harness shortcoming will announce itself in the
first S12 interactive milestone, at which point a *targeted* swap is better
informed than an upfront bake-off. Re-open D07 only if that first milestone
lands and the harness measurably fights the work.

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
