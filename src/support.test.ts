import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SECRET_PATTERNS } from "./secret-patterns.js";
import { FORBIDDEN_KEY, RedactionGate, assembleSupportBundle, configSummary, tailLines, terminalError } from "./support.js";
import type { SupportDeps, SupportStoreReader } from "./support.js";
import type { RunMeta } from "./run-store.js";

// Synthetic fixture material ONLY. Nothing here is a real credential; every
// shape is a documented example or generated filler, and the scanner allows
// this file for exactly that reason.
const GHP_TOKEN = `ghp_${"a1".repeat(18)}`;
const SK_KEY = `sk-${"b2".repeat(16)}`;
const SLACK_TOKEN = `xoxb-${"1234567890"}${"abcdefghij"}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const DB_URL = "postgres://ship:supersecret@db.internal:5432/ship";

const NOW = new Date("2026-09-23T12:00:00Z");

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test("the gate kills every shared scan-secrets pattern class", () => {
  const fixtures: Array<[string, string]> = [
    ["private key block", `-----BEGIN RSA PRIVATE KEY-----\nMIIfake${"A".repeat(64)}\n-----END RSA PRIVATE KEY-----`],
    ["AWS access key id", `deploying with ${AWS_KEY} today`],
    ["GitHub token", `git push with ${GHP_TOKEN} please`],
    ["Slack token", `slack webhook ${SLACK_TOKEN} failed`],
    ["OpenAI-style key", `Authorization header had ${SK_KEY}`],
    ["credential in a URL", `connecting to ${DB_URL} failed`],
  ];
  for (const [name, poison] of fixtures) {
    const gate = new RedactionGate();
    const out = gate.redact(poison);
    // The credential body itself must be gone, whatever marker replaced it.
    const secretPart = name === "credential in a URL" ? "supersecret" : name === "private key block" ? "BEGIN RSA" : poison.split(/\s+/).find((w) => /AKIA|ghp_|xox|sk-/.test(w)) ?? "";
    assert.ok(!out.includes(secretPart), `${name}: redacted output still carries the secret: ${out}`);
    assert.ok(gate.total >= 1, `${name}: the redaction was counted`);
    // A marker is present (the URL class is rewritten by the earlier userinfo
    // rule, whose marker is the bare [REDACTED] form).
    assert.ok(out.includes("[REDACTED"), `${name}: a marker is present`);
  }
  // The shared set and the gate cannot silently disagree: every pattern name
  // is a counting category.
  const gate = new RedactionGate();
  gate.redact(`${GHP_TOKEN} ${AWS_KEY}`);
  for (const name of ["GitHub token", "AWS access key id"]) {
    assert.ok(gate.counts[name] !== undefined, `${name} is a gate category`);
  }
  assert.equal(SECRET_PATTERNS.length, 6, "the shared pattern set is the six scan-secrets shapes");
});

test("userinfo URLs lose the userinfo, not the host — with or without a password", () => {
  const gate = new RedactionGate();
  assert.equal(gate.redact("postgres://ship:supersecret@db.internal:5432/ship"), "postgres://[REDACTED]@db.internal:5432/ship");
  assert.equal(gate.redact("postgres://ship@db.internal:5432/ship"), "postgres://[REDACTED]@db.internal:5432/ship");
  assert.equal(gate.redact("https://user:pass@example.com/x"), "https://[REDACTED]@example.com/x");
  assert.equal(gate.counts["url-userinfo"], 3);
});

test("bearer tokens and full private key blocks are redacted", () => {
  const gate = new RedactionGate();
  const out = gate.redact("Authorization: Bearer abcdef1234567890abcdef");
  assert.ok(!out.includes("abcdef1234567890"), "bearer credential gone");
  assert.ok(out.includes("Bearer [REDACTED:bearer-token]"), "bearer shape preserved");
  const body = `MIIfake${"Z".repeat(200)}`;
  const key = gate.redact(`cert:\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ndone`);
  assert.ok(!key.includes(body), "key BODY is gone, not just the header line");
  assert.ok(!key.includes("BEGIN"), "no header fragment survives");
  // Prose about bearer tokens is not a credential and survives.
  const prose = new RedactionGate().redact("We use bearer token auth here.");
  assert.equal(prose, "We use bearer token auth here.");
});

test("TOKEN/SECRET/KEY/PASSWORD-named assignments lose the value, not the name", () => {
  const gate = new RedactionGate();
  assert.equal(gate.redact("SHIP_WEB_TOKEN=abcdef123456"), "SHIP_WEB_TOKEN=[REDACTED]");
  assert.equal(gate.redact('FOO_PASSWORD: "hunter2hunter"'), 'FOO_PASSWORD: "[REDACTED]"');
  assert.equal(gate.redact("export SHIP_GIT_TOKEN='gh-secret-secret-1';"), "export SHIP_GIT_TOKEN='[REDACTED]';");
  assert.equal(gate.counts["credential-assignment"], 3);
  // Non-credential settings keep their values — the gate must stay readable.
  const untouched = new RedactionGate().redact("SHIP_MAX_STEPS=20 SHIP_MIN_FREE_MB=512");
  assert.equal(untouched, "SHIP_MAX_STEPS=20 SHIP_MIN_FREE_MB=512");
});

test("the gate is idempotent — its own markers cannot re-match", () => {
  const once = "token " + GHP_TOKEN + " at " + DB_URL;
  const gate = new RedactionGate();
  const pass1 = gate.redact(once);
  const gate2 = new RedactionGate();
  const pass2 = gate2.redact(pass1);
  assert.equal(pass1, pass2, "a second pass changes nothing");
});

test("redactJson redacts string values and keeps the JSON parseable", () => {
  const gate = new RedactionGate();
  const value = { url: DB_URL, note: `token ${GHP_TOKEN}`, nested: [{ key: SK_KEY }], n: 3, b: true };
  const out = gate.redactJson(value) as ReturnType<typeof JSON.parse>;
  const text = JSON.stringify(out);
  JSON.parse(text);
  assert.ok(!text.includes("supersecret") && !text.includes(GHP_TOKEN) && !text.includes(SK_KEY));
  assert.equal(out.n, 3);
  assert.equal(out.b, true);
});

// ---------------------------------------------------------------------------
// the config whitelist
// ---------------------------------------------------------------------------

test("the config summary is whitelist-only and never emits a credential-named key or value", () => {
  const env = {
    SHIP_MODEL: "zai/glm-5.3",
    SHIP_HARNESS_MODEL: "zai/glm-5.3",
    SHIP_MAX_STEPS: "40",
    SHIP_SANDBOX_TTL_SEC: "7200",
    SHIP_WARM_PARKS: "1",
    SHIP_PUBLIC_URL: "https://ship.example.com:7460/",
    SHIP_TELEMETRY: "true",
    SHIP_INTAKE_POLICIES: '{"forgejo":"auto"}',
    SHIP_MIN_FREE_MB: "2048",
    SHIP_MAX_CONCURRENT_RUNS: "3",
    // Poison: everything the real deployment carries must not survive.
    SHIP_WEB_TOKEN: GHP_TOKEN,
    SHIP_GIT_TOKEN: "git-secret-secret-123",
    SHIP_SANDBOX_TOKEN: "sandbox-secret-secret-123",
    AI_GATEWAY_KEY: SK_KEY,
    NUCLEUS_URL: DB_URL,
  };
  const summary = configSummary(env, {
    model: "config/model",
    intake: { github: "propose" },
    maxConcurrentRuns: 9,
    nucleusUrl: "postgres://cfg:cfgpass@cfg-host:5432/x",
  });
  const keys = Object.keys(summary);
  for (const key of keys) {
    assert.ok(!FORBIDDEN_KEY.test(key), `forbidden key name emitted: ${key}`);
  }
  // Env won where both define it; the config file filled the rest.
  assert.equal(summary.SHIP_MODEL, "zai/glm-5.3");
  assert.equal(summary.SHIP_MAX_CONCURRENT_RUNS, 3);
  assert.deepEqual(summary.SHIP_INTAKE_POLICIES, { forgejo: "auto" });
  // URLs degrade to the host, never the string.
  assert.equal(summary.SHIP_PUBLIC_URL, "ship.example.com:7460");
  const text = JSON.stringify(summary);
  for (const poison of [GHP_TOKEN, "git-secret", "sandbox-secret", SK_KEY, "supersecret", "cfgpass"]) {
    assert.ok(!text.includes(poison), `config summary leaked: ${poison}`);
  }
  // Nothing outside the whitelist appears, no matter what env carries.
  const allowed = new Set([
    "SHIP_MODEL",
    "SHIP_HARNESS_MODEL",
    "SHIP_MAX_STEPS",
    "SHIP_SANDBOX_TTL_SEC",
    "SHIP_WARM_PARKS",
    "SHIP_PUBLIC_URL",
    "SHIP_TELEMETRY",
    "SHIP_INTAKE_POLICIES",
    "SHIP_MIN_FREE_MB",
    "SHIP_MAX_CONCURRENT_RUNS",
  ]);
  for (const key of keys) assert.ok(allowed.has(key), `key outside the whitelist: ${key}`);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("tailLines keeps the LAST n lines", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
  const out = tailLines(text, 10);
  assert.equal(out, Array.from({ length: 10 }, (_, i) => `line-${40 + i}`).join("\n"));
  assert.equal(tailLines("a\nb", 10), "a\nb");
});

test("terminalError prefers the outright failure over the earlier step failure, one line only", () => {
  const events = [
    { type: "run-started", at: "2026-09-23T10:00:00Z" },
    { type: "step-failed", at: "2026-09-23T10:01:00Z", name: "turn-3-exec", data: { error: "exit 1\nstderr spew\nmore" } },
    { type: "run-failed", at: "2026-09-23T10:02:00Z", data: { error: `model call failed (${SK_KEY})\nretry trace` } },
  ];
  // Extraction only — the gate runs over the extracted row at assembly time
  // (asserted in the bundle test). Here: first line, outright failure wins.
  assert.equal(terminalError(events), `model call failed (${SK_KEY})`);
  const stepOnly = [
    { type: "run-started", at: "2026-09-23T10:00:00Z" },
    { type: "step-failed", at: "2026-09-23T10:01:00Z", name: "turn-0-exec", data: { error: "command not found" } },
  ];
  assert.equal(terminalError(stepOnly), "turn-0-exec: command not found");
});

// ---------------------------------------------------------------------------
// bundle assembly
// ---------------------------------------------------------------------------

interface FakeEvents {
  [runId: string]: Array<Record<string, unknown>>;
}

function meta(runId: string, status: string, createdAt: string, updatedAt?: string): RunMeta {
  return { runId, status, task: `task ${runId}`, model: "zai/glm-5.3", createdAt, updatedAt: updatedAt ?? createdAt } as RunMeta;
}

function fakeStore(metas: RunMeta[], events: FakeEvents): SupportStoreReader {
  return {
    listMeta: async (options?: { limit?: number }) =>
      [...metas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, options?.limit ?? metas.length),
    store: { load: async (runId: string) => events[runId] ?? [] },
    fleet: { list: async () => [] },
  } as unknown as SupportStoreReader;
}

function bundleDeps(overrides: Partial<SupportDeps> & { store: SupportStoreReader; outDir: string }): SupportDeps {
  return {
    now: () => NOW,
    env: {},
    hostname: () => "box.example.internal",
    processUptimeSec: () => 1.234,
    nodeVersion: () => "v22.0.0",
    readPackage: () => ({ version: "0.2.1-test", dependencies: { "z-pkg": "1.0.0", "a-pkg": "2.0.0" } }),
    teployVersion: () => "0.1.36",
    makeTgz: async (dir) => `${dir}.tgz`,
    ...overrides,
  };
}

/** Every text file in the bundle dir, recursively — the leak scan reads them all. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

test("a bundle from a fake store carries manifest+versions+runs-summary, bounded and redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-support-test-"));
  try {
    const metas: RunMeta[] = [];
    const events: FakeEvents = {};
    for (let i = 0; i < 25; i++) {
      const id = `run-${String(i).padStart(2, "0")}`;
      const at = new Date(NOW.getTime() - i * 60_000).toISOString();
      const status = i % 5 === 0 ? "failed" : i % 5 === 1 ? "waiting" : "completed";
      metas.push(meta(id, status, at));
      events[id] = [
        { type: "run-started", at, data: { input: { repo: "https://forge.example/tyler/app" } } },
        ...(status === "completed"
          ? [{ type: "run-completed", at, data: { output: { turns: 4, costUSD: 0.12 + i / 100 } } }]
          : []),
        ...(status === "failed"
          ? [{ type: "run-failed", at, data: { error: `model 500 after retries (${GHP_TOKEN})\ntrace` } }]
          : []),
      ];
    }
    const longLog = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join("\n");
    const docker = {
      containers: async () => ["ship-web-abc123", "ship-worker-def456", "unrelated-container"],
      logs: async (name: string) => (name === "ship-web-abc123" ? `${longLog}\npush failed token ${GHP_TOKEN}` : `quiet: ${name}`),
    };

    const result = await assembleSupportBundle(
      bundleDeps({
        outDir: dir,
        store: fakeStore(metas, events),
        logLines: 10,
        docker,
      }),
    );

    // Bounded rows: 20 most recent of 25.
    const runs = JSON.parse(readFileSync(join(dir, "runs-summary.json"), "utf8"));
    assert.equal(runs.recent.length, 20);
    assert.equal(runs.totalInWindow, 25);
    assert.equal(runs.countsByState.completed + runs.countsByState.failed + runs.countsByState.waiting, 25);
    const failed = runs.recent.find((r: { state: string }) => r.state === "failed");
    assert.ok(failed !== undefined, "a failed row exists");
    assert.ok(failed.error.includes("[REDACTED:github-token]"), `failed row error is redacted: ${failed.error}`);
    assert.ok(!failed.error.includes("\n"), "the error is one line");
    const done = runs.recent.find((r: { state: string; costUsd?: number }) => r.state === "completed");
    assert.ok(done.costUsd > 0, "attributed cost is present");

    // manifest: build identity + bounds, self-describing.
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.hostname, "box.example.internal");
    assert.equal(manifest.shipVersion, "0.2.1-test");
    assert.equal(manifest.scriptVersion, 1);
    assert.equal(manifest.logLines, 10);
    assert.ok(typeof manifest.buildFingerprint === "string" && manifest.buildFingerprint.length > 0);

    // versions: name@version only, sorted; nucleus host only; teploy pin.
    const versions = JSON.parse(readFileSync(join(dir, "versions.json"), "utf8"));
    assert.deepEqual(versions.dependencies, ["a-pkg@2.0.0", "z-pkg@1.0.0"]);
    assert.equal(versions.teployCli, "0.1.36");

    // selfwatch ran against the same store.
    const selfwatch = readFileSync(join(dir, "selfwatch.txt"), "utf8");
    assert.ok(selfwatch.includes("# selfwatch health snapshot"));

    // logs: only prefixed containers, locally clamped, redacted.
    const logText = readFileSync(join(dir, "logs", "ship-web-abc123.log"), "utf8");
    assert.ok(!logText.includes("log line 5\n"), "old lines dropped");
    assert.ok(logText.includes("log line 499"), "the tail is the part kept");
    assert.equal(logText.trim().split("\n").length, 10, "exactly logLines lines");
    assert.ok(logText.includes("[REDACTED:github-token]"), "the poisoned line came out redacted");
    const logNames = readdirSync(join(dir, "logs"));
    assert.ok(!logNames.some((n) => n.includes("unrelated")), "unprefixed containers are not collected");
    assert.ok(logNames.includes("ship-worker-def456.log"));

    // The report uses the counting categories (the shared pattern names).
    const report = readFileSync(join(dir, "REDACTION-REPORT.txt"), "utf8");
    assert.ok(report.includes("GitHub token"), report);

    // tgz path is reported (fake archiver), not asserted as a file.
    assert.equal(result.tgz, `${dir}.tgz`);

    // The whole bundle, file by file, carries none of the poison.
    for (const path of walkFiles(dir)) {
      const text = readFileSync(path, "utf8");
      for (const poison of [GHP_TOKEN, SK_KEY, SLACK_TOKEN, "supersecret"]) {
        assert.ok(!text.includes(poison), `${path} leaked ${poison.slice(0, 8)}…`);
      }
    }
    assert.ok(result.redactionTotal > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no docker means a note file, not a missing directory and not a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-support-test-"));
  try {
    await assembleSupportBundle(bundleDeps({ outDir: dir, store: fakeStore([], {}) }));
    const note = readFileSync(join(dir, "logs", "docker-unavailable.txt"), "utf8");
    assert.ok(note.includes("docker"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--days bounds the runs window by createdAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-support-test-"));
  try {
    const fresh = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const old = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const metas = [meta("run-fresh", "completed", fresh), meta("run-old", "completed", old)];
    await assembleSupportBundle(bundleDeps({ outDir: dir, store: fakeStore(metas, {}), days: 7 }));
    const runs = JSON.parse(readFileSync(join(dir, "runs-summary.json"), "utf8"));
    assert.equal(runs.totalInWindow, 1);
    assert.equal(runs.recent[0].id, "run-fresh");
    assert.ok(runs.window.since !== undefined, "the window is self-describing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the config summary and versions never carry the Nucleus URL's credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-support-test-"));
  try {
    await assembleSupportBundle(
      bundleDeps({
        outDir: dir,
        store: fakeStore([], {}),
        env: { NUCLEUS_URL: DB_URL, SHIP_MODEL: "zai/glm-5.3", SHIP_WEB_TOKEN: GHP_TOKEN },
      }),
    );
    const versions = JSON.parse(readFileSync(join(dir, "versions.json"), "utf8"));
    assert.equal(versions.nucleusHost, "db.internal:5432");
    const summary = JSON.parse(readFileSync(join(dir, "config-summary.json"), "utf8"));
    assert.deepEqual(Object.keys(summary), ["SHIP_MODEL"]);
    for (const path of walkFiles(dir)) {
      const text = readFileSync(path, "utf8");
      assert.ok(!text.includes("supersecret") && !text.includes(GHP_TOKEN), `${path} leaked`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
