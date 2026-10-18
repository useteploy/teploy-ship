#!/usr/bin/env node
// ACP initialize probe (H0 evidence, 2026-10-18).
//
// Spawns an agent CLI, sends one ACP `initialize` request over stdio
// (newline-delimited JSON-RPC 2.0), records the response
// (protocolVersion, agentCapabilities, authMethods, agentInfo) and exits.
// No credentials are sent and none are needed for initialize on agents that
// follow the ACP auth flow; an agent that demands auth earlier is recorded
// as such by whatever it prints before the timeout.
//
// Usage: node scripts/acp-initialize-probe.mjs [--timeout-sec N] -- <command> [args...]
// The child inherits this process's env and cwd; point HOME at a throwaway
// directory when probing so no real credential store is touched.
// Exit codes: 0 initialize answered, 1 usage/transport error, 2 timeout,
// 3 child exited before answering.

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
let timeoutSec = 30;
while (args[0] !== undefined && args[0] !== "--") {
  if (args[0] === "--timeout-sec") {
    timeoutSec = Number(args[1]);
    args.splice(0, 2);
    continue;
  }
  break;
}
if (args[0] !== "--" || args.length < 2) {
  console.error("usage: acp-initialize-probe.mjs [--timeout-sec N] -- <command> [args...]");
  process.exit(1);
}
const [command, ...commandArgs] = args.slice(1);

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 2,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  },
};

const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
const startedAt = Date.now();
let stderrTail = "";

const timer = setTimeout(() => {
  console.error(`--- timeout after ${timeoutSec}s, killing child ---`);
  child.kill("SIGKILL");
  process.exit(2);
}, timeoutSec * 1000);
timer.unref();

child.on("error", (error) => {
  console.error(`--- spawn error: ${error.message} ---`);
  process.exit(1);
});

child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
});

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log(`[non-JSON stdout line] ${line}`);
      continue;
    }
    console.log(JSON.stringify(message));
    if (
      message?.jsonrpc === "2.0" &&
      message.id === 1 &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const elapsedMs = Date.now() - startedAt;
      const result = message.result ?? {};
      console.error(`--- initialize answered in ${elapsedMs}ms ---`);
      console.error(`protocolVersion: ${JSON.stringify(result.protocolVersion)}`);
      console.error(`agentInfo: ${JSON.stringify(result.agentInfo)}`);
      console.error(`agentCapabilities: ${JSON.stringify(result.agentCapabilities)}`);
      console.error(`authMethods: ${JSON.stringify(result.authMethods)}`);
      if (stderrTail.trim() !== "") {
        console.error(`--- stderr tail ---`);
        console.error(stderrTail.trim());
      }
      clearTimeout(timer);
      child.kill("SIGKILL");
      process.exit(0);
    }
  }
});

child.on("close", (code) => {
  console.error(`--- child exited code=${code} before answering initialize ---`);
  if (stderrTail.trim() !== "") {
    console.error(`--- stderr tail ---`);
    console.error(stderrTail.trim());
  }
  process.exit(3);
});

child.stdin.write(JSON.stringify(initializeRequest) + "\n");
