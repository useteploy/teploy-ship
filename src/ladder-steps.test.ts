import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import type { WorkflowContext, WorkflowEvent } from "@neutron-build/workflow";

import type { DurableAgentConfig, DurableAgentInput } from "./durable.js";
import type { CommandRunner, PreviewTarget } from "./deploy.js";
import { buildIfDeclared, comparePngs, flowIfPresent, mainUrlOf, observeIfDeclared, recordLadder, smokeIfDeclared, visualIfDeclared } from "./ladder-steps.js";
import { PNG } from "pngjs";
import type { ServiceHealth } from "./observe.js";

/**
 * A ctx that executes every step immediately and remembers what ran. The
 * durable tests drive the real engine; these are unit tests of the steps
 * themselves, so the smallest honest stand-in is a step() that runs the body
 * once and records the result.
 */
function fakeCtx(): { ctx: WorkflowContext; steps: Array<{ name: string; result: unknown }> } {
  const steps: Array<{ name: string; result: unknown }> = [];
  const ctx = {
    runId: "run-ladder-test",
    step: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      const result = await fn();
      steps.push({ name, result });
      return result;
    },
  } as unknown as WorkflowContext;
  return { ctx, steps };
}

async function localExecutor(): Promise<{ exec: AgentExecutor; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ladder-steps-"));
  return { exec: new LocalExecutor({ root: dir }), dir };
}

const BASE_INPUT: DurableAgentInput = { task: "t" };

// --- build -------------------------------------------------------------------

test("build: declared runs the project's command as a suite outcome; undeclared records nothing", async () => {
  const { ctx, steps } = fakeCtx();
  const { exec } = await localExecutor();
  const built = await buildIfDeclared(ctx, exec, { ...BASE_INPUT, verification: { build: "printf built > built.txt" } });
  assert.equal(built?.kind, "passed");
  assert.equal(steps[0]?.name, "build");

  const none = await buildIfDeclared(ctx, exec, BASE_INPUT);
  assert.equal(none, undefined, "no declaration, no step — the replay rule");
  assert.equal(steps.length, 1);
});

test("build: a failing build is a failed outcome, not a thrown one", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const built = await buildIfDeclared(ctx, exec, { ...BASE_INPUT, verification: { build: "exit 4" } });
  assert.equal(built?.kind, "failed");
  if (built?.kind === "failed") assert.equal(built.exitCode, 4);
});

// --- smoke -------------------------------------------------------------------

test("smoke: runs the project's command in the sandbox with PREVIEW_URL set", async () => {
  const { ctx, steps } = fakeCtx();
  const { exec } = await localExecutor();
  const outcome = await smokeIfDeclared(
    ctx,
    exec,
    { ...BASE_INPUT, verification: { preview: { app: "site", smoke: 'test -n "$PREVIEW_URL" && test "$PREVIEW_URL" = https://p.example.com' } } },
    { kind: "deployed", url: "https://p.example.com", image: "img" },
  );
  assert.equal(outcome?.kind, "passed");
  assert.equal(steps[0]?.name, "preview-smoke");
});

test("smoke: a failing command reports its output; no preview is a skip with the reason", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const failed = await smokeIfDeclared(
    ctx,
    exec,
    { ...BASE_INPUT, verification: { preview: { app: "site", smoke: "echo nope >&2; exit 9" } } },
    { kind: "deployed", url: "https://p.example.com", image: "img" },
  );
  assert.equal(failed?.kind, "failed");
  if (failed?.kind === "failed") {
    assert.equal(failed.exitCode, 9);
    assert.match(failed.output, /nope/);
  }

  const noPreview = await smokeIfDeclared(ctx, exec, { ...BASE_INPUT, verification: { preview: { app: "site", smoke: "true" } } }, undefined);
  assert.equal(noPreview?.kind, "skipped");
  if (noPreview?.kind === "skipped") assert.match(noPreview.reason, /no preview was deployed/);

  const failedDeploy = await smokeIfDeclared(
    ctx,
    exec,
    { ...BASE_INPUT, verification: { preview: { app: "site", smoke: "true" } } },
    { kind: "failed", reason: "teploy build failed" },
  );
  assert.equal(failedDeploy?.kind, "skipped");
  if (failedDeploy?.kind === "skipped") assert.match(failedDeploy.reason, /no preview to smoke/);
});

// --- mainUrlOf ---------------------------------------------------------------

test("mainUrlOf: a preview-<branch>.<domain> URL yields main; anything else is honestly null", () => {
  assert.equal(mainUrlOf("https://preview-ship-abc.site.example.com/"), "https://site.example.com/");
  assert.equal(mainUrlOf("https://site.example.com/"), null, "no preview label to strip");
  assert.equal(mainUrlOf("https://example.com/"), null, "bare domain, no space for main");
  assert.equal(mainUrlOf("not a url"), null);
});

// --- visual ------------------------------------------------------------------

test("visual: skipped with the reason when the sandbox image has no browser — and the rung holds on it", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const outcome = await visualIfDeclared(
    ctx,
    exec,
    { ...BASE_INPUT, verification: { visual: true } },
    { kind: "deployed", url: "https://preview-ship-x.site.example.com", image: "img" },
  );
  // A dev laptop may legitimately carry none of the four browser names on PATH.
  assert.ok(outcome?.kind === "skipped" || outcome?.kind === "captured" || outcome?.kind === "failed");
  if (outcome?.kind === "skipped") assert.match(outcome.reason, /no headless browser/);
});

test("visual: with a browser on PATH, both screenshots are captured inside the workspace and cleaned up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ladder-steps-visual-"));
  // A fake `chromium` that honours --screenshot=<file>: enough of the real
  // command shape to prove the paths, the hashing and the cleanup.
  const binDir = await mkdtemp(join(tmpdir(), "ladder-steps-bin-"));
  const exec = new LocalExecutor({ root: dir });
  await exec.exec(`mkdir -p '${binDir}' && printf '#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) out="${'$'}{a#--screenshot=}";; esac; done\nprintf fake-png-bytes > "$out"\n' > '${binDir}/chromium' && chmod +x '${binDir}/chromium'`);
  const { ctx } = fakeCtx();
  const path = process.env.PATH;
  process.env.PATH = `${binDir}:${path ?? ""}`;
  try {
    const outcome = await visualIfDeclared(
      ctx,
      exec,
      { ...BASE_INPUT, verification: { visual: true } },
      { kind: "deployed", url: "https://preview-ship-x.site.example.com", image: "img" },
    );
    if (outcome?.kind === "skipped") return; // a real browser on PATH hijacked the probe; the skip path is covered above
    assert.equal(outcome?.kind, "captured");
    if (outcome?.kind === "captured") {
      assert.equal(outcome.differs, false, "the fake browser writes identical bytes");
      assert.equal(outcome.preview.sha256, outcome.main.sha256);
      assert.equal(outcome.main.url, "https://site.example.com/", "main is derived from the preview host");
    }
    const left = await exec.exec("ls .ship-visual-preview.png .ship-visual-main.png 2>/dev/null | wc -l");
    assert.equal(left.stdout.trim(), "0", "the screenshots are removed after reading — they sit in the repo tree");
  } finally {
    process.env.PATH = path;
  }
});

test("visual: no preview or an underivable main URL skips with the reason", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const none = await visualIfDeclared(ctx, exec, { ...BASE_INPUT, verification: { visual: true } }, undefined);
  assert.equal(none?.kind, "skipped");
  const odd = await visualIfDeclared(ctx, exec, { ...BASE_INPUT, verification: { visual: true } }, { kind: "deployed", url: "https://example.com/", image: "i" });
  assert.equal(odd?.kind, "skipped");
  if (odd?.kind === "skipped") assert.match(odd.reason, /could not derive main/);
});

test("comparePngs: counts differing pixels, ignores anti-aliasing, and declines on size or decode mismatch", () => {
  const png = (w: number, h: number, paint: (x: number, y: number) => number): Uint8Array => {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = paint(x, y);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    return new Uint8Array(PNG.sync.write(img));
  };
  const white = png(20, 20, () => 255);
  const same = png(20, 20, () => 255);
  assert.deepEqual(comparePngs(white, same), { differing: 0, total: 400 });
  const spot = png(20, 20, (x, y) => (x >= 5 && x < 10 && y >= 5 && y < 10 ? 0 : 255));
  assert.deepEqual(comparePngs(white, spot), { differing: 25, total: 400 });
  assert.equal(comparePngs(white, png(10, 20, () => 255)), undefined, "different sizes: no pixel verdict, the caller falls back to bytes");
  assert.equal(comparePngs(white, new Uint8Array([1, 2, 3])), undefined, "not a PNG: same");
});

// --- flow --------------------------------------------------------------------

const PREVIEW = { kind: "deployed", url: "https://preview-ship-x.site.example.com", image: "img" } as const;
const WITH_PREVIEW: DurableAgentInput = { ...BASE_INPUT, verification: { preview: { app: "site", smoke: "true" } } };

test("flow: no step without a preview declaration; skipped with the reason when the tree has no script", async () => {
  const { ctx, steps } = fakeCtx();
  const { exec } = await localExecutor();
  assert.equal(await flowIfPresent(ctx, exec, BASE_INPUT, PREVIEW), undefined, "no preview declared, no step — the replay rule");
  assert.equal(steps.length, 0);
  const none = await flowIfPresent(ctx, exec, WITH_PREVIEW, undefined);
  assert.equal(none?.kind, "skipped");
  const noScript = await flowIfPresent(ctx, exec, WITH_PREVIEW, PREVIEW);
  assert.equal(noScript?.kind, "skipped");
  if (noScript?.kind === "skipped") assert.match(noScript.reason, /no \.ship\/flow\.mjs in the tree/);
  assert.equal(steps[1]?.name, "flow");
});

/** A fake global `npm` whose `root -g` holds a playwright directory, so the probe passes without the real package. */
async function fakePlaywrightOnPath(): Promise<{ binDir: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), "ladder-steps-npmroot-"));
  const binDir = await mkdtemp(join(tmpdir(), "ladder-steps-npm-"));
  const local = new LocalExecutor({ root: binDir });
  await local.exec(`mkdir -p '${root}/playwright' && printf '#!/bin/sh\nprintf %s "${root}"\n' > npm && chmod +x npm`);
  const path = process.env.PATH;
  process.env.PATH = `${binDir}:${path ?? ""}`;
  return { binDir, restore: () => { process.env.PATH = path; } };
}

test("flow: the script runs against the preview URL, its PNGs are hashed and attached in name order, and its output is cleaned up", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const fake = await fakePlaywrightOnPath();
  try {
    // A flow that needs no browser: it proves the contract (argv, output dir,
    // the playwright link) rather than Chromium.
    await exec.exec(`mkdir -p .ship && cat > .ship/flow.mjs <<'EOF'
import { writeFileSync, existsSync } from "node:fs";
const [url, out] = process.argv.slice(2);
if (url !== "https://preview-ship-x.site.example.com") throw new Error("wrong url " + url);
if (process.env.PREVIEW_URL !== url) throw new Error("PREVIEW_URL not set");
if (!existsSync(".ship/node_modules/playwright")) throw new Error("playwright not linked");
writeFileSync(out + "/02-after.png", "b");
writeFileSync(out + "/01-before.png", "a");
writeFileSync(out + "/notes.txt", "ignored");
console.log("drove the page");
EOF`);
    const uploads: string[] = [];
    const sink = { upload: async (name: string, bytes: Uint8Array) => { uploads.push(`${name}:${bytes.byteLength}`); return `http://f/${name}`; } };
    const outcome = await flowIfPresent(ctx, exec, WITH_PREVIEW, PREVIEW, sink);
    assert.equal(outcome?.kind, "passed");
    if (outcome?.kind === "passed") {
      assert.deepEqual(outcome.shots.map((s) => s.name), ["01-before.png", "02-after.png"], "sorted by name, PNGs only");
      assert.equal(outcome.shots[0]?.asset, "http://f/ship-run-ladder-test-flow-01-before.png");
      assert.equal(outcome.script, ".ship/flow.mjs");
    }
    assert.deepEqual(uploads, ["ship-run-ladder-test-flow-01-before.png:1", "ship-run-ladder-test-flow-02-after.png:1"]);
    const left = await exec.exec("ls -d .ship/flow-out .ship/node_modules 2>/dev/null | wc -l");
    assert.equal(left.stdout.trim(), "0", "output and the link are removed; the script stays");
    assert.equal((await exec.exec("test -f .ship/flow.mjs")).exitCode, 0);

    // A failing flow keeps whatever it managed to screenshot — the picture of
    // where it stopped is the useful one — and never throws.
    await exec.exec(`cat > .ship/flow.mjs <<'EOF'
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/01-stuck.png", "x");
console.error("Error: heading not found");
process.exit(1);
EOF`);
    const failed = await flowIfPresent(ctx, exec, WITH_PREVIEW, PREVIEW);
    assert.equal(failed?.kind, "failed");
    if (failed?.kind === "failed") {
      assert.equal(failed.exitCode, 1);
      assert.match(failed.output, /heading not found/);
      assert.deepEqual(failed.shots.map((s) => s.name), ["01-stuck.png"]);
      assert.equal(failed.shots[0]?.asset, undefined, "no sink, no attachment — the hash still stands");
    }
  } finally {
    fake.restore();
  }
});

test("flow: an upload that fails leaves the shot recorded without an attachment", async () => {
  const { ctx } = fakeCtx();
  const { exec } = await localExecutor();
  const fake = await fakePlaywrightOnPath();
  try {
    await exec.exec(`mkdir -p .ship && printf 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3] + "/01.png", "x");\n' > .ship/flow.mjs`);
    const outcome = await flowIfPresent(ctx, exec, WITH_PREVIEW, PREVIEW, { upload: async () => { throw new Error("413"); } });
    assert.equal(outcome?.kind, "passed");
    if (outcome?.kind === "passed") assert.deepEqual(outcome.shots.map((s) => [s.name, s.asset]), [["01.png", undefined]]);
  } finally {
    fake.restore();
  }
});

// --- observe -----------------------------------------------------------------

const HEALTHY: ServiceHealth = { service: "site", requests: 100, errors: 1, errorRate: 0.01, p50: 5, p95: 40, p99: 80, apdex: 0.95 };

/** A telemetry fetch that answers one summary row per window, by from-time. */
function telemetryFetch(windows: Record<string, Partial<ServiceHealth> | "reject">): typeof fetch {
  return (async (url: unknown) => {
    const qs = new URL(String(url)).searchParams;
    const key = qs.get("from") ?? "";
    const row = windows[key];
    if (row === "reject") return { ok: false, status: 401 } as Response;
    return {
      ok: true,
      json: async () => [{ service_name: "site", request_count: row?.requests ?? 100, error_count: row?.errors ?? 1, p50_ms: row?.p50, p95_ms: row?.p95, p99_ms: row?.p99, apdex_score: row?.apdex }],
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function observeConfig(overrides: {
  fetch: typeof fetch;
  previewRun?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  repo?: string;
}): DurableAgentConfig {
  const target = { url: "https://observe.example.com", token: "t", service: "site", repo: overrides.repo ?? "owner/site", minRequests: 10, fetch: overrides.fetch };
  const preview: PreviewTarget = { dir: "/srv/preview", ...(overrides.previewRun !== undefined ? { run: overrides.previewRun } : {}) };
  return {
    telemetry: target,
    preview,
    ladder: { now: () => new Date("2026-08-28T12:30:00Z"), ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}) },
  } as unknown as DurableAgentConfig;
}

const DEPLOYED_AT = "2026-08-28T12:00:00Z";
// The run is on the repo the telemetry target names — the same guard the
// telemetry-check leg applies (observe.ts telemetryAppliesTo).
const OBSERVE_INPUT: DurableAgentInput = { task: "t", repo: "https://forge.example.com/owner/site.git", verification: { observeWindowMin: 30 } };

test("observe: waits out the window, compares before against after, and passes on a healthy service", async () => {
  const { ctx } = fakeCtx();
  let slept = 0;
  const config = observeConfig({
    // before window [11:30, 12:00], after window [12:00, 12:30] — keyed by from.
    fetch: telemetryFetch({ "2026-08-28T11:30:00.000Z": HEALTHY, "2026-08-28T12:00:00.000Z": HEALTHY }),
    sleep: async (ms) => {
      slept += ms;
    },
  });
  const outcome = await observeIfDeclared(
    ctx,
    config,
    OBSERVE_INPUT,
    { kind: "deployed", url: "https://p", image: "i", deployedAt: DEPLOYED_AT },
    "ship/run-1",
  );
  assert.equal(outcome?.kind, "healthy");
  assert.equal(slept, 0, "deployedAt is 30m in the past — the window has already elapsed");
});

test("observe: a window still in the future is waited for", async () => {
  const { ctx } = fakeCtx();
  let slept = 0;
  const config = observeConfig({
    fetch: telemetryFetch({ "2026-08-28T12:00:00.000Z": HEALTHY, "2026-08-28T12:30:00.000Z": HEALTHY }),
    sleep: async (ms) => {
      slept += ms;
    },
  });
  const outcome = await observeIfDeclared(
    ctx,
    config,
    OBSERVE_INPUT,
    { kind: "deployed", url: "https://p", image: "i", deployedAt: "2026-08-28T12:15:00Z" },
    "ship/run-1",
  );
  assert.equal(outcome?.kind, "healthy");
  assert.equal(slept, 15 * 60_000, "the step anchors on deployedAt, not on when it happened to run");
});

test("observe: a rising error rate is worse and the preview is torn down on the spot", async () => {
  const { ctx } = fakeCtx();
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  const config = observeConfig({
    fetch: telemetryFetch({ "2026-08-28T11:30:00.000Z": HEALTHY, "2026-08-28T12:00:00.000Z": { requests: 100, errors: 8, errorRate: 0.08 } }),
    previewRun: run,
  });
  const outcome = await observeIfDeclared(
    ctx,
    config,
    OBSERVE_INPUT,
    { kind: "deployed", url: "https://p", image: "i", deployedAt: DEPLOYED_AT },
    "ship/run-1",
  );
  assert.equal(outcome?.kind, "worse");
  if (outcome?.kind === "worse") {
    assert.match(outcome.reasons.join(), /error rate up/);
    assert.equal(outcome.rollback.kind, "rolled-back");
  }
  assert.deepEqual(calls.at(-1), ["teploy", "preview", "destroy", "ship/run-1"], "the rollback is the preview's own teardown, never production");
});

test("observe: too little traffic is insufficient — a refusal, not a verdict", async () => {
  const { ctx } = fakeCtx();
  const config = observeConfig({
    fetch: telemetryFetch({ "2026-08-28T11:30:00.000Z": { requests: 3 }, "2026-08-28T12:00:00.000Z": HEALTHY }),
  });
  const outcome = await observeIfDeclared(
    ctx,
    config,
    OBSERVE_INPUT,
    { kind: "deployed", url: "https://p", image: "i", deployedAt: DEPLOYED_AT },
    "ship/run-1",
  );
  assert.equal(outcome?.kind, "insufficient");
  if (outcome?.kind === "insufficient") assert.match(outcome.reason, /too little traffic/);
});

test("observe: a rejected read is unavailable; the wrong repo and a missing preview are disabled with the reason", async () => {
  const { ctx } = fakeCtx();
  const rejected = await observeIfDeclared(
    ctx,
    observeConfig({ fetch: telemetryFetch({ "2026-08-28T11:30:00.000Z": "reject" }) }),
    OBSERVE_INPUT,
    { kind: "deployed", url: "https://p", image: "i", deployedAt: DEPLOYED_AT },
    "ship/run-1",
  );
  assert.equal(rejected?.kind, "unavailable");

  const wrongRepo = await observeIfDeclared(
    ctx,
    observeConfig({ fetch: telemetryFetch({}), repo: "other/repo" }),
    { task: "t", repo: "https://forge.example.com/owner/site.git", verification: { observeWindowMin: 30 } },
    { kind: "deployed", url: "https://p", image: "i", deployedAt: DEPLOYED_AT },
    "ship/run-1",
  );
  assert.equal(wrongRepo?.kind, "disabled");
  if (wrongRepo?.kind === "disabled") assert.match(wrongRepo.reason, /not on other\/repo/);

  const noPreview = await observeIfDeclared(ctx, observeConfig({ fetch: telemetryFetch({}) }), OBSERVE_INPUT, undefined, "ship/run-1");
  assert.equal(noPreview?.kind, "disabled");
  if (noPreview?.kind === "disabled") assert.match(noPreview.reason, /no preview was deployed/);
});

// --- the recorded rung list ---------------------------------------------------

test("recordLadder: one step, the rung list, absent when nothing was declared", async () => {
  const { ctx, steps } = fakeCtx();
  const rungs = await recordLadder(ctx, { ...BASE_INPUT, verification: { tests: "pnpm test" } }, {
    baseline: undefined,
    tests: { kind: "passed", command: "pnpm test", durationMs: 10 },
  });
  assert.equal(steps[0]?.name, "ladder");
  assert.deepEqual(
    (rungs ?? []).map((r) => `${r.name}:${r.status}`),
    ["baseline:skipped", "build:skipped", "tests:passed", "preview:skipped", "visual:skipped", "flow:skipped", "observe:skipped"],
  );
  assert.equal(await recordLadder(ctx, BASE_INPUT, {}), undefined);
  assert.equal(steps.length, 1);
});
