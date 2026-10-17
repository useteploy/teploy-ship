import { hostname } from "node:os";

import { fileRuntime, nucleusRuntime, bootstrapAdmin, checkRecordDirsAtStartup } from "teploy-ship/runtime";
import type { ShipRuntime } from "teploy-ship/runtime";

/**
 * The web app's connection to durable runs. Configured by environment —
 * `teploy-ship web` sets these from flags/config before serving:
 *   SHIP_STORE      file | nucleus | postgres   (default file)
 *   NUCLEUS_URL     postgres://…                (required for nucleus|postgres)
 *   SHIP_WEB_TOKEN  bearer/login token          (required — no default)
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
  // A root-owned data volume must be visible in the web log, not discovered after the shadows sat empty (2026-10-16). Never throws.
  void checkRecordDirsAtStartup();
  const kind = process.env.SHIP_STORE ?? "file";
  if (kind === "file") return fileRuntime();
  if (kind !== "nucleus" && kind !== "postgres") throw new Error(`unknown SHIP_STORE: ${kind} (expected file, nucleus, or postgres)`);
  const url = process.env.NUCLEUS_URL;
  if (url === undefined || url === "") throw new Error(`SHIP_STORE=${kind} needs NUCLEUS_URL`);
  return nucleusRuntime(url, `web-${hostname()}-${process.pid}`, { dialect: kind === "postgres" ? "postgres" : "nucleus" });
}

// ── Initial admin bootstrap (web boot only) ────────────────────────────────
//
// The worker has no users and never runs this: provisioning the first local
// account is a web-process job, so the wiring lives with the web runtime.
// Fired here rather than inside create() so it runs at server start, not on
// the first request — and gated on the env so every existing import of this
// module (tests, dev) stays byte-for-byte inert until an operator actually
// sets the secrets. bootstrapAdmin never throws and never logs the password;
// the catch is a backstop so a broken bootstrap can never stop the dashboard
// from serving (SHIP_WEB_TOKEN remains the admin way in regardless).
if (process.env.SHIP_BOOTSTRAP_ADMIN_USER !== undefined || process.env.SHIP_BOOTSTRAP_ADMIN_PASSWORD !== undefined) {
  void shipRuntime()
    .then((rt) => bootstrapAdmin(rt, process.env, (l) => console.log(l)))
    .catch((error: unknown) => {
      console.error(`bootstrap admin: not applied — ${error instanceof Error ? error.message : String(error)}`);
    });
}

export function webToken(): string {
  const token = process.env.SHIP_WEB_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("SHIP_WEB_TOKEN is not set — refusing to serve unauthenticated");
  }
  return token;
}

export function defaultModel(): string {
  return process.env.SHIP_MODEL ?? "zai/glm-5.3";
}

/**
 * The ladder-capped authority of a project (C4). Re-exported HERE, server-side
 * only: a value import of the runtime package from a route module would drag
 * the worker's node-dependency graph into the client bundle, which is what
 * the .server convention exists to prevent. Routes compute it in their loader
 * and pass the string through as data.
 */
export { effectiveAuthority } from "teploy-ship/runtime";
