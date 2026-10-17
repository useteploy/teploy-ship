# Harness adapters — driving other coding agents

Ship is the control plane, not the agent. Since P5-1 the loop that edits the
tree sits behind one interface (`src/harness.ts`), and a run's harness is
recorded in its input at enqueue, exactly like every other capability:

```
SHIP_HARNESS=native        # default — Ship's own CodeAct loop (src/durable.ts)
SHIP_HARNESS=claude-code   # `claude -p`, headless, in the sandbox
SHIP_HARNESS=opencode      # `opencode run`, headless, in the sandbox
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
   to `.teploy-agent/harness.env` which the command sources and deletes before
   the binary starts, and the binary's event stream is parsed when it exits.
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
   (`STEER_ROUNDS_MAX`); the loop stops on its own when no notes are pending
   or a resume timed out. The steps are input-gated in the step fingerprint,
   so a run enqueued without `steer` keeps the exact two-step sequence every
   earlier external log carries, and a replay walks the recorded rounds
   without starting a vendor process.

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
`allowlist` tier (the default) or `open`, and the vendor host has to be on the
allowlist — either on the repo's own list (Projects page, or `teploy-ship
project set <repo> --egress-allow api.z.ai:443`), which widens nothing else on
the box, or host-wide via `SBX_EGRESS_ALLOW` on teploy-sandbox. E.g.
`api.z.ai:443,models.opencode.ai:443` for opencode on z.ai, `api.anthropic.com:443`
for claude. The binary has to be in `SHIP_SANDBOX_IMAGE`. Neither is checked at enqueue — a run asking for a
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
| `SHIP_HARNESS` | `native` (default), `claude-code`, `opencode`. The worker-wide default; a project record's `harness` field wins for that repo. Read at enqueue on every surface (CLI, dashboard, webhook, sweep); recorded on the run. |
| `SHIP_HARNESS_ATTEMPTS` | Comma list of harness ids. When it names two or more, every new run tries each in its own workspace and the critic picks one to publish (P5-4). Off by default. |
| `SHIP_HARNESS_MODEL` | Model id passed to the harness (`--model`). Absent = the harness's own default. |
| `SHIP_HARNESS_ENV` | Comma list of worker env var NAMES forwarded into the harness process. Overrides the per-adapter default below. |
| `SHIP_HARNESS_TIMEOUT_MS` | Per-exec deadline for each vendor process. Default 1800000. A steered attempt runs at most `1 + STEER_ROUNDS_MAX` execs (main + resume rounds), each bounded by this. |
| `SHIP_CLAUDE_BARE` | `1` adds `--bare` to claude: API-key auth only, no host context (hooks, CLAUDE.md, MCP). |

Default forwarded variables: claude-code `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`; opencode
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ZHIPU_API_KEY`
(z.ai, per models.dev), `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENCODE_CONFIG_CONTENT`. A variable that is
unset on the worker is simply not forwarded.

Per-repo evidence config (`teploy-ship evidence set`) is harness-independent
by design; the harness is chosen per deployment through the environment, not
per repo, so the two matrices never tangle.

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

## Cost honesty under a subscription (P5-3)

Ship's spend governance prices tokens. A harness fed by a subscription
consumes a quota Ship cannot price, and the client-side estimate it prints is
an estimate of a bill that does not exist. Reporting that as spend would
overstate cost; reporting $0 would say the work was free. Neither is true, so:

- Usage carries `priced: false` when the credential is a subscription (claude
  under `CLAUDE_CODE_OAUTH_TOKEN`) or when the harness reports tokens with no
  cost (opencode with `cost: 0`). Tokens are still recorded.
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
