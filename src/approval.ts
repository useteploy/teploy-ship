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
