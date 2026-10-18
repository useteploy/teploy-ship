# Open founder decisions — 2026-10-04

The single list of decisions only the owner can make, with the context each
one needs. Decisions 4–20 are listed (all decided as of 2026-10-17) in the programme's "End state and
execution backlog" section (E6); everything else open is reached from
[NEXT_SESSION.md](../NEXT_SESSION.md).
When a decision is made, record it here and in the programme row it affects.

## Decided 2026-10-17 (owner delegated: "decide what is best, choices for users where there should be")

Principle: Ship is self-hosted by other people, so anything that depends on a
deployment's risk appetite, vendor terms or hardware is a **setting with a safe
default**, decided by that deployment's admin. Anything that is a security
floor is **not** a setting. Owner instance values are listed where they differ.

- **Decision 5 (G1 and S02 spend): no paid API spend.** G1's Ship arm runs on
  the z.ai coding plan (no marginal cost); the T3 Code arm runs on the owner's
  existing subscriptions, as daily use does. The S02 B leg stays deferred until
  a held-out set exists (Q7).
- **Decision 6 (remote MCP servers and private data): inherit the routing
  data-class gate.** A remote MCP server receives `private` data only if its
  declared destination has `retention: "none"` in the routing policy.
  User choice: per-project MCP server allowlist with declared retention
  (admin-editable); the gate itself is a floor.
- **Decision 8 (Windows/macOS/mobile targets): stay deferred.** Linux desktop
  (C5, headless Sway) comes first; revisit after G1.
- **Decision 10 (first auto-merge window): teploy-ship, docs and test-only
  change classes only.** Real traffic, low blast radius, and revert tracking
  starts. Every other class keeps the merge park. User choice: auto-merge
  windows are per project and per change class (already a project setting).
- **Decision 11 (subscription logins on a server): a per-deployment admin
  setting, default off.** API-key credentials are the default path for every
  harness. An admin may enable subscription logins per agent after an in-app
  notice that the vendor's terms are theirs to accept. Cursor's login mints an
  API key and counts as a key. Owner instance: API keys first; subscription
  logins only if a vendor's terms clearly allow server use.
- **Decision 12 (unsigned sources): no auto-launch, not a setting.** Rules on
  sources without a real signature (Datadog, legacy Sentry, plain-token
  GitLab) may propose tasks but never launch them unattended. A spoofable
  source must not spend money or open PRs on its own.
- **Decision 13 (incident remediation): explicit approval in v1.** EV8 later
  adds a per-project policy (high confidence, small change, exact attribution)
  as a user choice, default off; it still plan-parks.
- **Decision 14 (Observe receivers): retire `/hooks/observe`** once the
  incident intake path is proven live; one receiver per sender.
- **Decision 15 (latency target):** follow-up median time to first token
  <= 20 s and >= 3x faster than a cold start; re-frozen after the D4-a
  baseline. Internal target, not a setting.
- **Decision 16 (warm threads): deployment settings with defaults** —
  `SHIP_WARM_THREAD_TTL_SEC` default 7200, at most 5 thread snapshots per
  project per host. Admins size them to their disk.
- **Decision 17 (repository skills): per-project `repoSkills: allow | record
  | deny`, default `record`** (load and record what was loaded). `deny`
  refuses harnesses that cannot disable repo skills (claude-code today).
- **Decision 18 (credential proxy):** credential delivery hardening (H1) now;
  a credential proxy is designed with the credential store (H2). Not a setting.
- **Decision 19 (interrupted external runs): end `cancelled`** with their
  effects recorded.
- **Decision 20 (Antigravity image): build on demand only.** It is an
  optional image an admin can pull; not in the default image.
- **User-facing choices this round adds** (all per project unless noted):
  harness and model; delegate target allowlist (`SHIP_DELEGATE_TARGETS`
  deployment-wide, narrowed per project); event rules and their
  propose/auto policy; recordings on or off; skills enablement; warm-thread
  TTL and caps (deployment); subscription logins (deployment).

## Decided 2026-10-16 (owner, relayed in session)

- **Decision 9 (private-data destination): DECIDED — the z.ai coding plan
  may receive `private` data.** This supersedes Decision 1's refusal. Applied
  the same day on infra-home: `/srv/ship-config/routing-policy.json` sets
  `retention: "none"` on every `api.z.ai` candidate, version
  `2026-10-16.1-decision9-zai-retention-none` (validated with the repo's
  `loadRoutingPolicy`; previous file kept as `routing-policy.json.bak-2026-10-16-pre-d9`).
  Basis: the 2026-10-04 terms lookup below (DPA §4(b), Privacy Policy §3/§5).
  Re-check trigger: any z.ai privacy-policy date bump (checked 2025-09-29).
  Unblocks Q9 (routing `on`), Q1 on private repositories and remote MCP
  servers (D1) for z.ai destinations; other remote destinations still need
  their own retention entry.
- **Decision 4 (second sandbox host): DECIDED — use the existing compute-2.**
  Ship was wired to compute-1 only (`SHIP_SANDBOX_URL` held one host);
  compute-2 (3 vCPU, 7.8 GB, Debian 13) was idle on the tailnet. It gets the
  same teploy-sandbox daemon, token, gVisor runtime and egress rule as
  compute-1, then joins `SHIP_SANDBOX_URL`.
- **Decision 7 (Slack/Linear): DECIDED — not wired for the owner.** Tyler
  does not use Slack or Linear; they are features for self-hosting users. B6
  becomes "prove the intake end to end with signed payloads and document the
  user setup", not a live workspace connection.

## Decided 2026-10-15 (owner, relayed in session)

- **Decision 3 (S12/D4 image routing — the screenshot class): DECIDED —
  route pixel screenshots in ship's future image mode to `glm-5.3-flash`
  on the z.ai coding plan.** Evidence: a live decode test this date
  (2026-10-15) — a red-square PNG was answered "Red" through the plan's
  flash model. This AMENDS the 2026-10-05 hosted-routing refusal (Decision 1
  below) **for the screenshot class only**; private non-image data keeps the
  refusal and the fail-closed gate. Anthropic/OpenAI remain the proven
  end-to-end fallback (`evals/receipts/2026-10-14-image-path-e2e.txt`).
  Revisit if dense-detail tasks need a larger model.

## Decided 2026-10-05 (owner, relayed in session)

- **Decision 1 (model-routing data gates): DECIDED — do NOT assert
  `retention: "none"`.** Owner call: when in doubt, don't send the data.
  The z.ai destination keeps its refusal for `private` data (the terms
  evidence in the 2026-10-04 lookup below stays recorded for a future
  revisit if z.ai ever ships explicit coding-plan retention wording);
  hosted routing remains `internal`/`public`-data only. No policy change
  on infra-home — the fail-closed gate is the decision.
- **Decision 2 (S12/D07): DECIDED — keep the current browser harness,
  skip the evaluation slice** (accepts the recommendation below). Re-open
  D07 only if the first S12 interactive milestone lands and the harness
  measurably fights the work.

## 1. Model-routing data gates (DECIDED 2026-10-05 — see top of file)

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

## 2. S12 browser harness — D07 (DECIDED 2026-10-05 — see top of file)

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
