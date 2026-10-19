# MCP client in the native loop (D1: S24, S13, S01)

Status: built behind `SHIP_MCP` (default off). Programme row D1 in
`docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md`; remote private data is owner
Decision 6 (E6), pending — the default refuses it.

## Rules in one paragraph

An MCP server is declared by the project administrator, never by imported
text. Its tools are offered only where the server lists them AND the S24
manifest declares them AND the administrator's grant covers every effect,
host and scope the declaration asks for (intersection, `effectivePermissions`).
Read-only is the default grant; a write tool needs an explicit grant. Every
call is a recorded durable step: replay returns the recorded result and never
contacts the server again. Output is capped, scrubbed and framed as
`<untrusted-content>` (the `look` fence, #77), so a tool cannot change the
run's authority. Off, nothing changes: same prompt bytes, same parser, same
step sequence, same fingerprint.

## Where servers are declared

On the project record (`src/projects.ts`, field `mcp`), validated at save by
`normalizeMcp` (`src/mcp.ts`), and edited with
`teploy-ship project set <repo> --mcp <json|file>` (`--mcp ""` clears).
`teploy-ship tool validate` stays the dry run for a manifest + grant.

```jsonc
"mcp": {
  "dataClass": "private",            // this repo's data class; absent = private
  "servers": [{
    "name": "docs",                  // [a-z][a-z0-9_-]{0,31}
    "transport": "stdio",            // or "http"
    "command": ["node", "tools/docs-mcp.mjs"],   // stdio only
    "url": "https://mcp.example.com/mcp",        // http only
    "manifest": { /* S24 ToolManifest: per-tool input/output, effects,
                     hosts, scopes, secrets, timeoutMs, cancellation,
                     approval */ },
    "grant": { "effects": ["read"], "hosts": [], "scopes": [] },
    "dataClasses": ["public"],       // http only: classes it may receive
    "authSecret": "DOCS_TOKEN",      // http only: NAME; value is worker env
    "maxOutputChars": 8000
  }]
}
```

At enqueue (`src/runtime.ts`), with `SHIP_MCP=on` and at least one declared
server, the record is materialised into `input.mcp` together with the
deployment facts the gates read: the data class, `SHIP_MCP_REMOTE_HOSTS`,
`SHIP_MCP_REMOTE_PORTS`, the `SHIP_TOOL_MANIFEST` mode and
`SHIP_MCP_REMOTE_PRIVATE`. Every gate that
decides whether a step exists is a pure function of that recorded input, so a
replay refuses or proceeds identically after the record or env is edited.
Scans get no MCP (they read the repository, like `look`).

## Transports

- **stdio** runs INSIDE the run's sandbox. Each list or call is one executor
  command: a self-contained driver (`.teploy-agent/mcp-driver.mjs`, needs
  `node` in the image) spawns the declared command in the workdir, does
  `initialize` → `notifications/initialized` → `tools/list` or `tools/call`
  over newline-delimited JSON-RPC, prints one JSON line and kills the server's
  whole process group (spawned detached, killed by pgid, so a server that
  left helpers behind cannot outlive the call).
  The server therefore has exactly the sandbox's filesystem, egress tier and
  limits — no more. Consequence stated plainly: a stdio server is no more
  trusted than the agent's own `bash`, so its write gate is policy, not a
  security boundary, and **stdio tools may not declare secrets** (the agent
  could read them from the same sandbox). Servers are per call, not
  long-lived; stateful stdio servers are out of scope.
- **http** (streamable HTTP, JSON or SSE responses, `Mcp-Session-Id`
  honoured) is called from the WORKER. A call is allowed only when the URL's
  host is on `SHIP_MCP_REMOTE_HOSTS` (deployment) AND covered by the server's
  grant hosts (project), and the tool declares the `network` effect for it.
  The gate decides CONTACT, not just the offer: a server whose hosts the
  grant does not cover gets no `initialize`/`tools/list` at all. Its URL's
  port must be the scheme default or one `SHIP_MCP_REMOTE_PORTS` named. The
  listing is authenticated like a call (the bearer rides `initialize` and
  `tools/list`). The target goes through `validateRetrievalTarget`
  (resolved-address check, no userinfo, no private or metadata addresses)
  and `pinnedFetch` (no DNS rebinding between check and connect); redirects
  are refused.

## Data class (remote only)

A remote server inherits the routing data-class gate (`model-routing.ts`):
the run's class must be in the server's `dataClasses` (default `public`).
`private` additionally requires `SHIP_MCP_REMOTE_PRIVATE=allow` at enqueue —
that switch is Decision 6 and stays unset until the owner decides it. A
refused server is not contacted at all (not even `tools/list`), its tools are
not offered, and a call names the reason.

## How tools reach the model

Namespaced `mcp.<server>.<tool>`. The `mcp-tools` step (once, before turn 0)
records what each server listed. A tool is offered when it is listed,
declared, has no permission excess, and its `approval` is satisfiable
(`always`, or `on-write` on a write tool, needs an approval park this slice
does not build, so such tools are not offered). The prompt gets one section
listing offered tools with read/write and the declared (or, absent that,
listed) input schema; server-supplied descriptions and schemas are inside an
`<untrusted-content>` frame. The agent calls with one block:

````
```mcp mcp.docs.search
{"query": "retry backoff"}
```
````

Undeclared, unlisted, excess-permission and unknown-server names are refused
before any step. Arguments must be a JSON object with the schema's
`required` keys.

## Manifest enforcement (`SHIP_TOOL_MANIFEST`)

For MCP tools the observed call is built from what the loop can actually
see: the server's own `tools/list` annotations (`readOnlyHint: false` or
`destructiveHint: true` mean write), the network host for remote calls, the
arguments as argv, and the remote auth secret's value for leak detection.
`conformanceChecks` runs against the declaration. `off`: not run. `shadow`:
findings appended to `tool-manifest-shadow.jsonl`, the call proceeds.
`on`: a pre-call finding refuses the call (no step), and a secret value in
the output withholds it.

## Secrets, timeouts, size, injection

- Secrets: only by name in the record; the remote auth value is read from
  worker env `SHIP_MCP_SECRET_<NAME>` inside the step and sent as a bearer
  header. It never enters the input, the log, the prompt, or the sandbox, and
  is scrubbed from output.
- Timeouts: the tool's declared `timeoutMs` bounds each call (executor
  timeout for stdio, `AbortController` for http); a timeout is a recorded
  error result, never a hung run.
- Size: output is rendered to text (images and audio become placeholders),
  capped at `maxOutputChars` (default 8000, max 32000) at the source, and the
  observation is truncated again at the loop's observation cap.
- Injection: the observation is scrubbed, then `frameUntrusted`; the
  injection screen's flags are added outside the frame. Authority comes only
  from the recorded input, so text in a tool result cannot unlock a tool.
  Server-controlled text reaches the model ONLY inside that frame: a failed
  listing's error detail (stderr, an HTTP body, a JSON-RPC error message)
  stays on the recorded `mcp-tools` step for the operator, and the refusal
  the model sees carries fixed reasons. A tool the server itself annotates
  as writing (`readOnlyHint: false`, `destructiveHint: true`) is never
  offered on a read-only declaration, whatever `SHIP_TOOL_MANIFEST` is set
  to. Listings stop at 64 tools per server.

## Recording, replay, cost

Each call is `turn-N-mcp`, recording `{ ok, isError, text, latencyMs,
outputChars, truncated }`. Replay returns it without contacting the server.
Latency is measured; MCP carries no pricing, so per-call cost is recorded as
the latency and output size only (the model turn that reads it is priced as
usual). Both steps are gated on `input.mcp` in `WORKFLOW_STEPS`.

## Not in this slice

Approval parks for `approval: always`/`on-write` tools; OAuth flows; MCP
resources, prompts and sampling; long-lived stdio sessions; a dashboard
editor for the `mcp` field; per-exec env forwarding in the sandbox daemon
(needed only if stdio secrets are ever allowed).

One pass-through exists since 2026-10-19, deliberately narrow and separate
from this client: `SHIP_HARNESS_BROWSER=on` wires ONE Ship-baked browser MCP
server into the external harnesses' own MCP configs (claude `--mcp-config`,
opencode's config blob, codex `--config` overrides, ACP `session/new`
mcpServers), so the vendor agent — not this loop — is the MCP client. See
docs/adapters.md "A browser for external harnesses". General project-record
MCP pass-through to external harnesses remains out of scope here.
