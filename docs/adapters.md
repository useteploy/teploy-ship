# Harness adapters — driving other coding agents

Ship is the control plane, not the agent. Since P5-1 the loop that edits the
tree sits behind one interface (`src/harness.ts`), and a run's harness is
recorded in its input at enqueue, exactly like every other capability:

```
SHIP_HARNESS=native        # default — Ship's own CodeAct loop (src/durable.ts)
SHIP_HARNESS=claude-code   # `claude -p`, headless, in the sandbox
SHIP_HARNESS=opencode      # `opencode run`, headless, in the sandbox
SHIP_HARNESS=codex         # `codex exec --json`, one-shot, in the sandbox
SHIP_HARNESS=gemini        # ACP agents (E7 H3) — gemini, grok, cursor, qwen —
                           # one generic adapter, gated on SHIP_ACP_HARNESS=on
```

What stays Ship's whichever harness runs: intake and policies, approvals,
the publish gate (screening, hard caps, refusal as a recorded step), the
evidence legs (suite, telemetry, preview), spend governance and attribution,
audit, and the replay contract. An external harness produces a working tree and
a claim; Ship records the claim and treats none of it as evidence.

The native loop stays the default (P5-5). It is the air-gapped option — it
needs nothing in the sandbox image but a shell — and it is the measured
baseline the adapters are compared against.

## How an external attempt runs

Two recorded steps, both of which always record a value:

1. `harness-preflight` — is the binary on PATH in the sandbox image, which
   version, and is that a version this adapter can drive. A missing binary is
   a recorded `error` result; nothing runs. A version the adapter cannot
   drive is the same shape: an opencode **past the 2.x line is refused**
   (1.x and 2.x are measured contracts; a 3.x would be a guess — and the
   measured failure mode of guessing at this binary's flags is silence: v2
   silently under-counted turns and hid tool activity from the live feed
   under the v1 parser, which is why the 2.x contract was measured before it
   was driven, in `evals/receipts/2026-10-14-opencode-v2-events.txt`). A
   minor drift from the pin is recorded, not enforced — only a known-
   incompatible line refuses.
2. `harness-run` — one `exec` in the sandbox: the prompt is written to
   `.teploy-agent/harness-prompt.md` (git-excluded), the forwarded credentials
   travel in that exec's own env (the sandbox daemon passes them to the
   command through a private `--env-file`; never a file in the workspace,
   never argv; a multi-line value rides base64 under `SHIP_B64_<NAME>` and is
   decoded in the shell), and the binary's event stream is parsed when it
   exits. Every forwarded value, and the run's forge token, is replaced by
   `[redacted NAME]` (also in base64 form) in the binary's stdout and stderr
   before parse, record and the live feed. Values shorter than 8 characters
   are not scrubbed, since they would match ordinary output.
   The recorded step carries exit code, status, summary, turn count, usage,
   the NAMES of the forwarded variables (never values), a stderr tail and —
   since the contract-2 adapters — the **vendor session id** the run drove
   (claude's `session_id`, opencode's `ses_…`), which is what steering
   resumes.
3. `harness-steer-N` / `harness-resume-N` — only when the run's input asked
   for steering (`steer: true`, set at enqueue like every capability): after
   each vendor process exits, pending operator notes are drained as a
   recorded step, and if any are pending they are delivered as ONE more exec
   that resumes the recorded session — `claude --resume <id>` or
   `opencode run --session <id>` — each note framed the way the native loop
   frames it ("Operator steering — adjust course accordingly: …"). A
   "turn boundary" for an external harness is therefore a process exit: the
   sandbox exec API is request/response, so notes that arrive while the
   vendor runs are delivered by the next process. Bounded
   (`STEER_ROUNDS_MAX`: a steered attempt runs `1 + STEER_ROUNDS_MAX` execs at
   most — the main run plus that many resumes); the loop stops on its own
   when no notes are pending or a resume failed or timed out. Each resume is
   given only the REMAINING `--max-turns` / `--max-budget-usd` (the cap minus
   what the recorded steps already spent); with none left the note is
   refused on the record and no process starts. The attempt keeps the main
   run's status unless a resume completed successfully, a resume's summary
   is appended to (never substituted for) the original, and each round
   resumes the latest session id the previous exec reported. A closing
   `harness-steer-undelivered` step drains whatever the loop never read
   (notes that arrived during the last allowed resume or while the publish
   gate ran) and the notes whose delivery was refused or failed; they are
   recorded as "not delivered" in the run output and the thread, and the
   run page refuses new notes once that step has run. A run whose adapter
   contract is 1 records none of these steps (see `HARNESS_ALIAS_VERSIONS`:
   runs recorded under `claude-code@1` / `opencode@1` replay under an alias
   of the same adapter with the steer loop off). The steps are input-gated in the step fingerprint,
   so a run enqueued without `steer` keeps the exact two-step sequence every
   earlier external log carries, and a replay walks the recorded rounds
   without starting a vendor process.

   Two caveats. (1) A run recorded under the `opencode@1` alias that has not
   yet reached its preflight step (queued, or the worker restarted before it)
   executes on the v2 line when the worker's binary is 2.x: the alias fixes
   what a REPLAY reads, not what a first execution runs. Replay of recorded
   steps is unaffected. (2) Unpriced spend is not treated as zero: when a run
   has a dollar cap and its spend so far is unpriced (opencode on a model it
   cannot price), a steering resume is refused on the record rather than run
   uncapped. Subscription runs (claude with an OAuth token, codex) have no
   dollar flag and stay bounded by their turn limit. External runs take plain
   steering only; queued messages and interrupts (D2) are refused for them,
   since the adapter never claims held notes.

The recorded step is the exit — one step, one result — but the run is not a
blank while it executes: on a sandbox executor the exec is streamed
(`execStream`, durable.ts, over the daemon's SSE), the harness's event stream
is read line by line as it arrives, and the run page's **Now** card shows the
turn count and the last tool call (`Edit src/parser.ts`, `bash pnpm test`)
as they happen (`src/live.ts`). None of that is evidence and none of it is
recorded: a replay returns the step's result without re-running the binary
and writes no live row. A whole-attempt deadline bounds the exec
(`SHIP_HARNESS_TIMEOUT_MS`, default 30 minutes); a timeout is a recorded
error, and whatever tree exists goes through the publish gate as incomplete.

The external harness must reach its model vendor, so the run needs the
`allowlist` tier (the default) or `open`. Since 2026-10-17 the vendor host
itself is derived at enqueue from the same forwarded env the harness will
read (see "Egress for external harnesses" below) and added to the run's own
`sandboxEgressAllow` — the repo's own list (Projects page, or `teploy-ship
project set <repo> --egress-allow api.z.ai:443`) widens nothing else on the
box and stays for hosts the derivation does not cover; host-wide there is
`SBX_EGRESS_ALLOW` on teploy-sandbox. The binary has to be in
`SHIP_SANDBOX_IMAGE`. The image is not checked at enqueue — a run asking for a
harness the image lacks fails at preflight, on the run's own timeline, with the
build command in the message.

Build an image that carries it with `images/build.sh --harness <id> go` (or
`node`). The binary is **baked** at the exact version pinned in
`images/versions.json`, never installed per run: a run-time install would need
egress the sandbox is not otherwise given, and would let the binary drift under
a running worker — and `selectAdapter` refuses to replay a run under a harness
version its log did not record.

## Configuration

| variable | meaning |
|---|---|
| `SHIP_HARNESS` | `native` (default), `claude-code`, `opencode`, `codex`. The worker-wide default; a project record's `harness` field wins for that repo. Read at enqueue on every surface (CLI, dashboard, webhook, sweep); recorded on the run. |
| `SHIP_HARNESS_ATTEMPTS` | Comma list of harness ids. When it names two or more, every new run tries each in its own workspace and the critic picks one to publish (P5-4). Off by default. |
| `SHIP_HARNESS_MODEL` | Model id passed to the harness (`--model`). Absent = the harness's own default. |
| `SHIP_HARNESS_MODEL_<ID>` | Per-harness override (`SHIP_HARNESS_MODEL_OPENCODE`, `_CLAUDE_CODE`, `_CODEX`; `-` becomes `_`), winning over `SHIP_HARNESS_MODEL` for that harness only. Model names differ in shape: claude on an Anthropic-compatible endpoint takes `glm-5.3`; opencode wants `provider/model` (e.g. `zai-coding-plan/glm-5.3`). |
| `SHIP_HARNESS_ENV` | Comma list of worker env var NAMES forwarded into the harness process. Overrides the per-adapter default below. |
| `SHIP_HARNESS_TIMEOUT_MS` | Per-exec deadline for each vendor process. Default 1800000. A steered attempt runs at most `1 + STEER_ROUNDS_MAX` execs (main + resume rounds), each bounded by this. |
| `SHIP_CLAUDE_BARE` | `1` adds `--bare` to claude: API-key auth only, no host context (hooks, CLAUDE.md, MCP). |
| `SHIP_HARNESS_CRED` | `on` enables the sealed per-project credential store and the enqueue gates (see the sealed-credentials section below). Only the exact spelling `on` counts; anything else, including unset, is off, and off is byte-identical to the pre-H2 behaviour. |

Default forwarded variables: claude-code `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`; opencode
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ZHIPU_API_KEY`
(z.ai, per models.dev), `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENCODE_CONFIG_CONTENT`; codex
`CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `AI_GATEWAY_URL`,
`AI_GATEWAY_KEY` (see the codex section for what the gateway pair does); the
ACP profiles gemini `GEMINI_API_KEY`, `GOOGLE_API_KEY`; grok `XAI_API_KEY`;
cursor `CURSOR_API_KEY`; qwen `DASHSCOPE_API_KEY`, `QWEN_BASE_URL` (see the
ACP section for how the pair is renamed into the exec — and why qwen never
touches the operator's `OPENAI_*` values). A variable that is unset on the
worker is simply not forwarded.

Per-repo evidence config (`teploy-ship evidence set`) is harness-independent
by design; the harness is chosen per deployment through the environment, not
per repo, so the two matrices never tangle.

## Egress for external harnesses

The native loop calls its model from the **worker**. An external harness calls
its model from **inside the sandbox** — the vendor binary runs there, so its
API traffic leaves through the sandbox's egress boundary, and on the
`allowlist` tier (the default) a vendor host that is not on the run's
allowlist means every model call dies with the daemon's
`egress denied by the sandbox allowlist: <host>`. That was a production
failure on 2026-10-17: a claude-code run under
`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` was refused
`api.z.ai:443` and the operator had to add the host to the project record by
hand.

Since that finding, `enqueueRun` derives the provider API hosts and adds them
to the run input's `sandboxEgressAllow` — materialised at enqueue like every
other capability, so replays boot the container the log was written under.
The derivation (`providerEgressAllow`, src/harness-external.ts) reads the
worker's own environment through the same forward list the harness will
receive (`externalHarnessConfig`):

- **A forwarded base URL wins**: the host of `ANTHROPIC_BASE_URL` (claude-code,
  and opencode when `SHIP_HARNESS_ENV` forwards it), `OPENAI_BASE_URL`
  (opencode, codex), `AI_GATEWAY_URL` (codex's teploy-gateway route) and
  `QWEN_BASE_URL` (qwen's ACP profile — never the operator's
  `OPENAI_BASE_URL`) — host only, port 443, or the URL's own port when it
  names one (a portless entry admits only 80 and 443, so `host:8443` is the
  only spelling that opens 8443).
- **Else the vendor default for a forwarded key**: `api.anthropic.com:443` for
  claude-code under `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`;
  `api.openai.com:443` for codex under `CODEX_API_KEY`/`OPENAI_API_KEY`; for
  opencode, `api.z.ai:443` when `ZHIPU_API_KEY` is forwarded **and** the model
  (`SHIP_HARNESS_MODEL_OPENCODE`/`SHIP_HARNESS_MODEL`) starts with
  `zai-coding-plan/` or `zhipu`, plus `api.anthropic.com:443`,
  `api.openai.com:443` and `openrouter.ai:443` under their matching keys.

Deliberately NOT derived: subscription credentials. claude under
`CLAUDE_CODE_OAUTH_TOKEN` and codex under `CODEX_ACCESS_TOKEN` dial a vendor
host too, but which host is the vendor's own routing — guessing a host onto a
security allowlist from a token Ship cannot read through is not this
derivation's call. Those deployments put the host on the project record
(`teploy-ship project set <repo> --egress-allow api.anthropic.com:443`) or on
`SBX_EGRESS_ALLOW` at the daemon. A base URL that is set but unparseable also
derives nothing — and still suppresses the vendor default it replaces,
because the harness will dial the configured URL, not `api.*`.

Under `SHIP_HARNESS_CRED=on` one more source is derived, for opencode only:
the provider `baseURL`s an `OPENCODE_CONFIG_CONTENT` blob declares (its
hosts, port 443). Flag off the blob derives nothing, exactly as before. A
blob that is not JSON derives nothing here and is refused at the enqueue
gate by name (`harness-config-unparseable`) rather than judged half-read.

Merge semantics (`withProviderEgress`): hosts only, port 443, de-duplicated,
appended after the project's own entries, which always survive. A derived
`host:443` is skipped when the explicit list already carries the bare host (a
portless entry admits 443). If the merged list would fail validation or pass
the daemon's 64-entry bound, the derived entries are dropped rather than the
enqueue refused — the same discipline the preview hosts follow
(`withPreviewEgress`, deploy.ts). Each attempt's hosts are derived from that
attempt's OWN env overlay (`SHIP_HARNESS_CRED`): a credential sealed for one
profile never reroutes another profile's derivation by env-name collision.

The fence: nothing is derived for native runs, or for an external run with
nothing derivable, and those inputs are byte-identical to what this build's
predecessors recorded. The field admits no recorded step, so no step
fingerprint moves — the upgrade fence treats it as data, not behaviour.

`teploy-ship doctor` prints what this machine's `SHIP_HARNESS` configuration
derives as the `harness-egress` line — pass with the host list, or UNKNOWN
with the remedy when an external harness is configured but nothing can be
derived from the forwarded credentials.

## Sealed harness credentials (H2, `SHIP_HARNESS_CRED=on`)

The deployment environment is one way a harness gets its API key — and until
H2 the only one: every project on a worker shared every key the worker held.
The sealed credential store is the other way: an operator with the `policies`
grant stores a key against ONE project and ONE harness profile on the
project's page (Project settings → Harness credentials), it is sealed at rest
with the same `SHIP_CONFIG_KEY` material as the runtime config's sealed keys,
and only presence is ever shown — which name, when, who, which version. The
value is never rendered, never returned by an API, never recorded: the run
input carries a reference (project, profile, env name, version) and the
worker unseals it into the same exec-env delivery H1 built, where the
exact-value scrub covers it like any forwarded secret. A stored value wins
over the deployment environment for its name. Storing is refused while
`SHIP_CONFIG_KEY` is unset — a plaintext key in the state store is strictly
worse than the env var it replaces.

The flag also turns on two enqueue gates, both fail-closed and both refused
by name before any run exists:

- **Presence.** A profile that authenticates with a credential (the
  credential-shaped names on its forward list — e.g. claude-code:
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`)
  finds none of them in the deployment environment or the store → the
  enqueue is refused (`harness-credential-missing`).
- **Data destination.** Every provider host the harness will dial — derived
  exactly as the egress section describes, from the env overlaid with the
  store's unsealed values, so a base URL in the store routes the check where
  the run dials — must be declared in the routing policy
  (`SHIP_MODEL_ROUTING_POLICY`) and permitted for the deployment's data class
  (`SHIP_MODEL_ROUTING_DESTINATIONS`, `SHIP_MODEL_ROUTING_DATA_CLASS`;
  `checkDestinationHost` applies the same destination/retention gates
  delegate targets answer to). A credential whose host cannot be derived — a
  subscription token — is refused (`credential-destination-unknown`): per
  Decision 11 API keys are the default path, and subscription logins are a
  later, explicitly opted-in slice (H7). Under the flag the destination set
  also covers what nothing else can read: an `OPENCODE_CONFIG_CONTENT` blob
  is judged in full — provider `baseURL`s, the provider `api` field,
  providers with a key but no baseURL (known provider ids derive their
  default host), remote MCP `url`s, remote `instructions` URLs — and
  anything in it that cannot be derived exactly is refused: not JSON
  (`harness-config-unparseable`), a run-time `{env:}`/`{file:}`
  substitution, a bedrock/vertex api, an npm provider package, an unknown
  provider default, a local MCP server, `share` other than `"disabled"`,
  legacy `autoshare`, or `plugin`
  (`harness-config-destination-unreadable`) — never guessed at. A
  `SHIP_HARNESS_ENV` addition is permitted only on an explicit allowlist of
  destination-free knobs; proxy overrides, config-file pointers and
  cloud-provider switches (Bedrock/Vertex) are refused by name
  (`harness-env-forward-refused`) — forward a base URL the derivation reads
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AI_GATEWAY_URL`, as fits the
  harness) and its host is judged like any other.

Delivery is BY REFERENCE for every binding the gate's overlay carried,
credential-shaped or not: a stored base URL or config blob reroutes the dial,
so the worker unseals it into the exec env too (`forwardEnv`, with its
exact-value scrub and the `SHIP_B64_` carrier) — the environment the harness
executes with is exactly the environment the gate judged. References are
delivered only to the profile they were sealed for: with
`SHIP_HARNESS_ATTEMPTS=codex,opencode`, an `OPENAI_API_KEY` stored for codex
never reaches the opencode attempt by name-collision. A binding rotated
after enqueue is delivered at its current value, and the `harness-run` step
records a `credentialRotation` note saying which version moved — rotation is
allowed, silent substitution is not. Versions never restart: a clear leaves
a tombstone (no ciphertext, the version kept), the file store computes the
next version inside its per-path lock, and the Nucleus store claims each
(binding, version) slot through the KV's atomic `setNX`, so two stores of
one binding can never mint the same version.

The worker re-judges the destination too: the enqueue gate saw the
enqueuing process's env, the exec uses the worker's. The approved host set
is recorded on the input (`harnessDestinations`), and the `harness-run`
step re-derives the hosts from the env it is about to deliver — refusing by
name (`harness-destination-changed`, a recorded refusal, the vendor binary
not started) when a worker's base URL, model, forward list or config blob
moved the dial somewhere admission never approved, or when the worker's own
routing policy cannot or will not permit the destination again.

The production ensemble this must not break is pinned by test: claude-code or
opencode rerouted to `api.z.ai` under a policy whose `api.z.ai` entry retains
nothing, with `SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai`, enqueues unchanged.
Flag off — the default — runs neither gate, records no reference, and
enqueues byte-identically to a pre-H2 build.

A reference the executing worker cannot resolve (the binding was cleared, a
worker with no store, a rotated `SHIP_CONFIG_KEY`) stops the attempt with a
recorded, named refusal on the `harness-run` step; the vendor binary is not
started.

One hardening applies with or without the flag: before anything leaves the
sandbox, the publish path and every thread/merge snapshot grep the workspace
for the exact credential VALUES the run forwarded (the value and its base64
form, never in the command line — the needle rides the exec env), and refuse
by name (`credential-material-in-workspace`) when one is found — an agent
that ran `env > x` must not publish or snapshot a key. Tuning values (a base
URL, the opencode config blob) are not scanned: their exact bytes can be
legitimate repository content.

## claude-code

Invocation (`src/harness-external.ts`):

```
IS_SANDBOX=1 claude -p "$(cat .teploy-agent/harness-prompt.md)" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions --max-turns <SHIP_MAX_STEPS> \
  [--bare] [--model <SHIP_HARNESS_MODEL>] [--max-budget-usd <SHIP_MAX_RUN_COST_USD>]
```

- `-p` / `--print` is non-interactive mode; `--output-format stream-json`
  emits one JSON object per line and the last is `{"type":"result",...}`
  carrying `subtype` (`success`, `error_max_turns`, `error_max_budget_usd`,
  ...), `is_error`, `num_turns`, `result`, `usage` (`input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)
  and `total_cost_usd`. `--verbose` is required for stream-json output.
  https://code.claude.com/docs/en/headless
- `--max-turns` limits agentic turns in print mode; `--max-budget-usd` stops
  at a dollar figure (print mode only); `--permission-mode` values include
  `bypassPermissions`; `--bare` skips host context and reads only
  `ANTHROPIC_API_KEY` (never OAuth). https://code.claude.com/docs/en/cli-reference
- `bypassPermissions` refuses to start as root unless `IS_SANDBOX=1`, which
  is why the command sets it: the sandbox image runs as root and is a sandbox.
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` (a subscription login for automated
  environments), or `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` routes through a
  proxy or gateway. https://code.claude.com/docs/en/env-vars
- `total_cost_usd` is a client-side estimate, not billing data.
  https://code.claude.com/docs/en/agent-sdk/cost-tracking
- **Steering (D7).** The stream's `session_id` (on the `result` event, with
  the init event as fallback) is recorded on the run step, and pending
  operator notes are delivered as further `-p … --resume <session_id>` execs
  at process boundaries — the CLI shape of the session-resume steering the
  T3 Code adapter does through the Agent SDK. The same flags as the main run
  (`--permission-mode bypassPermissions`, `--max-turns`, `--model`, budget)
  ride along, so a steered continuation is governed exactly like the run it
  continues.

Verified against Claude Code 2.1.243 on 2026-08-24: a one-turn `-p` run
under a subscription login still reports `total_cost_usd` (0.29 for a
"pong"), which is why Ship does not record it as spend under an OAuth token —
see cost honesty below.

## opencode

The adapter is **version-aware**: the preflight's resolved major picks the
invocation, and both lines stay driven.

**2.x (the pin since D6):**

```
opencode run --format json --auto --session ses_ship_<run>[:<attempt>] [--model <provider/model>] "$(cat .teploy-agent/harness-prompt.md)"
```

- `--pure` and `--dir` are GONE in 2.x (the 1.x invocation fails flag-parse
  there); there is no `--pure` replacement — plugin policy moved to config,
  and the sandbox remains the isolation boundary. `run` talks to a background
  service inside the ephemeral container; it dies with the container.
- `--session` is caller-chosen and deterministic (`ses_ship_<runId>`; the
  `ses` prefix is required — arbitrary ids are rejected despite the help
  text), so the id is a function of the run rather than a stream parse, and
  steering resumes exactly it. The session store lives on the container's
  disk, which is what makes one-shot resume work across execs.
- Events (measured against real 2.0.26 streams,
  `evals/receipts/2026-10-14-opencode-v2-events.txt`): `step_start` (carries
  `part.messageID` — turns count messageIDs, because…), `text` (the final
  text lands in the last one), `tool_use` (renamed from 1.x `tool`; part
  shape otherwise compatible), `step_finish` (TOOL STEPS ONLY — the payload
  is the 1.x shape: `tokens.{input,output,reasoning}`,
  `tokens.cache.{read,write}`, `cost`; a pure reply emits none, so a pure
  reply honestly records zero usage), `error` (richer fields, same role).
  Every event names the `sessionID`, which is recorded on the run step.
  https://opencode.ai/docs/cli/
- The npm package moved: the 1.x `opencode-ai` line ends at 1.19.3 and the
  2.x CLI is **`@opencode/cli`** — `images/versions.json` pins
  `@opencode/cli@2.0.26`, the exact build the receipt measured (2.0.32 was
  the line's latest when the pin was set).

**1.x (kept: an image that still bakes it keeps working until it is
rebuilt, and the runs it records replay unchanged):**

```
opencode run --format json --auto --pure --dir . [--model <provider/model>] "$(cat .teploy-agent/harness-prompt.md)"
```

- Events observed from opencode 1.18.21 on 2026-08-24: `step_start`, `text`
  (`part.text`), `tool_use`, `step_finish` (`part.tokens.{input,output,
  reasoning,cache.{read,write}}`, `part.cost`), `error`. There is no terminal
  result object; the process exits 0 on success and 1 on error. Ship takes
  the last `text` part as the summary and sums `step_finish` tokens.
  Source: `packages/opencode/src/cli/cmd/run.ts` in
  https://github.com/anomalyco/opencode
- No session id in the stream → **1.x runs cannot be steered**: a note that
  reaches one anyway (a 2-contract run on an old image) is consumed with a
  recorded delivery refusal, never silently dropped.

An **opencode past 2.x** is refused at preflight rather than driven on a
guess; the message names the pin and the receipt.

- Provider credentials are the provider's own environment variables
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) or an `OPENCODE_CONFIG_CONTENT`
  JSON. https://opencode.ai/docs/config/

fylun-code is an opencode overlay (a plugin), so it is driven through this
same adapter; nothing in it changes the headless contract.

**Steering (D6).** opencode v2 steering is session resume: notes queued while
a vendor process runs are delivered by the next `opencode run --session <id>`
exec. The capability table (`src/harness-capabilities.ts`) declares steering
supported — the admission gate additionally requires the run's recorded
harness contract to be 2 or later, so pre-D6 logs keep their refusal.

**Not yet proven in the image.** The opencode v2 invocation (flags, the
`@opencode/cli` package, `--session` resume across execs) is measured against
a real 2.0.26 binary on a workstation, not inside the sandbox image: it still
needs one real image build (`images/build.sh --harness opencode`) and one real
steered run on deploy-test before it is called proven. Until then treat v2 as
declared, not verified.

**Notes and the critic.** A note drained by an attempt that the critic then
rejects never reaches the published result: the attempt's tree and summary
are what is dropped, and so is the steering delivered into it. The note is
still on that attempt's record (and in the thread), but a rejected attempt's
work is not what ships.

**Pricing.** opencode v2 emits `step_finish` only on tool steps, so the
final text step carries no usage. A stream that names more model steps than
it finished is recorded unpriced (tokens kept as a lower bound, no dollars),
never priced-but-short.

## codex

OpenAI's Codex CLI, pinned at `@openai/codex@0.163.0`
(`images/versions.json`). Invocation:

```
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  [--model <SHIP_HARNESS_MODEL>] [--config <gateway provider, when AI_GATEWAY_URL is forwarded>] \
  - < .teploy-agent/harness-prompt.md
```

**Why `exec --json` and not `app-server`.** Codex has two programmable
surfaces. `codex app-server` is a long-lived JSON-RPC server over stdio —
you spawn it, `initialize`, `thread/start`, `turn/start`, and then read
notifications (`item/completed`, `thread/tokenUsage/updated`, ...) while
writing further requests mid-flight. That needs an interactive stdin the
sandbox exec API does not have: Ship's exec is request/response (output
arrives when the process ends) and `execStream` is read-only chunked output.
The app-server shape exists for host applications that own a child process
with bidirectional pipes — T3 Code's driver
(`apps/server/src/provider/Drivers/CodexDriver.ts` in the upstream
reference), not a sandbox daemon. `codex exec --json` is the one-shot
headless mode built for exactly Ship's shape: one process, JSONL events on
stdout, a terminal `turn.completed`/`turn.failed`, prompt on stdin via the
`-` sentinel. One exec, parse at exit — the same contract as claude's
`-p --output-format stream-json`.

**Codex's own sandbox is bypassed, explicitly.** The single flag
`--dangerously-bypass-approvals-and-sandbox` sets approval policy `never`
and sandbox mode `danger-full-access`, and its own help text says it is
"intended solely for running in environments that are externally sandboxed"
(`codex-rs/utils/cli/src/shared_options.rs` at the pinned tag) — which a
Ship run is: the sandbox container IS the isolation boundary (disposable
filesystem, default-deny egress, no host access), the same reasoning as
claude's `bypassPermissions` under `IS_SANDBOX=1`. Running codex's nested
sandbox instead would stack a Landlock sandbox inside an unprivileged
container — not something Ship can guarantee is even available there — and
its `workspace-write` mode denies network egress by default, which would cut
off the model vendor the harness must reach.

**Event contract** (`codex-rs/exec/src/exec_events.rs` at the pinned tag;
the non-interactive docs at developers.openai.com/codex/noninteractive carry
the same shapes): `thread.started` (`thread_id`), `turn.started`,
`item.started`/`item.updated`/`item.completed` with `item.type` in
`agent_message` (`text`), `command_execution` (`command`,
`aggregated_output`, `exit_code`), `file_change` (`changes[]` of
`{path, kind: add|delete|update}`), `mcp_tool_call`, `web_search`,
`todo_list`, `error`; terminal `turn.completed` (`usage`) or `turn.failed`
(`error.message`); a bare `error` event is fatal. Ship records the last
`agent_message` as the summary, counts completed `command_execution` items
and lists `file_change` paths (a claim by the harness, never evidence — the
publish gate diffs the tree itself), and reads usage from `turn.completed`:
`input_tokens` and `output_tokens` include cached input and reasoning output
respectively (the vendor's own accounting; T3's
`CodexTurnTokenUsage.ts:164` reads them the same way), so `totalTokens` is
their sum. **The thread id is durable**: `thread.started`'s `thread_id` is
recorded on the `harness-run` step, so a log can name the vendor session
(`codex exec resume <id>` continues it) without re-running anything.

**Cost honesty.** `codex exec` reports tokens and never dollars — there is
no `total_cost_usd` equivalent anywhere in the exec stream. So every codex
run is `priced: false` with its tokens recorded: counted in the unpriced
ledger, not the dollar one (P5-3). Under `CODEX_ACCESS_TOKEN` (the ChatGPT
subscription path) that is exactly right; under an API key a bill exists but
Ship has no honest figure for it, and $0 would be the wrong answer.

**Credentials.** `CODEX_API_KEY` is what OpenAI documents for non-interactive
use (set for the invocation, not the job — a rule Ship's env-file forwarding
already follows); `OPENAI_API_KEY` is the older spelling; `CODEX_ACCESS_TOKEN`
carries a ChatGPT access token for subscription-fed runs.

**Routing through teploy-gateway.** When `AI_GATEWAY_URL` is among the
forwarded variables (it is, by default, when set on the worker), the command
additionally declares a `teploy-gateway` model provider and selects it:

```
--config 'model_providers.teploy-gateway.name="teploy-gateway"'
--config "model_providers.teploy-gateway.base_url='$AI_GATEWAY_URL'"
--config 'model_providers.teploy-gateway.env_key="AI_GATEWAY_KEY"'
--config 'model_provider="teploy-gateway"'
```

The URL expands inside the sandbox from the exec's env, so the
command Ship builds names the variable, not the deployment; codex reads the
key itself from `AI_GATEWAY_KEY` (`env_key`). One constraint to know before
relying on it: codex speaks the **Responses** wire API only — `wire_api =
"chat"` was removed upstream — so the gateway endpoint must be
Responses-compatible (`/v1/responses`). If your gateway only speaks chat
completions, point codex at OpenAI directly (`CODEX_API_KEY`) and leave
`AI_GATEWAY_URL` unset for codex runs (`SHIP_HARNESS_ENV` can exclude it).

**Steering is refused, and why.** Like the other external adapters, a codex
run reads only its starting prompt; a steer note has no channel into the one
exec that is the run step, so it is refused at the gate rather than stored
and ignored. Codex does have a continuation path — `codex exec resume
<session-id>`, and app-server's `turn/steer` mid-flight — but both need a
second interaction with a live process, which the sandbox exec API cannot
express. Follow-ups are the supported path; the recorded `thread_id` means a
future slice could resume the same vendor session if that ever changes.

**Version guard.** None yet: 0.163.0 is the first pin, minor drift is
recorded (`pinned: false` in preflight) rather than refused, and no measured
incompatible major exists. When one does, the adapter takes an opencode-style
refusal (`refuseVersion`) naming the pin and the receipt that measured the
break — the hook is already there. The event encoding the tests replay was
taken from the tagged source, not a live run; see
`evals/receipts/2026-10-16-codex-exec-json-contract.txt` for what was
verified and what still needs a live credential.

## ACP harnesses (E7 H3)

`SHIP_ACP_HARNESS=on` admits four more ids — `gemini`, `grok`, `cursor`,
`qwen` — all driven by ONE adapter (`src/harness-acp.ts`) over the Agent
Client Protocol. The flag gates **enqueue** only: a worker whose flag is off
still carries the adapters, so runs recorded under an on-flag worker replay
everywhere. Off by default.

The protocol constraint that shapes everything here: Ship's exec has no
stdin, and ACP is bidirectional JSON-RPC over stdio. So the whole session —
initialize, `session/new`, the prompt, streaming updates, permission
requests, cancellation — runs inside ONE exec via an in-sandbox driver,
`ship-acp` (baked into every image at `/usr/local/bin/ship-acp`, source at
`images/acp-driver/ship-acp.mjs`). The driver spawns the agent, answers
permission requests itself, and prints Ship's own JSONL on stdout; the
adapter parses that into the same run record shape the bespoke adapters
produce. What a bespoke adapter re-derives per vendor — session ids,
permission handling, event shapes — the protocol standardises, so each agent
is a thin profile:

| id | binary + args | credential | provider egress derived | baked pin |
|---|---|---|---|---|
| gemini | `gemini --acp` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` (the Developer-API fallback key; a real Vertex deployment puts its region-prefixed hosts on the project record) | `generativelanguage.googleapis.com:443` | `@google/gemini-cli@0.64.0` |
| grok | `grok --permission-mode default agent stdio` | `XAI_API_KEY` | `api.x.ai:443` | `@xai-official/grok@1.0.63` |
| cursor | `cursor-agent acp` | `CURSOR_API_KEY` | `api2.cursor.sh:443` | registry binary — H9 |
| qwen | `qwen --acp` | `DASHSCOPE_API_KEY` (+ `QWEN_BASE_URL` to reroute) | `dashscope`/`coding(-intl).dashscope.aliyuncs.com:443`, or the base URL's host when set | `@qwen-code/qwen-code@0.25.2` |

gemini is wired end to end; the others are declared behind the same flag and
stop at preflight on images that lack their binary. grok launches in its
**asking** mode (`--permission-mode default`) — never `--always-approve`: an
agent started in always-approve never asks, and the permission gate this
harness exists to run would silently stop existing.

qwen deliberately does NOT read the operator's `OPENAI_API_KEY` or
`OPENAI_BASE_URL`, even though qwen-code itself authenticates through those
names: they are the operator's OpenAI values, carried on the worker for
codex and opencode, and forwarding them into a qwen exec would hand them to
another vendor's agent (and its sandbox). qwen gets its OWN worker-side
pair — `DASHSCOPE_API_KEY`, optionally with `QWEN_BASE_URL` — and the
adapter renames the pair into the exec as `OPENAI_API_KEY`/
`OPENAI_BASE_URL`, the names qwen-code 0.25.2 actually reads for env-only
auth (`DASHSCOPE_API_KEY` works only through a settings.json
modelProviders.envKey entry, and the per-exec HOME carries no settings). The
enqueue gate refuses a qwen run that has no Dashscope key, however much
else the worker carries, and a base URL alone does not admit a run.

**Permission requests are answered, not bypassed.** This is the material
difference from the bespoke adapters (which run vendor bypass flags). The
driver answers every `session/request_permission` from a fail-closed policy
ported from T3 Code's clientPolicy. File-tool requests are workspace-gated;
shell execution is unrestricted inside the sandbox container — gVisor and
the egress allowlist are the boundary, the same authority decision every
external harness makes:

| request | decision |
|---|---|
| read / search / think, every location — and every path-like rawInput field (`destination`, `newPath`, `path`, `filePath`, `target`, `file_path`, `absolute_path`, `dir_path`, each entry of `paths[]`) — canonicalises inside the workspace | **allow** (allow_once); no locations and no path-like rawInput = allow (nothing outside is named) |
| edit / delete / move, every location and path-like rawInput field inside the workspace after a symlink-safe realpath walk (missing files resolve through their deepest existing ancestor) | **allow** (allow_once) |
| edit / delete / move with no locations, an unresolvable path, a broken symlink, or any location/rawInput path outside | **deny** (reject_once) |
| execute | **allow** — shell execution is unrestricted inside the sandbox container; gVisor and the egress allowlist are the boundary |
| fetch | **allow** — the egress allowlist decides |
| anything else | **deny** |

rawInput is gated because tools do not always fill the structured locations:
a move names its source as a location and its destination only in
`rawInput.destination`, and a policy that read locations alone would let
that destination walk anywhere. rawInput cannot substitute for locations on
a mutation, though — an edit whose target the driver cannot see as a
location is denied, not guessed at.

**allow_always is never selected** — it can outlive the session (Grok saves
it for the whole project). An allow that only exists as an allow_always
option becomes a deny. Every decision is a recorded `permission` claim on
the run step, with the reason; like all harness output, claims are not
evidence — the publish gate diffs the tree itself.

**Capability record.** The `initialize` result — protocol version negotiated
(every H0-measured agent negotiated 1, which is all the driver speaks),
advertised auth methods, `loadSession` — is recorded on the `harness-run`
step as `capabilities`, and the enqueue-time identity record carries the
profile facts. Steering derives from that recorded fact in H5; until then
steering notes for ACP runs are refused at the gate.

**Credentials** ride exec env and are scrubbed on both sides of the boundary
(H1): the driver scrubs the values (and base64 forms) from everything it
prints inside the sandbox; the adapter scrubs them again before parse,
record and live view. A profile with no credential set is refused at
enqueue, before any run exists. Enqueue also derives the profile's provider
hosts onto the run's egress allowlist exactly as the bespoke adapters do.

**The agent's state is per-exec.** The adapter pins the agent's `HOME` (and
the vendor home vars) at a fresh 700 directory under `/tmp`, created and
deleted by the exec's own shell — the vendor session store (tool output,
possibly secrets) rests neither in the container nor in a park snapshot of
it. The one belt beyond it is the workspace exclude list: an ACP run appends
`.gemini/`, `.qwen/` and `.grok/` to `.git/info/exclude` before the driver
starts, so project-level state an agent writes into the worktree cannot
reach `git add -A`. Those excludes are deliberately NOT part of the global
`WORKSPACE_EXCLUDES` every checkout applies: repos legitimately commit
`.gemini/settings.json` and its peers, and hiding them from every run would
eat such deliverables — native runs included.

**Not yet:** steering (H5, `session/load` at process boundaries plus the
interrupt control file), the read-only plan phase (H8), cursor's registry
binary and qwen's declared-journey verification (H9), Pi (RPC, not ACP; H6).
The agent runs as the exec user today: the images define no unprivileged
user yet, and H9's images are where `spec.agentUser` gets a real user to
drop to.

## Cost honesty under a subscription (P5-3)

Ship's spend governance prices tokens. A harness fed by a subscription
consumes a quota Ship cannot price, and the client-side estimate it prints is
an estimate of a bill that does not exist. Reporting that as spend would
overstate cost; reporting $0 would say the work was free. Neither is true, so:

- Usage carries `priced: false` when the credential is a subscription (claude
  under `CLAUDE_CODE_OAUTH_TOKEN`), when the harness reports tokens with no
  cost (opencode with `cost: 0`), or when the harness reports no cost figure
  at all (codex: tokens only, every run). Tokens are still recorded.
- An unpriced run is NOT added to the dollar ledger. It is counted, per source
  and per UTC day, in the unpriced-runs ledger, and the Spend page shows
  "unpriced runs: N" as its own line next to the dollars.
- Budgets degrade to run counts: the daily auto-launch cap
  (`SHIP_DAILY_AUTO_LIMIT`) still bounds a source whose runs are unpriced, and
  the dollar cap (`SHIP_DAILY_BUDGET_USD`) cannot see them. The Spend page
  says so where it shows the count.
- A priced external run (claude under `ANTHROPIC_API_KEY`, opencode reporting
  cost) records the harness's own dollar figure rather than re-pricing its
  tokens from Ship's table.

The licensing line, settled in the product plan: Ship builds the capability
and the user supplies whatever credential they choose. Driving your own
installed agent under your own login from your own self-hosted box is what an
automation token exists for; Ship does not market it as a way around API
pricing, and vendor terms on wrapping a subscription inside a larger product
are the user's to read.

## Multi-harness attempts (P5-4)

`SHIP_HARNESS_ATTEMPTS=native,claude-code` runs every new task through each
listed harness in its own sandbox (`attempt-N-` prefixed steps: sandbox,
repo-setup, the harness's own steps, a recorded diff), then one recorded
`harness-pick` step asks the critic model to choose among the candidate diffs.
Only the winner's tree goes through the publish gate; the losers' workspaces
are released. Off by default. Usage sums across attempts; a run is unpriced
if any attempt was.

This is the one form of multi-agent the measurements do not argue against:
different harnesses are genuinely diverse, N copies of one loop are not.
