#!/usr/bin/env node
// The mock ACP agent for ship-acp tests (E7 H3) — an in-process-scriptable
// stand-in for a real ACP CLI, modelled on T3 Code's
// packages/effect-acp/test/fixtures/acp-mock-peer.ts (MIT, Copyright (c) 2026
// T3 Tools Inc.; see THIRD_PARTY.md).
//
// Speaks agent-side ACP v1 over stdio: answers initialize / session/new /
// session/prompt, streams session/update notifications, and asks
// session/request_permission for the writes it wants to make. It performs an
// actual filesystem write only when the client selects its allow_once option,
// so a permission test fails loudly if the driver ever grants something it
// should not: an outside-workspace write throws EACCES/EPROTONOSUPPORT here
// and the session collapses instead of silently succeeding.
//
// Behaviour is chosen by env (all optional):
//   ACP_MOCK_LOG=<path>         append a JSONL transcript of what the driver
//                               answered (permission responses, cwd, prompt)
//   ACP_MOCK_JOURNEY=write      default: read tool, one allowed in-workspace
//                               write (permission requested), final message
//   ACP_MOCK_JOURNEY=matrix     the negative-control matrix: permission
//                               requests for outside/dotdot/symlink/broken/
//                               no-locations/unknown-kind/rawinput-destination/
//                               in-workspace
//   ACP_MOCK_ALLOW_ALWAYS_ONLY  offer ONLY allow_always + reject_once: the
//                               driver must deny, never select allow_always
//   ACP_MOCK_JOURNEY=hang       stream tool calls past any budget, then
//                               ignore session/cancel and never answer the
//                               prompt (the driver's cancel-grace control)
//   ACP_MOCK_JOURNEY=bg         spawn a background `sleep` that inherits our
//                               stdio and outlives us; ACP_MOCK_BG_SETSID
//                               gives it its own session so even a group kill
//                               cannot reach it (the stdio-hold control)
//   ACP_MOCK_ECHO               echo env and the base64 of GEMINI_API_KEY in
//                               an agent message (the H1 scrub control)
//   ACP_MOCK_SPLIT_LEAK         leak GEMINI_API_KEY split across message
//                               chunks, the driver's non-JSON relay cap and
//                               two stderr stream chunks (the H1 join control)
//   ACP_MOCK_VERSION_LINE       what `--version` prints
// argv[2] === "--version" prints a version line and exits (preflight).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION_LINE = process.env.ACP_MOCK_VERSION_LINE ?? "0.64.0 (mock acp peer)";
if (process.argv[2] === "--version") {
  process.stdout.write(`${VERSION_LINE}\n`);
  process.exit(0);
}

const SESSION_ID = "mock-session-1";
const OPTIONS = (allowAlwaysOnly) =>
  allowAlwaysOnly
    ? [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ]
    : [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
        { optionId: "reject-always", name: "Always deny", kind: "reject_always" },
      ];

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (entry) => {
  if (typeof process.env.ACP_MOCK_LOG !== "string" || process.env.ACP_MOCK_LOG === "") return;
  appendFileSync(process.env.ACP_MOCK_LOG, `${JSON.stringify(entry)}\n`);
};

let nextId = 100;
const pending = new Map(); // id -> resolve
const request = (method, params) =>
  new Promise((resolveRequest) => {
    const id = nextId++;
    pending.set(id, resolveRequest);
    write({ jsonrpc: "2.0", id, method, params });
  });
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
const update = (entry) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update: entry } });

let cwd = process.cwd();

const askPermission = (title, kind, locations, rawInput, allowAlwaysOnly) =>
  request("session/request_permission", {
    sessionId: SESSION_ID,
    title,
    toolCall: {
      toolCallId: `tool-${title.replace(/\W+/g, "-")}`,
      title,
      kind,
      status: "pending",
      ...(locations === undefined ? {} : { locations }),
      ...(rawInput === undefined ? {} : { rawInput }),
    },
    options: OPTIONS(allowAlwaysOnly),
  });

const askWrite = (title, kind, path, allowAlwaysOnly) => askPermission(title, kind, path === undefined ? undefined : [{ path }], undefined, allowAlwaysOnly);

/** Ask, record what the driver chose, and write only on an explicit allow_once. */
const permittedWrite = async (title, path, allowAlwaysOnly) => {
  const outcome = await askWrite(title, "edit", path, allowAlwaysOnly);
  const optionId = outcome?.outcome?.outcome === "selected" ? outcome.outcome.optionId : null;
  log({ event: "permission", title, path: path ?? null, optionId });
  if (optionId === "allow") {
    // A real tool creates missing parents; so does the mock. The write is
    // also the probe: an outside-workspace write the driver wrongly allowed
    // throws here and fails the session loudly.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `written by the mock agent\n`);
  }
  update({
    sessionUpdate: "tool_call",
    toolCallId: `tool-${title.replace(/\W+/g, "-")}`,
    title,
    kind: "edit",
    status: optionId === "allow" ? "completed" : "failed",
    ...(path === undefined ? {} : { locations: [{ path }] }),
  });
  return optionId;
};

const runPrompt = async (promptText) => {
  log({ event: "prompt", cwd, prompt: promptText });
  const allowAlwaysOnly = process.env.ACP_MOCK_ALLOW_ALWAYS_ONLY === "1";
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: promptText } });

  if (process.env.ACP_MOCK_JOURNEY === "matrix") {
    // The negative-control matrix from the design note: every path here must
    // be answered reject_once except the last (a fresh path inside the
    // workspace, which the realpath walk must admit even though no file
    // exists yet). A driver that lexically normalises before realpath lets
    // the symlink case escape.
    symlinkSync("/", join(cwd, "outside-link"));
    symlinkSync(join(cwd, "nonexistent-target-xyz"), join(cwd, "broken-link"));
    await permittedWrite("write etc", "/etc/ship-acp-must-not-exist", allowAlwaysOnly);
    await permittedWrite("dotdot escape", join(cwd, "..", "outside-dotdot"), allowAlwaysOnly);
    await permittedWrite("symlink escape", join(cwd, "outside-link", "..", "..", "outside-symlink"), allowAlwaysOnly);
    await permittedWrite("broken symlink", join(cwd, "broken-link", "target"), allowAlwaysOnly);
    await permittedWrite("no locations", undefined, allowAlwaysOnly);
    // Unknown kind on an in-workspace path: denied for its KIND, not its path.
    const unknown = await askWrite("teleport", "teleport", join(cwd, "teleported.txt"), allowAlwaysOnly);
    log({ event: "permission", title: "teleport", path: join(cwd, "teleported.txt"), optionId: unknown?.outcome?.outcome === "selected" ? unknown.outcome.optionId : null });
    update({ sessionUpdate: "tool_call", toolCallId: "tool-teleport", title: "teleport", kind: "teleport", status: "failed", locations: [{ path: join(cwd, "teleported.txt") }] });
    // A move whose destination appears ONLY in rawInput (the source is a
    // proper in-workspace location): a policy that reads locations alone
    // would allow it and the move would land outside the workspace.
    const rawMove = await askPermission("move via rawinput", "move", [{ path: join(cwd, "moved-src.txt") }], { destination: "/etc/ship-acp-must-not-exist-rawinput" }, allowAlwaysOnly);
    log({ event: "permission", title: "move via rawinput", path: "/etc/ship-acp-must-not-exist-rawinput", optionId: rawMove?.outcome?.outcome === "selected" ? rawMove.outcome.optionId : null });
    update({ sessionUpdate: "tool_call", toolCallId: "tool-move-via-rawinput", title: "move via rawinput", kind: "move", status: "failed", locations: [{ path: join(cwd, "moved-src.txt") }] });
    await permittedWrite("inside workspace", join(cwd, "made", "up", "dir", "inside.txt"), allowAlwaysOnly);
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Matrix complete." } });
    return { stopReason: "end_turn" };
  }

  if (process.env.ACP_MOCK_JOURNEY === "hang") {
    // Stream tool calls past any budget, then ignore session/cancel and
    // never answer the prompt: the driver must kill the agent after its
    // grace and record the budget stop itself.
    for (let i = 0; i < 12; i++) {
      update({
        sessionUpdate: "tool_call",
        toolCallId: `tool-hang-${i}`,
        title: `step ${i}`,
        kind: "execute",
        status: "completed",
        rawInput: { command: `echo ${i}` },
      });
    }
    return await new Promise(() => {});
  }

  if (process.env.ACP_MOCK_JOURNEY === "bg") {
    // A background grandchild that inherits our stdio and outlives us. With
    // ACP_MOCK_BG_SETSID it gets its own session, so even the driver's
    // process-group kill cannot reach it — only the driver destroying its
    // streams and exiting ends the exec; without it, the group kill is what
    // must take it down.
    const bg = spawn("sleep", ["45"], { stdio: ["inherit", "inherit", "inherit"], detached: process.env.ACP_MOCK_BG_SETSID === "1" });
    bg.unref();
    log({ event: "bg", pid: bg.pid ?? null, setsid: process.env.ACP_MOCK_BG_SETSID === "1" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Backgrounded." } });
    return { stopReason: "end_turn" };
  }

  // The declared journey: a read, one permitted write inside the workspace, a
  // final message. The write is the whole point — the diff is the deliverable.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tool-read",
    title: "Read notes.md",
    kind: "read",
    status: "in_progress",
    locations: [{ path: join(cwd, "notes.md") }],
  });
  update({ sessionUpdate: "tool_call_update", toolCallId: "tool-read", status: "completed" });
  await permittedWrite("Write notes.md", join(cwd, "notes.md"), allowAlwaysOnly);
  if (process.env.ACP_MOCK_ECHO === "1") {
    // Deliberately leak the credential every way an agent plausibly could.
    const key = process.env.GEMINI_API_KEY ?? "";
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `GEMINI_API_KEY=${key}\n` } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `b64=${Buffer.from(key, "utf8").toString("base64")}\n` } });
  }
  if (process.env.ACP_MOCK_SPLIT_LEAK === "1") {
    // The credential split across every boundary a stream has, each of which
    // defeats per-chunk/per-line redaction on its own: two message chunks of
    // one agent message (rejoined by the worker's parser), a non-JSON stdout
    // line whose secret straddles the driver's 500-char relay cap, and two
    // stderr stream chunks split mid-value.
    const key = process.env.GEMINI_API_KEY ?? "";
    process.stdout.write(`${"N".repeat(480)}${key}${"N".repeat(80)}\n`);
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `GEMINI_API_KEY=${key.slice(0, 12)}` } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${key.slice(12)} done.` } });
    process.stderr.write(`agent stderr says: ${key.slice(0, 12)}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    process.stderr.write(`${key.slice(12)} tail\n`);
    return { stopReason: "end_turn" };
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrote notes.md." } });
  return { stopReason: "end_turn" };
};

const handleRequest = async (message) => {
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentInfo: { name: "mock-acp-peer", title: "Mock ACP peer", version: VERSION_LINE },
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "mock-api-key", name: "Mock API key" }],
    });
    return;
  }
  if (message.method === "authenticate") {
    log({ event: "authenticate", methodId: message.params?.methodId ?? null });
    respond(message.id, {});
    return;
  }
  if (message.method === "session/new") {
    cwd = typeof message.params?.cwd === "string" ? message.params.cwd : process.cwd();
    // Simulate the vendor session store: a real agent writes state under its
    // HOME the moment a session exists, which is exactly what must land in
    // the per-exec home (and be deleted with it), never in the workspace.
    try {
      mkdirSync(join(process.env.HOME ?? "", ".gemini", "tmp"), { recursive: true });
      writeFileSync(join(process.env.HOME ?? "", ".gemini", "tmp", "session.json"), JSON.stringify({ toolOutput: "possibly secret" }));
    } catch {
      // a HOME-less peer still runs
    }
    log({ event: "session-new", cwd, home: process.env.HOME ?? null });
    respond(message.id, { sessionId: SESSION_ID });
    return;
  }
  if (message.method === "session/prompt") {
    const text = (message.params?.prompt ?? [])
      .map((block) => (block?.type === "text" ? block.text : ""))
      .join("\n");
    try {
      const result = await runPrompt(text);
      respond(message.id, { ...result, usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } });
    } catch (error) {
      // -32000 is the code a real agent reserves for auth-required; the mock
      // keeps its own failures on -32603 so it never impersonates one.
      respondError(message.id, -32603, `mock peer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  respondError(message.id, -32601, `mock peer does not answer ${message.method}`);
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message?.jsonrpc !== "2.0") continue;
    if (message.id !== undefined && message.method !== undefined && message.result === undefined && message.error === undefined) {
      void handleRequest(message);
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolveRequest = pending.get(message.id);
      pending.delete(message.id);
      resolveRequest(message.result ?? message.error ?? null);
      continue;
    }
    // Client notifications (session/cancel): recorded, nothing to do.
    if (message.method !== undefined) {
      log({ event: "notify", method: message.method });
    }
  }
});
// A real agent stays alive; the driver kills us when the turn ends.
