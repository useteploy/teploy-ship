# Perception and harness interactivity — input to S12/S13 (2026-10-14)

An input document, not a second plan: the forward plan stays in the release
programme. This records one review round (two independent delegated reviewers,
plus an enumeration of a commercial harness's orchestration surface and code
verification of every load-bearing claim), so S12/S13 can be executed against
settled facts instead of re-derived ones. Claims are code-verified unless
marked otherwise.

## 1. What exists today (verified in this tree)

- **Browser plumbing.** `images/sandbox-node/Dockerfile` bakes Debian Chromium
  plus a pinned Playwright (`ARG PLAYWRIGHT_VERSION=1.63.0`, `CHROMIUM_BIN` on
  PATH). The visual and flow rungs (`src/ladder-steps.ts`) run an agent-written
  `.ship/flow.mjs` against the preview and attach PNGs/WebM to the PR
  (`evals/receipts/2026-09-24-browser-final-image.txt`). `src/takeover-browser.ts`
  is the human console — restart-per-op **by design** (its header says so),
  which is right for a person and wrong for an agent loop.
- **Steering and conversation primitives.** `src/steer.ts` (turn-keyed,
  idempotent, drained at the top of every turn), `src/ask.ts` (operator
  question park), follow-up runs (`parentRunId` / `taskRootRunId` in
  `src/task-session.ts`).
- **Schedules.** S16 `src/workflow-schedules.ts`: interval and DST-safe `at`
  slots, missed-run and overlap policy.
- **Placement.** `src/execution-target.ts` already models
  `BrowserSupport = "none" | "headless" | "headed"` and a `desktop` flag —
  the admission seam a browser run needs.
- **The image wire path is complete upstream.** `neutron-ai/src/types.ts:39`
  defines `ImagePart`; `UserContentPart = TextPart | ImagePart`;
  `anthropic/index.ts:403` maps it to Anthropic image blocks and
  `openai/index.ts:354` to `image_url` data URLs. teploy-gateway preserves
  unknown fields byte-for-byte via `json.RawMessage`
  (`internal/gateway/proxy.go:104-107`). Nothing between a sandbox screenshot
  and the model is missing except this repo's loop.
- **Sandbox groundwork.** teploy-sandbox sizes `/dev/shm` for Chromium
  (`SBX_SHM_MB`, default 512 — `main.go:109-111`, `internal/run/runtime.go`),
  with `--init`, pids limit, and `no-new-privileges`.

## 2. The actual gap

The loop is **blind**: observations are strings only (`src/agent.ts`,
`src/durable.ts` never build `ImagePart`), the agent has no interactive browser
session, and the external harnesses declare `browser: refused` and
`steering: refused` (`src/harness-capabilities.ts` — native is
`browser: partial`, offered only when `verification.preview` is configured).
Two unproven paths: Chromium through the sandbox's authenticated egress proxy
(the per-run credential rides the proxy URL userinfo, `teploy-sandbox
internal/egress/pool.go:147`; Chromium does not apply env-proxy userinfo, so a
naive launch expects 407 — unverified live), and image content through the
gateway against a real provider (each half is verified; the pair is not).

## 3. Design decisions proposed for S12/S13

- **D1 — the browser lives in the run's own sandbox.** A background
  `chromium --remote-debugging-port` inside the ephemeral container, driven over
  CDP; it dies with the container (zero cross-run state, colocation intact,
  evidence local). No Xvfb: `--headless=new` covers repo-bound web work; a
  real desktop session stays out of scope (S26's `desktop` is the honest
  refusal). The takeover browser remains what it is; the agent loop gets a
  different, persistent-session driver.
- **D2 — one minimal action, text-first.** Extend the CodeAct enum with
  `look`: return the **accessibility tree / DOM text** as the primary
  observation and a screenshot as the optional second stage. An a11y tree is
  text — it flows through existing redaction, needs no vision model, and costs
  a fraction of the tokens (the 2026 convention: DOM-level tools first, pixels
  only when nothing else can answer — Playwright MCP made accessibility-tree
  snapshots its default for exactly this reason). Screenshot mode is gated
  separately (D4). Recorded-result replay, native-loop style; browser-step cap
  and a vision/image budget; image history pruned to the last N observations.
- **D3 — the browser rides the per-run egress proxy, never beside it.** The
  driver launch passes explicit `proxy:{server,username,password}` (never env
  userinfo). Rules: `allowlist` tier default; `open` tier plus a browser
  requires plan review; the forge allowlist entry must be port-scoped so a
  sandbox browser cannot reach ship's own dashboard/approval surface on the
  control-plane host; DNS-over-HTTPS, websockets and WebRTC checked in the
  live proof.
- **D4 — data-class-aware image routing (owner gate).** Screenshots default to
  the strictest data class. Current owner policy (2026-10-05: hosted routing
  internal/public-data only; z.ai refused for private data) leaves private
  screenshots with no permitted hosted destination. Options for the owner:
  class seeded-preview screenshots `internal`; pursue a zero-data-retention
  agreement; or keep pixels local/public-only. The opencode-with-own-z.ai-key
  path is a side door around that decision and must be closed or recorded as
  an accepted exception. Image artifacts carry data-class tags and are never
  attached to PRs on repos that mirror publicly.
- **D5 — steering is ship-native; everything else is a client.** The
  conversational surface is the run page + HTTP API over the existing steer /
  ask / follow-up primitives. External harnesses gain parity via session
  resume (see §5). A ship MCP lets other tools steer runs; any business-OS
  integration is a pass-through client that never paraphrases steer text.

Rejected alternatives (from the review round, with reasons): a shared browser
service or CDP proxy on the compute host (cross-run state, egress leaves the
per-run allowlist, renderer exploit crosses runs, CDP is a full control
protocol); hosted remote browsers (DOM and screenshots leave the fleet,
against the retention stance; public-class research only); Xvfb/desktop in the
sandbox (cost and attack surface for no benefit on repo-bound work);
perception via `claude-code`'s own Read tool (runs under `bypassPermissions`
with no park — stays `refused` until it can be governed); a standalone
perception service (state outside the run breaks evidence locality).

## 4. Reference: portable design decisions observed in a commercial harness

Enumerated from a live 2026 nightly's orchestration surface (tool catalog),
not from source. Listed where they map onto this repo's slices:

| Observed design | Maps to |
|---|---|
| Delegation results as first-class **context transfers** (transfer ids, status, merge-back into the parent) | S20/S22 coordinator — the delegation data plane |
| Lifecycle separates run status from `working / waiting-for-children / result-available`, plus settled and wake-early snooze states | follow-up chains, park UX |
| Ordered, cancellable per-thread message queue delivered when the run frees | steering backlog semantics |
| Stable `clientRequestId` idempotency keys on task create/cancel | intake dedupe |
| PR watching that wakes the orchestrator on checks/comments/conflicts | S16 event triggers |
| Browser UX: snapshot-before-interacting, explicit control-owner lease, session recording transferred once to an evidence file, console capture with source-mapped stacks | S12 — the console-with-stacks idea is directly reusable in the visual rung |
| Agent-facing secret request answered through a private card, single-use ref | MCP client path |
| Scheduler surface: per-task enabled/last-run-status, run-now, webhook-bound | S16 completion |

## 5. OpenCode v2 contract check (2026-10-14, local v2.0.26)

`opencode run --help` on v2.0.26, versus the invocation in
`src/harness-external.ts` (verified against 1.18.21 on 2026-08-24):

- **Removed: `--pure` and `--dir`.** The current adapter invocation
  (`opencode run --format json --auto --pure --dir . …`) prints usage and does
  not run on v2.0.26 (reproduced locally: the flag parse fails and help is
  printed). `images/versions.json` still pins the 1.x line, so production is
  unaffected today; S13 must either pin < 2 explicitly at preflight or adopt
  the v2 flags (drop `--pure`/`--dir`, run in the cwd, review what replaced
  `--pure`'s no-plugins isolation).
- **Added: `--session <id>` / `--continue` / `--fork`, `--standalone`,
  `--server`, `--agent`, `--file`, `--title`.** `--session`/`--continue` are
  the session-resume hook the external harnesses need for steering and
  follow-up parity (harness-capabilities currently refuses both for opencode
  because the adapter reads only the starting prompt). v2's JSON event shape
  is **unverified** — the 1.x `step_start/text/tool_use/step_finish/error`
  stream must be re-observed before any pin bump.

## 6. Acceptance proposed for the slices

- One **grader-authored**, browser-required product journey (the 12 scenarios
  in `evals/product-journeys/manifest.json` are all browser-optional today),
  with the standard mutant discipline and a negative control: an agent-written
  flow alone must not satisfy it. The agent authors claims; the grader owns
  the evidence.
- Capability table (`harness-capabilities.ts`) updated honestly per harness;
  advertised configurations pass their declared journeys and refuse
  unsupported operations (S13 acceptance as written).
- Injection fencing for page content in the prompt; artifact data-class tags;
  no image artifacts on public-mirror PRs (test-enforced); browser runs
  admitted through a resource class so the placement seam sees their real
  footprint.
- Owner gate before any pixel-screenshot routing: the D4 decision recorded.

## 7. Sequencing (proposed)

1. Live proofs: Chromium through the per-run proxy (allowlisted external
   host); image content end-to-end through the gateway; v2 event-shape
   observation if the v2 pin is pursued.
2. `look` slice (text-first) under S12, default-off, equivalence-tested.
3. Fences + grader-authored journey + mutants.
4. Steering surface (thread view, queue semantics) + external-harness session
   resume; ship MCP.
5. Resource classes wired to S26 placement; measure a real browser run before
   any capacity decision.
6. Coordinator work (S20/S22) after the above, on measured capacity.

Success metric (not a parity checklist): the share of repo-bound tasks
started here rather than in an interactive harness, and the human-intervention
rate, measured over a fixed window after the slices land.
