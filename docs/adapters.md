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

1. `harness-preflight` — is the binary on PATH in the sandbox image, and which
   version. A missing binary is a recorded `error` result; nothing runs.
2. `harness-run` — one `exec` in the sandbox: the prompt is written to
   `.teploy-agent/harness-prompt.md` (git-excluded), the forwarded credentials
   to `.teploy-agent/harness.env` which the command sources and deletes before
   the binary starts, and the binary's event stream is parsed when it exits.
   The recorded step carries exit code, status, summary, turn count, usage,
   the NAMES of the forwarded variables (never values) and a stderr tail.

The sandbox API is request/response, so progress is coarse: started, then
completed with a turn count. A whole-attempt deadline bounds it
(`SHIP_HARNESS_TIMEOUT_MS`, default 30 minutes); a timeout is a recorded
error, and whatever tree exists goes through the publish gate as incomplete.

The external harness must reach its model vendor, so the sandbox needs
`SHIP_SANDBOX_NETWORK=egress`, and the binary has to be in
`SHIP_SANDBOX_IMAGE`. Neither is checked at enqueue — a run asking for a
harness the image lacks fails at preflight, on the run's own timeline.

## Configuration

| variable | meaning |
|---|---|
| `SHIP_HARNESS` | `native` (default), `claude-code`, `opencode`. Read at enqueue on every surface (CLI, dashboard, webhook, sweep); recorded on the run. |
| `SHIP_HARNESS_ATTEMPTS` | Comma list of harness ids. When it names two or more, every new run tries each in its own workspace and the critic picks one to publish (P5-4). Off by default. |
| `SHIP_HARNESS_MODEL` | Model id passed to the harness (`--model`). Absent = the harness's own default. |
| `SHIP_HARNESS_ENV` | Comma list of worker env var NAMES forwarded into the harness process. Overrides the per-adapter default below. |
| `SHIP_HARNESS_TIMEOUT_MS` | Whole-attempt deadline. Default 1800000. |
| `SHIP_CLAUDE_BARE` | `1` adds `--bare` to claude: API-key auth only, no host context (hooks, CLAUDE.md, MCP). |

Default forwarded variables: claude-code `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`; opencode
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `OPENCODE_CONFIG_CONTENT`. A variable that is
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

Verified against Claude Code 2.1.243 on 2026-08-24: a one-turn `-p` run
under a subscription login still reports `total_cost_usd` (0.29 for a
"pong"), which is why Ship does not record it as spend under an OAuth token —
see cost honesty below.

## opencode

Invocation:

```
opencode run --format json --auto --pure --dir . [--model <provider/model>] "$(cat .teploy-agent/harness-prompt.md)"
```

- `opencode run [message..]` is the non-interactive mode; `--format json`
  prints raw JSON events, one per line; `--auto` auto-approves permissions
  not explicitly denied; `--pure` runs without external plugins; `--model`
  takes `provider/model`; `--dir` sets the working directory.
  https://opencode.ai/docs/cli/
- Events observed from opencode 1.18.21 on 2026-08-24: `step_start`, `text`
  (`part.text`), `tool_use`, `step_finish` (`part.tokens.{input,output,
  reasoning,cache.{read,write}}`, `part.cost`), `error`. There is no terminal
  result object; the process exits 0 on success and 1 on error. Ship takes
  the last `text` part as the summary and sums `step_finish` tokens.
  Source: `packages/opencode/src/cli/cmd/run.ts` in
  https://github.com/anomalyco/opencode
- Provider credentials are the provider's own environment variables
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) or an `OPENCODE_CONFIG_CONTENT`
  JSON. https://opencode.ai/docs/config/

fylun-code is an opencode overlay (a plugin), so it is driven through this
same adapter; nothing in it changes the headless contract.

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
