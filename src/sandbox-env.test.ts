import assert from "node:assert/strict";
import { test } from "node:test";

import { SandboxExecutor } from "@neutron-build/agents";

import { gitCredential, parseRepoUrl } from "./git.js";
import { streamSandboxExec } from "./durable.js";

/**
 * Per-exec env must reach the teploy-sandbox daemon, which accepts `env` on
 * POST /v1/runs/{id}/exec and hands it to `docker exec --env-file`. The
 * published SDK dropped it from the body (patches/@neutron-build__agents.patch
 * restores it, the Dockerfile applies the same patch after npm ci), and
 * Ship's own streamed exec never sent it either.
 */
function fakeDaemon(): { fetch: typeof globalThis.fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const sse = `event: stdout\ndata: ok\n\nevent: exit\ndata: {"exitCode":0}\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, bodies };
}

test("SandboxExecutor.exec sends per-exec env to the daemon (patched SDK)", async () => {
  const daemon = fakeDaemon();
  const executor = SandboxExecutor.attach("run-1", { baseURL: "http://sandbox.test", token: "t", fetch: daemon.fetch });
  const result = await executor.exec("git fetch origin", { timeoutMs: 5000, env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1" } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(daemon.bodies[0]?.env, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1" });
  // No env, no field: the body every earlier exec sent.
  await executor.exec("true");
  assert.equal("env" in (daemon.bodies[1] ?? {}), false);
});

test("SHIP_GIT_CREDENTIAL=env: the token reaches the daemon in env, not in the command", async () => {
  const daemon = fakeDaemon();
  const executor = SandboxExecutor.attach("run-1", { baseURL: "http://sandbox.test", token: "t", fetch: daemon.fetch });
  const cred = gitCredential(parseRepoUrl("https://forge.example.com/o/r.git"), "forge-token-123456", "env");
  await executor.exec(`git fetch ${cred.url}`, { ...(cred.env !== undefined ? { env: cred.env } : {}) });
  const body = daemon.bodies[0]!;
  assert.ok(!String(body.cmd).includes("forge-token-123456"));
  const sent = body.env as Record<string, string>;
  assert.equal(sent.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("forge-token-123456:").toString("base64")}`);
});

test("streamSandboxExec sends per-exec env to the daemon", async () => {
  const daemon = fakeDaemon();
  const chunks: string[] = [];
  const result = await streamSandboxExec(
    { baseURL: "http://sandbox.test", token: "t", fetch: daemon.fetch },
    "run-1",
    "claude -p x",
    { timeoutMs: 5000, env: { ANTHROPIC_API_KEY: "k-0123456789" } },
    (_stream, chunk) => chunks.push(chunk),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(chunks, ["ok"]);
  assert.deepEqual(daemon.bodies[0]?.env, { ANTHROPIC_API_KEY: "k-0123456789" });
  assert.ok(!String(daemon.bodies[0]?.cmd).includes("k-0123456789"));
  await streamSandboxExec({ baseURL: "http://sandbox.test", token: "t", fetch: daemon.fetch }, "run-1", "true", {}, () => {});
  assert.equal("env" in (daemon.bodies[1] ?? {}), false);
});
