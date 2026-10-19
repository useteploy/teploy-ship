import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentInput } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { HARNESS_VERSIONS } from "./harness.js";
import { capabilityOf, declarationFor } from "./harness-capabilities.js";
import { externalAdapters, opencodeConfigDestinations, shq } from "./harness-external.js";
import { acpAdapters } from "./harness-acp.js";
import {
  BROWSER_MCP_ARGV,
  BROWSER_MCP_CDP_ENDPOINT,
  BROWSER_MCP_PACKAGE,
  type HarnessBrowserWiring,
  acpBrowserMcpServers,
  browserSessionShell,
  browserSessionStartScript,
  claudeMcpConfig,
  codexMcpConfigFlags,
  harnessBrowserEnabled,
  harnessBrowserPromptNote,
  harnessBrowserWiring,
  isHarnessBrowserMcpServer,
  opencodeConfigWithBrowser,
} from "./harness-browser.js";
import { lookSessionScript } from "./look.js";

/**
 * SHIP_HARNESS_BROWSER — a browser for the external harnesses through the
 * baked Playwright MCP server, attached over CDP to the same per-run
 * Chromium session the native look path drives.
 *
 * Three layers are pinned here:
 *   the gate      tier/plan rules mirror look's (LOOK_SEALED / LOOK_OPEN_PLAN)
 *   the config    each harness's own MCP plumbing carries ONE exact server
 *   the session   look's session bytes, started before the vendor exec
 * plus the adapter integrations (fake binaries, real adapter code) and the
 * capability text the dashboard reads.
 */

const neverModel: ModelAdapter = {
  provider: "never",
  modelId: "never",
  async doGenerate() {
    throw new Error("an external harness run must never call Ship's model");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

const inputOf = (extra: Partial<DurableAgentInput> = {}): DurableAgentInput =>
  ({ task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"]! }, ...extra }) as DurableAgentInput;

/** The content arm of an opencodeConfigWithBrowser result (narrowing helper). */
const contentOf = (result: ReturnType<typeof opencodeConfigWithBrowser>): string => {
  assert.ok("content" in result, `expected a merged blob, got a refusal: ${"refusal" in result ? result.refusal : "?"}`);
  return result.content;
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("harnessBrowserEnabled is on only for an explicit on/1/true", () => {
  assert.equal(harnessBrowserEnabled({}), false);
  assert.equal(harnessBrowserEnabled({ SHIP_HARNESS_BROWSER: "" }), false);
  assert.equal(harnessBrowserEnabled({ SHIP_HARNESS_BROWSER: "off" }), false);
  assert.equal(harnessBrowserEnabled({ SHIP_HARNESS_BROWSER: "on" }), true);
  assert.equal(harnessBrowserEnabled({ SHIP_HARNESS_BROWSER: "1" }), true);
  assert.equal(harnessBrowserEnabled({ SHIP_HARNESS_BROWSER: "TRUE" }), true);
});

test("the gate mirrors look's tier rules: off by default, sealed refused, open needs plan review", () => {
  assert.deepEqual(harnessBrowserWiring(inputOf(), {}), { kind: "off" }, "flag unset: nothing changes anywhere");
  const on = { SHIP_HARNESS_BROWSER: "on" } as NodeJS.ProcessEnv;

  assert.deepEqual(harnessBrowserWiring(inputOf(), on), { kind: "wired" }, "no declared tier: the worker default (allowlist) accepts a browser, like look");
  assert.deepEqual(harnessBrowserWiring(inputOf({ sandboxNetwork: "allowlist" }), on), { kind: "wired" });

  const sealed = harnessBrowserWiring(inputOf({ sandboxNetwork: "none" }), on);
  assert.equal(sealed.kind, "refused", "a sealed tier cannot egress, so no browser");
  assert.match((sealed as { reason: string }).reason, /network tier is sealed/);

  const open = harnessBrowserWiring(inputOf({ sandboxNetwork: "open" }), on);
  assert.equal(open.kind, "refused", "open tier without plan review: LOOK_OPEN_PLAN's rule");
  assert.match((open as { reason: string }).reason, /only permitted on a run whose plan an operator reviewed/);

  assert.deepEqual(harnessBrowserWiring(inputOf({ sandboxNetwork: "open", plan: true }), on), { kind: "wired" }, "plan review recorded: the open tier admits a browser");

  // The external-task downgrade, the same funnel look reads: an open tier a
  // stranger's task does not actually get.
  assert.deepEqual(harnessBrowserWiring(inputOf({ sandboxNetwork: "open", trust: "external" }), on), { kind: "wired" });
});

test("the prompt note rides only a refusal", () => {
  assert.equal(harnessBrowserPromptNote({ kind: "off" }), "");
  assert.equal(harnessBrowserPromptNote({ kind: "wired" }), "");
  const refused: HarnessBrowserWiring = { kind: "refused", reason: "No browser is available in this run: X." };
  assert.equal(harnessBrowserPromptNote(refused), "\n\nNo browser is available in this run: X.");
});

// ---------------------------------------------------------------------------
// Per-harness config generation
// ---------------------------------------------------------------------------

test("claudeMcpConfig is the exact mcpServers file for --mcp-config", () => {
  assert.deepEqual(JSON.parse(claudeMcpConfig()), {
    mcpServers: { browser: { type: "stdio", command: "playwright-mcp", args: ["--cdp-endpoint", BROWSER_MCP_CDP_ENDPOINT] } },
  });
});

test("codexMcpConfigFlags are the exact TOML --config overrides", () => {
  assert.equal(
    codexMcpConfigFlags(),
    ` --config 'mcp_servers.browser.command="playwright-mcp"'` +
      ` --config 'mcp_servers.browser.args=["--cdp-endpoint","${BROWSER_MCP_CDP_ENDPOINT}"]'`,
  );
});

test("opencodeConfigWithBrowser merges the local server, preserves the blob, and refuses what it cannot read", () => {
  // Absent blob: the minimal config carrying the server.
  assert.deepEqual(JSON.parse(contentOf(opencodeConfigWithBrowser(undefined))), { mcp: { browser: { type: "local", command: [...BROWSER_MCP_ARGV], enabled: true } } });
  assert.deepEqual(JSON.parse(contentOf(opencodeConfigWithBrowser("  "))), JSON.parse(contentOf(opencodeConfigWithBrowser(undefined))));

  // An operator blob: every field survives, the server is added, and the
  // result is COMPACT (no line breaks: the daemon's env file is one
  // NAME=VALUE per line).
  const blob = JSON.stringify({ model: "zai-coding-plan/glm-5.3", mcp: { docs: { type: "remote", url: "https://mcp.example.com/mcp" } } });
  const merged = JSON.parse(contentOf(opencodeConfigWithBrowser(blob)));
  assert.equal(merged.model, "zai-coding-plan/glm-5.3");
  assert.deepEqual(merged.mcp.docs, { type: "remote", url: "https://mcp.example.com/mcp" });
  assert.deepEqual(merged.mcp.browser, { type: "local", command: [...BROWSER_MCP_ARGV], enabled: true });
  assert.ok(!contentOf(opencodeConfigWithBrowser(blob)).includes("\n"), "compact: a multi-line value would need the base64 carrier");

  // A pretty-printed operator blob merges too — the note is the compact form.
  const pretty = '{\n  "provider": { "anthropic": { "options": { "baseURL": "https://api.z.ai/api/anthropic" } } }\n}\n';
  const prettyMerged = JSON.parse(contentOf(opencodeConfigWithBrowser(pretty)));
  assert.equal(prettyMerged.provider.anthropic.options.baseURL, "https://api.z.ai/api/anthropic");
  assert.deepEqual(prettyMerged.mcp.browser.command, [...BROWSER_MCP_ARGV]);

  // Unreadable blobs refuse the browser, never the run.
  const refusalOf = (raw: string): string => {
    const result = opencodeConfigWithBrowser(raw);
    assert.ok("refusal" in result, `expected a refusal for ${JSON.stringify(raw.slice(0, 40))}`);
    return result.refusal;
  };
  assert.match(refusalOf("not json"), /not JSON/);
  assert.match(refusalOf("[1,2]"), /not a JSON object/);
  assert.match(refusalOf('{"mcp": "x"}'), /mcp section is not a JSON object/);
});

test("opencodeConfigDestinations admits the injected browser entry and keeps refusing every other local server", () => {
  const withBrowser = opencodeConfigWithBrowser('{"provider": {"zhipu": {}}}');
  // The injected entry adds no destination and no refusal; the zhipu default
  // host still derives exactly as before.
  assert.deepEqual(opencodeConfigDestinations(contentOf(withBrowser)), { hosts: ["api.z.ai"] });

  // Any OTHER local command server is exactly the refusal it was before.
  const foreign = JSON.stringify({ mcp: { mine: { type: "local", command: ["npx", "anything"] } } });
  assert.match(opencodeConfigDestinations(foreign).refusal!.why, /mine MCP server that is not a remote server/);

  // The strict shape: same name, wrong argv or type, still refused.
  for (const bad of [
    { type: "local", command: ["playwright-mcp"] },
    { type: "local", command: ["playwright-mcp", "--cdp-endpoint", "http://10.0.0.1:9222"] },
    { type: "local", command: ["npx", "@playwright/mcp", "--cdp-endpoint", BROWSER_MCP_CDP_ENDPOINT] },
    { type: "remote", command: [...BROWSER_MCP_ARGV] },
  ]) {
    assert.equal(isHarnessBrowserMcpServer("browser", bad as unknown as Record<string, unknown>), false, JSON.stringify(bad));
  }
  assert.equal(isHarnessBrowserMcpServer("other", { type: "local", command: [...BROWSER_MCP_ARGV] }), false);
  assert.equal(isHarnessBrowserMcpServer("browser", { type: "local", command: [...BROWSER_MCP_ARGV] }), true);
});

test("acpBrowserMcpServers is the session/new stdio shape with every required field", () => {
  assert.deepEqual(acpBrowserMcpServers(), [
    { name: "browser", command: "playwright-mcp", args: ["--cdp-endpoint", BROWSER_MCP_CDP_ENDPOINT], env: [] },
  ]);
});

// ---------------------------------------------------------------------------
// The shared session
// ---------------------------------------------------------------------------

test("the session start script and shell pin look's spawn contract", () => {
  const script = browserSessionStartScript();
  assert.ok(script.includes(`"${BROWSER_MCP_CDP_ENDPOINT}"`), "the fixed CDP endpoint");
  assert.ok(script.includes(`"${".teploy-agent/look-session.mjs"}"`), "it spawns LOOK's session script, not a second browser");
  assert.ok(script.includes("detached: true"), "detached: the session outlives the exec");
  assert.ok(script.includes("/tmp/ship-look-session.log"), "the same log file the look driver uses");

  const shell = browserSessionShell();
  assert.match(shell, /command -v node/);
  assert.match(shell, /npm root -g/, "the image's global playwright, the lookCommand trick");
  assert.match(shell, /command -v playwright-mcp/, "the baked MCP server itself, named in words when missing");
  assert.match(shell, /ln -sfn "\$pw" \.teploy-agent\/node_modules\/playwright/);
  assert.match(shell, /node \.teploy-agent\/harness-browser-start\.mjs/);
});

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

test("BROWSER_MCP_PACKAGE matches images/versions.json", async () => {
  const versions = JSON.parse(await readFile(new URL("../images/versions.json", import.meta.url), "utf8")) as {
    browserMcp: { npm: string; version: string; binary: string };
  };
  assert.deepEqual(BROWSER_MCP_PACKAGE, versions.browserMcp);
  assert.match(BROWSER_MCP_PACKAGE.version, /^\d+\.\d+\.\d+$/, "exact, never a range");
  // The Dockerfiles bake the same pin (images/build.sh asserts it too).
  for (const stack of ["sandbox-node", "sandbox-go"]) {
    const dockerfile = await readFile(new URL(`../images/${stack}/Dockerfile`, import.meta.url), "utf8");
    assert.ok(dockerfile.includes(`ARG PLAYWRIGHT_MCP_VERSION=${versions.browserMcp.version}`), `${stack} bakes the pin`);
    assert.ok(dockerfile.includes(`npm install -g "@playwright/mcp@`), `${stack} installs it without a browser download`);
  }
});

// ---------------------------------------------------------------------------
// Capability text
// ---------------------------------------------------------------------------

test("every external harness declares the browser partial under the flag; native is untouched", () => {
  for (const id of ["claude-code", "opencode", "codex", "gemini", "grok", "cursor", "qwen"]) {
    const declaration = declarationFor(id)!;
    const browser = declaration.capabilities.browser;
    assert.equal(browser.status, "partial", `${id}: partial, not supported — the flag is off by default`);
    assert.match(browser.reason, /SHIP_HARNESS_BROWSER=on/, `${id}: the reason names the flag`);
    assert.match(browser.reason, /per-run Chromium session/, `${id}: the reason names the shared session`);
    assert.equal(capabilityOf(id, "browser").status, "partial");
  }
  // Native keeps its own declaration untouched by this slice.
  assert.match(declarationFor("native")!.capabilities.browser.reason, /input\.look/);
});

// ---------------------------------------------------------------------------
// Adapter integrations: fake binaries, real adapter code
// ---------------------------------------------------------------------------

/**
 * A workspace whose PATH carries a fake `claude` plus the browser session's
 * stand-ins: a fake `npm` whose global root holds a (fake) playwright
 * directory, and a fake `playwright-mcp` so the shell's baked-server check
 * passes. The CDP endpoint is stubbed by `cdpStub` so the starter finds a
 * session up and never spawns a real browser.
 */
async function claudeRig(opts: { recordTo: string; stream: string }): Promise<{ provider: ExecutorProvider; work: string; bin: string }> {
  const bin = await mkdtemp(join(tmpdir(), "browser-bin-"));
  const work = await mkdtemp(join(tmpdir(), "browser-work-"));
  const fakeGlobal = await mkdtemp(join(tmpdir(), "browser-global-"));
  await mkdir(join(fakeGlobal, "playwright"), { recursive: true });
  const write = async (name: string, script: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await write(
    "claude",
    [
      `if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi`,
      `printf '%s\\n' "$*" >> ${shq(join(opts.recordTo, "args"))}`,
      `printf '%s' "$2" > ${shq(join(opts.recordTo, "prompt"))}`,
      `if [ -f .teploy-agent/claude-mcp.json ]; then cat .teploy-agent/claude-mcp.json > ${shq(join(opts.recordTo, "mcp-config"))}; fi`,
      `echo edited > edited.txt`,
      `cat <<'EOF'\n${opts.stream}\nEOF`,
    ].join("\n"),
  );
  await write("npm", `echo ${shq(fakeGlobal)}`);
  await write("playwright-mcp", "exit 0");
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return { provider: { isolated: true, async create() { return { handle: work }; }, attach: () => executor }, work, bin };
}

/** A stand-in CDP endpoint on the session's port, so the starter's probe succeeds. */
async function cdpStub(): Promise<{ close: () => Promise<void> } | { close: () => Promise<void>; busy: true }> {
  return await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Browser: "HeadlessChromium stub" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once("error", () => resolve({ close: async () => {}, busy: true }));
    server.listen(9222, "127.0.0.1", () => resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }));
  });
}

const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "done",
  session_id: "sess-browser-1",
  usage: { input_tokens: 1, output_tokens: 1 },
});

test("claude-code with the flag ON and the default tier: --mcp-config rides, the config and session files are written, look's session bytes start it", async (t) => {
  const stub = await cdpStub();
  if ("busy" in stub) return t.skip("port 9222 is busy on this machine");
  try {
    const recordTo = await mkdtemp(join(tmpdir(), "browser-rec-"));
    const { provider, work } = await claudeRig({ recordTo, stream: CLAUDE_RESULT });
    const wf = durableAgent({
      model: neverModel,
      executor: provider,
      workdir: ".",
      harnesses: externalAdapters({ env: { SHIP_HARNESS_BROWSER: "on", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" } }),
      maxSteps: 7,
    });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-browser-on",
      store,
      input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const args = await readFile(join(recordTo, "args"), "utf8");
    assert.match(args, /--mcp-config \.teploy-agent\/claude-mcp\.json/);
    // The config file the flag points at, as the vendor itself could read it
    // at exec time (the adapter deletes it in its own finally).
    assert.deepEqual(JSON.parse(await readFile(join(recordTo, "mcp-config"), "utf8")), JSON.parse(claudeMcpConfig()));
    // The session contract: look's own bytes, plus this slice's starter.
    assert.equal(await readFile(join(work, ".teploy-agent/look-session.mjs"), "utf8"), lookSessionScript(false));
    const starter = await readFile(join(work, ".teploy-agent/harness-browser-start.mjs"), "utf8");
    assert.equal(starter, browserSessionStartScript());
    // The prompt carries no refusal note on a wired run.
    const prompt = await readFile(join(recordTo, "prompt"), "utf8");
    assert.doesNotMatch(prompt, /No browser is available/);
  } finally {
    await stub.close();
  }
});

test("claude-code with the flag OFF: the command is byte-identical — no --mcp-config, no session files", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "browser-rec-"));
  const { provider, work } = await claudeRig({ recordTo, stream: CLAUDE_RESULT });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" } }),
    maxSteps: 7,
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-browser-off",
    store,
    input: { task: "t", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.doesNotMatch(args, /--mcp-config/);
  assert.doesNotMatch(args, /browser/i);
  await assert.rejects(readFile(join(work, ".teploy-agent/look-session.mjs"), "utf8"), /ENOENT/, "no session was started");
});

test("claude-code with the flag ON but a SEALED tier: no browser is wired, the prompt says so in look's words", async () => {
  const recordTo = await mkdtemp(join(tmpdir(), "browser-rec-"));
  const { provider, work } = await claudeRig({ recordTo, stream: CLAUDE_RESULT });
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { SHIP_HARNESS_BROWSER: "on", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" } }),
    maxSteps: 7,
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-browser-sealed",
    store,
    input: { task: "t", sandboxNetwork: "none", harness: { id: "claude-code", version: HARNESS_VERSIONS["claude-code"] } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const args = await readFile(join(recordTo, "args"), "utf8");
  assert.doesNotMatch(args, /--mcp-config/);
  const prompt = await readFile(join(recordTo, "prompt"), "utf8");
  assert.match(prompt, /network tier is sealed \(none\)/);
  await assert.rejects(readFile(join(work, ".teploy-agent/look-session.mjs"), "utf8"), /ENOENT/, "nothing was started");
});

test("opencode with the flag ON: the merged config blob reaches the vendor's env", async (t) => {
  const stub = await cdpStub();
  if ("busy" in stub) return t.skip("port 9222 is busy on this machine");
  try {
    const recordTo = await mkdtemp(join(tmpdir(), "browser-rec-"));
    const bin = await mkdtemp(join(tmpdir(), "browser-bin-"));
    const work = await mkdtemp(join(tmpdir(), "browser-work-"));
    const fakeGlobal = await mkdtemp(join(tmpdir(), "browser-global-"));
    await mkdir(join(fakeGlobal, "playwright"), { recursive: true });
    const write = async (name: string, script: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
      await chmod(join(bin, name), 0o755);
    };
    // The v2 line: --version reports 2.0.26 so the adapter takes the measured contract.
    await write(
      "opencode",
      [
        `if [ "$1" = "--version" ]; then echo "2.0.26 (fake)"; exit 0; fi`,
        `printf '%s' "$OPENCODE_CONFIG_CONTENT" > ${shq(join(recordTo, "config"))}`,
        `cat <<'EOF'`,
        `{"type":"step_start","part":{"messageID":"msg_1"}}`,
        `{"type":"text","part":{"text":"done"}}`,
        `EOF`,
      ].join("\n"),
    );
    await write("npm", `echo ${shq(fakeGlobal)}`);
    await write("playwright-mcp", "exit 0");
    const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const provider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor } as ExecutorProvider;
    const wf = durableAgent({
      model: neverModel,
      executor: provider,
      workdir: ".",
      harnesses: externalAdapters({
        env: { SHIP_HARNESS_BROWSER: "on", OPENAI_API_KEY: "sk-fake-openai", OPENCODE_CONFIG_CONTENT: '{"model":"zai-coding-plan/glm-5.3"}' },
      }),
      maxSteps: 7,
    });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-browser-opencode",
      store,
      input: { task: "t", harness: { id: "opencode", version: HARNESS_VERSIONS.opencode } },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const seen = JSON.parse(await readFile(join(recordTo, "config"), "utf8"));
    assert.equal(seen.model, "zai-coding-plan/glm-5.3", "the operator's own config survives the merge");
    assert.deepEqual(seen.mcp.browser, { type: "local", command: [...BROWSER_MCP_ARGV], enabled: true });
  } finally {
    await stub.close();
  }
});

test("the ACP driver passes the browser server through session/new only when the flag wired it", async (t) => {
  const stub = await cdpStub();
  if ("busy" in stub) return t.skip("port 9222 is busy on this machine");
  try {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const PEER = join(HERE, "..", "src", "fixtures", "acp-mock-peer.mjs");
    const DRIVER = `node ${shq(join(HERE, "..", "images", "acp-driver", "ship-acp.mjs"))}`;
    const run = async (browser: string): Promise<Array<{ name: string | null } | null> | null> => {
      const bin = await mkdtemp(join(tmpdir(), "acp-browser-bin-"));
      const work = await mkdtemp(join(tmpdir(), "acp-browser-work-"));
      const rec = await mkdtemp(join(tmpdir(), "acp-browser-rec-"));
      const fakeGlobal = await mkdtemp(join(tmpdir(), "acp-browser-global-"));
      await mkdir(join(fakeGlobal, "playwright"), { recursive: true });
      const log = join(rec, "peer.jsonl");
      const write = async (name: string, script: string) => {
        await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
        await chmod(join(bin, name), 0o755);
      };
      await write("gemini", `exec node ${shq(PEER)} "$@"`);
      await write("npm", `echo ${shq(fakeGlobal)}`);
      await write("playwright-mcp", "exit 0");
      const executor = new LocalExecutor({
        root: work,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ACP_MOCK_LOG: log, SHIP_ACP_DRIVER: DRIVER, ...(browser === "on" ? { SHIP_HARNESS_BROWSER: "on" } : {}) },
      });
      const provider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor } as ExecutorProvider;
      const wf = durableAgent({
        model: neverModel,
        executor: provider,
        workdir: ".",
        harnesses: acpAdapters({ env: { GEMINI_API_KEY: "gemini-fake-key-0123456789", SHIP_ACP_DRIVER: DRIVER, ...(browser === "on" ? { SHIP_HARNESS_BROWSER: "on" } : {}) } }),
        maxSteps: 7,
      });
      const store = new MemoryEventStore();
      const outcome = await executeRun({
        workflow: wf,
        runId: `run-acp-browser-${browser}`,
        store,
        input: { task: "Write the notes file", harness: { id: "gemini", version: HARNESS_VERSIONS.gemini } },
      });
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      const events = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const sessionNew = events.find((e) => e.event === "session-new")!;
      return (sessionNew.mcpServers as Array<{ name: string | null } | null> | null) ?? null;
    };
    assert.equal(await run("off"), null, "flag off: session/new carries no mcpServers at all");
    assert.deepEqual(await run("on"), [{ name: "browser", command: "playwright-mcp" }], "flag on: the browser server rides session/new");
  } finally {
    await stub.close();
  }
});
