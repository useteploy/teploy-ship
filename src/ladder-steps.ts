/**
 * The recorded rungs of the verification ladder (C4 / D3 / L4) that are not
 * already steps elsewhere: `build`, `preview-smoke`, `visual-diff`, `flow`,
 * `observe-window`, and the `ladder` step that turns every outcome into the
 * rung list the auto-merge gate and the webhook read.
 *
 * Every step here is gated on the recorded run INPUT (`input.verification`),
 * never on worker wiring, for the standing reason in durable.ts: step presence
 * must be a function of the log, or a replay on a differently-wired host
 * requests a step the log does not contain. A worker that cannot perform a
 * declared rung records it as `skipped` with the reason.
 *
 * Nothing here can fail the run. Every path returns an outcome.
 */
import { createHash } from "node:crypto";

import type { AgentExecutor } from "@neutron-build/agents";
import type { WorkflowContext } from "@neutron-build/workflow";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import type { DurableAgentConfig, DurableAgentInput } from "./durable.js";
import { destroyPreview, type PreviewOutcome } from "./deploy.js";
import { compareHealth, effectiveTelemetryTarget, readServiceHealth, telemetryAppliesTo, telemetryRegression } from "./observe.js";
import { runTests, testTargetFromInput, type TestOutcome } from "./tests.js";
import {
  ladderRungs,
  type FlowOutcome,
  type FlowShot,
  type LadderFacts,
  type ObserveOutcome,
  type Rung,
  type Screenshot,
  type SmokeOutcome,
  type VisualOutcome,
} from "./ladder.js";

/**
 * Where a step puts a picture so a person can open it — an attachment on the
 * pull request (git.ts uploadPrAsset). Optional everywhere: a run with no
 * pull request yet, or on a forge with no asset API, records the hashes and
 * says the picture was not attached. An upload that fails never fails the
 * rung; the evidence is the capture, the attachment is its delivery.
 */
export interface AssetSink {
  upload(name: string, bytes: Uint8Array): Promise<string>;
}

/** The most screenshots one step attaches; a flow that writes more keeps the first N by name. */
export const MAX_SHOTS = 8;
/** The largest PNG a step attaches. Forgejo's default per-file cap is far above this; the pull request is not. */
const MAX_SHOT_BYTES = 4 * 1024 * 1024;

async function attach(sink: AssetSink | undefined, name: string, bytes: Uint8Array): Promise<string | undefined> {
  if (sink === undefined || bytes.byteLength > MAX_SHOT_BYTES) return undefined;
  try {
    return await sink.upload(name, bytes);
  } catch {
    return undefined;
  }
}

/**
 * Pixel comparison of two PNGs (pixelmatch, threshold 0.1, anti-aliasing
 * ignored). Undefined when either does not decode or the sizes differ, in
 * which case the caller falls back to comparing bytes and says so.
 */
export function comparePngs(a: Uint8Array, b: Uint8Array): { differing: number; total: number } | undefined {
  let left: PNG;
  let right: PNG;
  try {
    left = PNG.sync.read(Buffer.from(a));
    right = PNG.sync.read(Buffer.from(b));
  } catch {
    return undefined;
  }
  if (left.width !== right.width || left.height !== right.height) return undefined;
  const differing = pixelmatch(left.data, right.data, undefined, left.width, left.height, { threshold: 0.1 });
  return { differing, total: left.width * left.height };
}

/** Worker-side hooks the ladder steps use; injectable so tests need no clock. */
export interface LadderHooks {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const defaultHooks: Required<LadderHooks> = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function tail(text: string, max = 1200): string {
  const t = text.trimEnd();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/** `build`: the project's build command, in the sandbox, before the suite. */
export async function buildIfDeclared(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  input: DurableAgentInput,
): Promise<TestOutcome | undefined> {
  const command = input.verification?.build;
  if (command === undefined) return undefined;
  return await ctx.step("build", async (): Promise<TestOutcome> => {
    const timeoutMs = input.testTimeoutMs;
    return await runTests(executor, { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  });
}

/**
 * `preview-smoke`: the project's smoke command against the deployed preview,
 * run in the SANDBOX with PREVIEW_URL set. The sandbox, not the worker host:
 * the command is operator text off an editable record, and the worker host
 * holds deploy credentials. A sandbox with no egress records the failure it
 * hits, which is the honest answer.
 */
export async function smokeIfDeclared(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
): Promise<SmokeOutcome | undefined> {
  const declared = input.verification?.preview;
  if (declared === undefined) return undefined;
  return await ctx.step("preview-smoke", async (): Promise<SmokeOutcome> => {
    if (preview?.kind !== "deployed") {
      return { kind: "skipped", reason: preview === undefined ? "no preview was deployed" : `no preview to smoke (${preview.kind}: ${preview.reason})` };
    }
    const started = Date.now();
    try {
      const result = await executor.exec(declared.smoke, {
        env: { PREVIEW_URL: preview.url },
        timeoutMs: input.testTimeoutMs ?? 300_000,
      });
      if (result.timedOut) return { kind: "errored", command: declared.smoke, reason: `timed out after ${Math.round((Date.now() - started) / 1000)}s` };
      if (result.exitCode === 0) return { kind: "passed", command: declared.smoke, durationMs: Date.now() - started };
      return { kind: "failed", command: declared.smoke, exitCode: result.exitCode, output: tail(`${result.stdout}${result.stderr}`) };
    } catch (error) {
      return { kind: "errored", command: declared.smoke, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * The URL of main for a preview URL. teploy provisions previews as
 * `preview-<branch>.<domain>` (teploy-cli README), so main is the host with
 * that first label removed. Null when the host does not have that shape.
 */
export function mainUrlOf(previewUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(previewUrl);
  } catch {
    return null;
  }
  const labels = url.hostname.split(".");
  if (labels.length < 3 || !labels[0]!.startsWith("preview-")) return null;
  return `${url.protocol}//${labels.slice(1).join(".")}/`;
}

const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

/**
 * `visual-diff`: screenshot the preview's root and main's root with whatever
 * headless browser the sandbox image carries. The image decides: no browser
 * means `skipped`, said so, and the rung holds a merge that needed it.
 *
 * THE LIMITS, STATED WHERE THEY ARE SPENT. One route (the root URL), one
 * viewport (1280x800), no scroll, no login, no wait for client-side rendering
 * beyond what the browser does before exit, and a PIXEL comparison that
 * ignores anti-aliasing (comparePngs) — a rendered timestamp or a carousel
 * frame still moves pixels, so `differs` is a question for the reader ("did
 * this trivial change have any right to move a pixel?"), never a verdict. A
 * change that alters the page is not a failure; two captured images IS the
 * rung passing, because the evidence exists and both are attached to the
 * pull request for a person to open.
 *
 * Screenshots are written INSIDE the workspace, relative: an executor confines
 * paths to its root, and /tmp is outside it on every executor that enforces
 * that (LocalExecutor refuses it outright). They are removed after reading —
 * they land in the repo tree, which the next `git add -A` would otherwise
 * sweep into a diff that has nothing to do with the change.
 */
export async function visualIfDeclared(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
  sink?: AssetSink,
): Promise<VisualOutcome | undefined> {
  if (input.verification?.visual !== true) return undefined;
  return await ctx.step("visual-diff", async (): Promise<VisualOutcome> => {
    if (preview?.kind !== "deployed") {
      return { kind: "skipped", reason: preview === undefined ? "no preview was deployed" : `no preview to screenshot (${preview.kind}: ${preview.reason})` };
    }
    const main = mainUrlOf(preview.url);
    if (main === null) return { kind: "skipped", reason: `could not derive main's URL from ${preview.url}` };
    try {
      const probe = await executor.exec(`for b in ${BROWSERS.join(" ")}; do if command -v "$b" >/dev/null 2>&1; then command -v "$b"; exit 0; fi; done; exit 3`, {
        timeoutMs: 30_000,
      });
      const browser = probe.stdout.trim();
      if (probe.exitCode !== 0 || browser === "") {
        return { kind: "skipped", reason: `the sandbox image has no headless browser (looked for ${BROWSERS.join(", ")})` };
      }
      const shot = async (url: string, file: string): Promise<{ png: Uint8Array; sha256: string } | string> => {
        const r = await executor.exec(
          `"${browser}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1280,800 --screenshot=${file} ${JSON.stringify(url)} >/dev/null 2>&1`,
          { timeoutMs: 120_000 },
        );
        if (r.exitCode !== 0) return `screenshot of ${url} failed (exit ${r.exitCode}): ${tail(r.stderr || r.stdout, 300)}`;
        let png: Uint8Array;
        try {
          png = await executor.getFile(file);
        } catch (error) {
          return `screenshot of ${url} was not readable: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (png.byteLength === 0) return `screenshot of ${url} is empty`;
        return { png, sha256: createHash("sha256").update(png).digest("hex") };
      };
      const p = await shot(preview.url, ".ship-visual-preview.png");
      if (typeof p === "string") return { kind: "failed", reason: p };
      const m = await shot(main, ".ship-visual-main.png");
      if (typeof m === "string") return { kind: "failed", reason: m };
      const pixels = comparePngs(p.png, m.png);
      const side = async (url: string, s: { png: Uint8Array; sha256: string }, name: string): Promise<Screenshot> => {
        const asset = await attach(sink, `ship-${ctx.runId}-visual-${name}.png`, s.png);
        return { url, sha256: s.sha256, bytes: s.png.byteLength, ...(asset !== undefined ? { asset } : {}) };
      };
      return {
        kind: "captured",
        preview: await side(preview.url, p, "preview"),
        main: await side(main, m, "main"),
        differs: pixels !== undefined ? pixels.differing > 0 : p.sha256 !== m.sha256,
        ...(pixels !== undefined ? { pixels } : {}),
      };
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await executor.exec("rm -f .ship-visual-preview.png .ship-visual-main.png", { timeoutMs: 15_000 }).catch(() => {});
    }
  });
}

/** The agent-written proof script and the directory its screenshots go to, both repo-relative. */
export const FLOW_SCRIPT = ".ship/flow.mjs";
export const FLOW_OUT = ".ship/flow-out";

/**
 * `flow`: the agent's own browser flow against the preview.
 *
 * The other rungs are the operator's: a build command, a suite, a smoke, a
 * root-page screenshot. This one is the AGENT's — it wrote `.ship/flow.mjs`
 * (prompt.ts tells it how) to drive the path its change touched and
 * screenshot the result. Ship runs it against the deployed preview with the
 * URL as argv[2] and an output directory as argv[3]; every PNG the script
 * writes is attached to the pull request; a non-zero exit fails the rung.
 * The script is in the tree, so a reviewer reads the claim beside the diff.
 *
 * Playwright is resolved through a symlink Ship makes under `.ship/` for the
 * duration of the step: an ESM import ignores NODE_PATH, and a global install
 * is otherwise invisible to a script inside the repo. The link and the output
 * directory are removed afterwards and excluded from git (git.ts) — the
 * script is the deliverable, its output is not.
 *
 * Gated on the preview declaration, not on the file: step presence must be a
 * function of the run input (durable.ts), and the file's presence is a fact
 * the step records.
 */
export async function flowIfPresent(
  ctx: WorkflowContext,
  executor: AgentExecutor,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
  sink?: AssetSink,
): Promise<FlowOutcome | undefined> {
  if (input.verification?.preview === undefined) return undefined;
  return await ctx.step("flow", async (): Promise<FlowOutcome> => {
    if (preview?.kind !== "deployed") {
      return { kind: "skipped", reason: preview === undefined ? "no preview was deployed" : `no preview to drive (${preview.kind}: ${preview.reason})` };
    }
    const probe = await executor.exec(
      `test -f ${FLOW_SCRIPT} || exit 3; command -v node >/dev/null 2>&1 || exit 4; pw="$(npm root -g 2>/dev/null)/playwright"; test -d "$pw" || exit 5; printf %s "$pw"`,
      { timeoutMs: 30_000 },
    );
    if (probe.exitCode === 3) return { kind: "skipped", reason: `no ${FLOW_SCRIPT} in the tree: the agent wrote no browser flow for this change` };
    if (probe.exitCode === 4) return { kind: "skipped", reason: "the sandbox image has no node to run the flow with" };
    if (probe.exitCode !== 0 || probe.stdout.trim() === "") return { kind: "skipped", reason: "the sandbox image has no playwright (npm root -g)/playwright" };
    const playwright = probe.stdout.trim();
    const started = Date.now();
    const shots: FlowShot[] = [];
    try {
      const r = await executor.exec(
        `rm -rf ${FLOW_OUT} && mkdir -p ${FLOW_OUT} .ship/node_modules && ln -sfn ${JSON.stringify(playwright)} .ship/node_modules/playwright && node ${FLOW_SCRIPT} "$PREVIEW_URL" ${FLOW_OUT}`,
        { env: { PREVIEW_URL: preview.url, FLOW_OUT }, timeoutMs: input.testTimeoutMs ?? 300_000 },
      );
      const durationMs = Date.now() - started;
      const listing = await executor.exec(`ls -1 ${FLOW_OUT}/*.png 2>/dev/null | sort`, { timeoutMs: 15_000 });
      const files = listing.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(0, MAX_SHOTS);
      for (const file of files) {
        let png: Uint8Array;
        try {
          png = await executor.getFile(file);
        } catch {
          continue;
        }
        if (png.byteLength === 0) continue;
        const name = file.slice(file.lastIndexOf("/") + 1);
        const asset = await attach(sink, `ship-${ctx.runId}-flow-${name}`, png);
        shots.push({ name, sha256: createHash("sha256").update(png).digest("hex"), bytes: png.byteLength, ...(asset !== undefined ? { asset } : {}) });
      }
      if (r.timedOut) return { kind: "errored", script: FLOW_SCRIPT, reason: `timed out after ${Math.round(durationMs / 1000)}s` };
      if (r.exitCode === 0) return { kind: "passed", script: FLOW_SCRIPT, durationMs, shots };
      return { kind: "failed", script: FLOW_SCRIPT, exitCode: r.exitCode, output: tail(`${r.stdout}${r.stderr}`), shots };
    } catch (error) {
      return { kind: "errored", script: FLOW_SCRIPT, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await executor.exec(`rm -rf ${FLOW_OUT} .ship/node_modules`, { timeoutMs: 15_000 }).catch(() => {});
    }
  });
}

/**
 * `observe-window`: the service's error rate for `observeWindowMin` minutes
 * after the preview deployed, against the same length of window before.
 *
 * WHICH SERVICE, HONESTLY. It is the telemetry target the worker already
 * holds, layered with the run's per-repo service (effectiveTelemetryTarget) —
 * the same read the `telemetry-check` leg does. teploy previews report under
 * the app's own service name when the env profile teploy injects carries the
 * Observe wiring, so the smoke's traffic lands in the window; when the app is
 * not wired to Observe, or the preview saw too little traffic to say
 * anything, the outcome is `insufficient`/`unavailable` and the rung is
 * skipped-with-reason — never a confident number off nine requests, which is
 * the house rule this file inherits from observe.ts.
 *
 * A rise past the regression thresholds (observe.ts) is `worse`, and the
 * preview is torn down on the spot — the rollback of a preview Ship itself
 * put up, with the measurement as evidence. Production is never touched here;
 * that is the `rollback` step's business and `autoDeploy`'s authority.
 *
 * The step WAITS for the window to elapse. That is the point of it: "no
 * error-rate change for N minutes" cannot be known sooner.
 */
export async function observeIfDeclared(
  ctx: WorkflowContext,
  config: DurableAgentConfig,
  input: DurableAgentInput,
  preview: PreviewOutcome | undefined,
  branch: string,
): Promise<ObserveOutcome | undefined> {
  const windowMin = input.verification?.observeWindowMin;
  if (windowMin === undefined || windowMin <= 0) return undefined;
  const hooks = { ...defaultHooks, ...config.ladder };
  const windowMs = windowMin * 60_000;
  return await ctx.step(
    "observe-window",
    async (): Promise<ObserveOutcome> => {
      if (preview?.kind !== "deployed") {
        return { kind: "disabled", reason: preview === undefined ? "no preview was deployed, so there is nothing to observe" : `no preview to observe (${preview.kind}: ${preview.reason})` };
      }
      const target = effectiveTelemetryTarget(config.telemetry, input);
      if (target === undefined) return { kind: "disabled", reason: "no telemetry target configured on this worker" };
      // The same guard telemetryIfAsked makes: reading a service this run's
      // repo is not built from would measure something the change cannot have
      // caused, which reads as a finding rather than as noise.
      if (!telemetryAppliesTo(target, input.repo)) {
        return { kind: "disabled", reason: `this run is not on ${target.repo}, which is the repo OBSERVE_SERVICE=${target.service} is built from` };
      }
      const deployedAt = preview.deployedAt !== undefined ? new Date(preview.deployedAt) : hooks.now();
      const until = deployedAt.getTime() + windowMs;
      const wait = until - hooks.now().getTime();
      if (wait > 0) await hooks.sleep(wait);
      try {
        const before = await readServiceHealth(target, new Date(deployedAt.getTime() - windowMs), deployedAt);
        const after = await readServiceHealth(target, deployedAt, new Date(until));
        const rejected = before.kind === "rejected" ? before : after.kind === "rejected" ? after : null;
        if (rejected !== null) return { kind: "unavailable", windowMin, reason: rejected.reason };
        const verdict = compareHealth(before.kind === "ok" ? before.health : null, after.kind === "ok" ? after.health : null, target.minRequests);
        if (verdict.kind !== "compared") return { kind: verdict.kind === "insufficient" ? "insufficient" : "unavailable", windowMin, reason: verdict.reason };
        const regression = telemetryRegression(verdict);
        if (!regression.worse) return { kind: "healthy", windowMin, reasons: regression.reasons };
        if (config.preview === undefined) {
          return { kind: "worse", windowMin, reasons: regression.reasons, rollback: { kind: "skipped", detail: "this worker has no preview target, so it could not tear the preview down" } };
        }
        // destroyPreview's vocabulary, mapped rather than renamed: `skipped`
        // is SUCCESS there ("preview for <branch> destroyed"), `failed` is a
        // destroy that errored.
        const torn = await destroyPreview(config.preview, branch);
        return {
          kind: "worse",
          windowMin,
          reasons: regression.reasons,
          rollback:
            torn.kind === "skipped"
              ? { kind: "rolled-back", detail: torn.reason }
              : { kind: "failed", detail: torn.kind === "failed" ? torn.reason : `unexpected destroy outcome: ${torn.kind}` },
        };
      } catch (error) {
        return { kind: "unavailable", windowMin, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    { timeout: windowMs + 10 * 60_000 },
  );
}

/**
 * `ladder`: the rung list, recorded. Pure over the outcomes the earlier steps
 * recorded, so it replays identically; recorded as its own step so the
 * webhook builder and the Projects page read ONE list rather than each
 * re-deriving it from six steps and disagreeing.
 */
export async function recordLadder(ctx: WorkflowContext, input: DurableAgentInput, facts: Omit<LadderFacts, "verification" | "testsDeclared">): Promise<Rung[] | undefined> {
  if (input.verification === undefined) return undefined;
  const verification = input.verification;
  return await ctx.step("ladder", () =>
    ladderRungs({
      verification,
      testsDeclared: testTargetFromInput(input) !== undefined || verification.tests !== undefined,
      ...facts,
    }),
  );
}
