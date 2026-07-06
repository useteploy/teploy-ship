import { hostname } from "node:os";

import { fileRuntime, nucleusRuntime } from "teploy-ship/runtime";
import type { ShipRuntime } from "teploy-ship/runtime";

/**
 * The web app's connection to durable runs. Configured by environment —
 * `teploy-ship web` sets these from flags/config before serving:
 *   SHIP_STORE      file | nucleus            (default file)
 *   NUCLEUS_URL     postgres://…              (required for nucleus)
 *   SHIP_WEB_TOKEN  bearer/login token        (required — no default)
 *
 * One runtime per server process; loaders share it. The web surface only
 * ever reads state, enqueues runs, and delivers decisions — it never
 * executes the agent in-process (that is the worker's job).
 */
let runtime: Promise<ShipRuntime> | null = null;

export function shipRuntime(): Promise<ShipRuntime> {
  runtime ??= create();
  return runtime;
}

async function create(): Promise<ShipRuntime> {
  const kind = process.env.SHIP_STORE ?? "file";
  if (kind === "file") return fileRuntime();
  if (kind !== "nucleus") throw new Error(`unknown SHIP_STORE: ${kind} (expected file or nucleus)`);
  const url = process.env.NUCLEUS_URL;
  if (url === undefined || url === "") throw new Error("SHIP_STORE=nucleus needs NUCLEUS_URL");
  return nucleusRuntime(url, `web-${hostname()}-${process.pid}`);
}

export function webToken(): string {
  const token = process.env.SHIP_WEB_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("SHIP_WEB_TOKEN is not set — refusing to serve unauthenticated");
  }
  return token;
}

export function defaultModel(): string {
  return process.env.SHIP_MODEL ?? "anthropic/claude-sonnet-5";
}
