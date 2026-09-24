import type { RuntimeConfigStore } from "./runtime-config.js";

/**
 * The deployment's evidence ASKS, published to the shared store so an enqueue
 * from anywhere else inherits them (fresh-machine finding F9).
 *
 * `enqueueRun` materialises `tests` / `telemetry` / `preview` into the run
 * input from the ENQUEUEING process's environment — deliberately, because the
 * recorded input is what gates step presence and a worker must never decide
 * it at execution time. That is correct for the web process and the worker's
 * own intake sweep, which carry the deployment's env. It was silently wrong for
 * the CLI: `teploy secret set SHIP_TESTS=1 && teploy deploy` reaches the
 * containers only, so a `teploy-ship enqueue --store nucleus` from an
 * operator's shell recorded no ask, and the pull request arrived with no
 * Verification section and no error anywhere (run-b986b39b, 2026-09-23).
 *
 * The worker publishes the values it booted with; `enqueueRun` reads them as
 * the fallback beneath the enqueueing shell's own values. Precedence, per
 * name: an explicit option on the call > a non-empty value in the enqueueing
 * process's env (so `SHIP_TESTS=0 teploy-ship enqueue …` still opts out) > the
 * deployment's published value > unset. Still resolved AT ENQUEUE and copied
 * into the input, so nothing about replay changes.
 *
 * Only the three asks. Credentials never travel this way — the store is
 * reachable by anything on the deployment's network — and neither does
 * anything that is a worker capability rather than an ask (the worker decides
 * those itself when it executes).
 */
export const DEPLOYMENT_ASKS_KEY = "SHIP_DEPLOYMENT_ASKS";
export const DEPLOYMENT_ASK_NAMES = ["SHIP_TESTS", "SHIP_TELEMETRY", "SHIP_PREVIEW"] as const;
export type DeploymentAskName = (typeof DEPLOYMENT_ASK_NAMES)[number];
export type DeploymentAsks = Partial<Record<DeploymentAskName, string>>;

/** The asks set in an environment, empty values dropped. */
export function asksFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentAsks {
  const out: DeploymentAsks = {};
  for (const name of DEPLOYMENT_ASK_NAMES) {
    const value = (env[name] ?? "").trim();
    if (value !== "") out[name] = value;
  }
  return out;
}

/**
 * Publish this process's asks. Called by the worker at boot. An env with none
 * of them REMOVES the record, so unsetting SHIP_TESTS and redeploying stops the
 * inheritance instead of leaving a stale ask behind. With several workers the
 * last to boot wins — they share one teploy.yml, so they agree.
 */
export async function publishDeploymentAsks(
  config: Pick<RuntimeConfigStore, "set" | "remove">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentAsks> {
  const asks = asksFromEnv(env);
  if (Object.keys(asks).length === 0) await config.remove(DEPLOYMENT_ASKS_KEY);
  else await config.set(DEPLOYMENT_ASKS_KEY, JSON.stringify(asks), "worker");
  return asks;
}

/** The published asks. Never throws: an unreadable record is no record. */
export async function readDeploymentAsks(config: Pick<RuntimeConfigStore, "get"> | undefined): Promise<DeploymentAsks> {
  if (config === undefined) return {};
  try {
    const raw = await config.get(DEPLOYMENT_ASKS_KEY);
    if (raw === undefined) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: DeploymentAsks = {};
    for (const name of DEPLOYMENT_ASK_NAMES) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === "string" && value.trim() !== "") out[name] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The environment the asks resolve against: the published values, overlaid by
 * whatever the enqueueing process set itself. Returned env-shaped so the
 * existing flag readers take it unchanged.
 */
export function askEnv(published: DeploymentAsks, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...published, ...asksFromEnv(env) };
}

/**
 * The one line an enqueue prints about its test evidence (F9/F16). The run
 * input is fixed at enqueue, so this is the last moment the operator can learn
 * that the pull request will carry no suite result — and why.
 */
export function enqueueTestsLine(report: { tests: boolean; testCommand?: string; testCommandSource?: "project" | "detected" }): string {
  if (!report.tests) {
    return (
      "tests:  NOT asked — the pull request will carry no suite result. Nothing set SHIP_TESTS in this shell, and the " +
      "store holds no ask published by a worker. Pass --tests, or set a test command on the project."
    );
  }
  if (report.testCommand !== undefined) {
    return `tests:  will run \`${report.testCommand}\` (${report.testCommandSource === "project" ? "the project's command" : "detected from the repository"})`;
  }
  return "tests:  asked; no command resolved here — the worker detects one from its checkout, then falls back to SHIP_TEST_COMMAND";
}
