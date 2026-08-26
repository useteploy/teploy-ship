import type { Action } from "./actions.js";

export type ApprovalDecision = "auto" | "required";

/** Classifies an action into auto-run or approval-required. */
export type ApprovalPolicy = (action: Action) => ApprovalDecision | Promise<ApprovalDecision>;

// Commands that are destructive, exfiltrate, or reach the network — the
// things an operator most wants a chance to veto. Deliberately
// conservative: a sandbox already contains blast radius, so this gates
// the actions that matter even inside one (and matters a lot for the
// LocalExecutor / trusted-local path).
const DANGEROUS = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/, // rm -rf and friends
  /\brm\s+-[a-z]*f[a-z]*r?\b/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\b:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\b(curl|wget)\b/, // network fetch
  /\bgit\s+push\b/,
  /\bnpm\s+publish\b/,
  /\b(sudo|su)\b/,
  /\bchmod\s+-R\b/,
  /\/etc\/(passwd|shadow|sudoers)/,
  />\s*\/dev\/(sd|nvme|disk)/,
];

/** The built-in policy: flag destructive, network, or privilege actions. */
export function defaultApprovalPolicy(action: Action): ApprovalDecision {
  if (action.kind === "bash") {
    return DANGEROUS.some((pattern) => pattern.test(action.code)) ? "required" : "auto";
  }
  // Python that shells out or opens sockets is likewise gate-worthy.
  if (action.kind === "python") {
    if (/\b(subprocess|os\.system|os\.remove|shutil\.rmtree|socket\.|urllib|requests\.)/.test(action.code)) {
      return "required";
    }
  }
  return "auto";
}

/** Every action auto-runs — the trusted/default policy for an isolated sandbox. */
export const autoApprove: ApprovalPolicy = () => "auto";

// Actions that leave the sandbox behind them. A disposable container with an
// allowlisted egress already contains everything else — the workspace is
// snapshotted, the filesystem is thrown away, and the daemon, not the harness,
// decides which hosts are reachable. What a sandbox cannot take back is a
// change published to somewhere durable, so those are the only actions still
// worth a human's attention when one is running.
const ESCAPES_SANDBOX = [
  /\bgit\s+push\b/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\bpoetry\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgh\s+(release|pr)\s+create\b/,
  /\bdocker\s+push\b/,
  /\bgo\s+mod\s+edit\b.*\breplace\b.*\bhttp/,
];

/**
 * The policy for a run whose executor IS a disposable sandbox.
 *
 * `defaultApprovalPolicy` is deliberately conservative because it also guards
 * the LocalExecutor, where `rm -rf` and `curl` really do reach the operator's
 * machine. Applying that same list inside a sandbox measurably does not work:
 * over the L0 round-2 batch, twelve sandboxed runs parked thirty-two times and
 * every single park was approved, because every park was an ordinary
 * verification step — copy the tree to /tmp, run the suite, fetch a module
 * from an already-allowlisted proxy. A gate that is always answered the same
 * way is not a gate; it is a stall, and unattended it took the batch's
 * completion rate from 89% to 33%.
 *
 * So inside a sandbox the boundary does the containing and this policy gates
 * only what outlives the container.
 */
export function sandboxApprovalPolicy(action: Action): ApprovalDecision {
  if (action.kind === "bash" || action.kind === "python") {
    return ESCAPES_SANDBOX.some((pattern) => pattern.test(action.code)) ? "required" : "auto";
  }
  return "auto";
}

/**
 * Pick the policy for a run. `SHIP_SANDBOX_APPROVAL` overrides:
 *   boundary  (default when sandboxed) gate only what escapes the sandbox
 *   strict    the LocalExecutor list, even inside a sandbox
 *   auto      never gate — for a fully trusted, isolated batch
 * A run with no sandbox is always `strict`: there is no boundary to lean on.
 */
export function resolveApprovalPolicy(
  options: { sandboxed: boolean },
  env: NodeJS.ProcessEnv = process.env,
): ApprovalPolicy {
  const mode = (env.SHIP_SANDBOX_APPROVAL ?? "").trim().toLowerCase();
  if (mode === "strict") return defaultApprovalPolicy;
  if (mode === "auto") return autoApprove;
  if (mode === "boundary") return options.sandboxed ? sandboxApprovalPolicy : defaultApprovalPolicy;
  return options.sandboxed ? sandboxApprovalPolicy : defaultApprovalPolicy;
}
