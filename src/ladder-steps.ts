/**
 * The recorded rungs of the verification ladder (C4 / D3 / L4) that are not
 * already steps elsewhere: `build`, `preview-smoke`, `visual-diff`,
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

import type { DurableAgentConfig, DurableAgentInput } from "./durable.js";
import { destroyPreview, type PreviewOutcome } from "./deploy.js";
import { compareHealth, effectiveTelemetryTarget, readServiceHealth, telemetryAppliesTo, telemetryRegression } from "./observe.js";
import { runTests, testTargetFromInput, type TestOutcome } from "./tests.js";
import { ladderRungs, type LadderFacts, type ObserveOutcome, type Rung, type SmokeOutcome, type VisualOutcome } from "./ladder.js";

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
 * beyond what the browser does before exit, and a BYTE comparison — two
 * screenshots of the same page can differ by an animation frame or a rendered
 * timestamp, so `differs` is a question for the reader ("did this trivial
 * change have any right to move a pixel?"), never a verdict. A change that
 * alters the page is not a failure; two captured images IS the rung passing,
 * because the evidence exists and a person can open both URLs.
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
      const shot = async (url: string, file: string): Promise<{ url: string; sha256: string; bytes: number } | string> => {
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
        return { url, sha256: createHash("sha256").update(png).digest("hex"), bytes: png.byteLength };
      };
      const p = await shot(preview.url, ".ship-visual-preview.png");
      if (typeof p === "string") return { kind: "failed", reason: p };
      const m = await shot(main, ".ship-visual-main.png");
      if (typeof m === "string") return { kind: "failed", reason: m };
      return { kind: "captured", preview: p, main: m, differs: p.sha256 !== m.sha256 };
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await executor.exec("rm -f .ship-visual-preview.png .ship-visual-main.png", { timeoutMs: 15_000 }).catch(() => {});
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
