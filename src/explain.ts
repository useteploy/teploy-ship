import type { WorkflowEvent } from "@neutron-build/workflow";

import { NETWORK_DOWNGRADE_NOTE, detectEgressRefusal, egressRefusalNote, networkForTrust, parseNetworkTier } from "./egress.js";
import type { EgressRefusal } from "./egress.js";

/**
 * Turn a run's event log into something a human can act on.
 *
 * A finished run explains itself: there is a pull request, and the diff is the
 * answer. A run that did NOT finish leaves a status and several hundred events,
 * and "max-steps" is not an explanation — it is a category. Most of what makes
 * software feel maintained rather than prototyped is what happens when things
 * go wrong, and until now that surface did not exist.
 *
 * Everything here is derived from the log alone. No network, no store, no
 * model call: an explanation you cannot produce offline is useless in exactly
 * the situation you need it.
 */
export interface RunExplanation {
  /** One line. What happened, in the operator's terms rather than the loop's. */
  headline: string;
  /** What the run was asked to do. */
  tried: string;
  /** Where it stopped, and — where the log knows — why. */
  stoppedAt: string;
  /** What a human should do next. Never "check the logs". */
  nextStep: string;
  /** Facts worth surfacing beside the prose: last error, PR, cost, turns. */
  evidence: string[];
  /** Did this run end in a state a human needs to do something about? */
  needsAttention: boolean;
}

interface Digest {
  task?: string;
  status?: string;
  summary?: string;
  pr?: string;
  turns: number;
  failedStep?: { name: string; error: string };
  waitingOn?: string;
  cancelled: boolean;
  failedOutright?: string;
  testOutcome?: string;
  /** The sandbox refused a host during this run — the FIRST one it refused. */
  blocked?: EgressRefusal;
  /** The run asked for the open network and was downgraded because its task came from outside. */
  networkDowngraded: boolean;
  /** How many events the log holds — "none at all" is its own explanation. */
  events: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function digest(events: WorkflowEvent[]): Digest {
  const d: Digest = { turns: 0, cancelled: false, networkDowngraded: false, events: events.length };
  for (const e of events) {
    const data = asRecord(e.data);
    switch (e.type) {
      case "run-started": {
        const input = asRecord(data?.input);
        if (typeof input?.task === "string") d.task = input.task;
        // Derived from the recorded input, not from a step: the downgrade is a
        // pure function of the declared tier and the task's provenance, both
        // of which are in the log (see sandboxOverridesOf). Nothing extra is
        // written to make this readable.
        const declared = parseNetworkTier(input?.sandboxNetwork);
        if (declared !== null && networkForTrust(declared ?? undefined, input?.trust as string | undefined).downgradedFrom !== undefined) {
          d.networkDowngraded = true;
        }
        break;
      }
      case "step-completed": {
        const name = e.name ?? "";
        // A blocked host is the most actionable thing a failed run can carry
        // and it is buried in a turn's raw stdout, which is exactly where
        // nobody looks. Hoisted to the explanation.
        if (d.blocked === undefined && /^turn-\d+-exec$/.test(name)) {
          const r = asRecord(data?.result);
          if (r !== undefined && r.exitCode !== 0) {
            d.blocked = detectEgressRefusal(`${String(r.stdout ?? "")}\n${String(r.stderr ?? "")}`) ?? undefined;
          }
        }
        // turn-N-exec is the marker of an executing turn; counting think steps
        // would double-count a turn that was nudged and re-thought.
        const m = /^turn-(\d+)-exec$/.exec(name);
        if (m !== null) d.turns = Math.max(d.turns, Number(m[1]) + 1);
        if (name === "tests") {
          const result = asRecord(data?.result);
          if (typeof result?.kind === "string") d.testOutcome = result.kind;
        }
        break;
      }
      case "step-failed": {
        const err = data?.error;
        d.failedStep = { name: e.name ?? "(unnamed step)", error: typeof err === "string" ? err : JSON.stringify(err ?? "") };
        break;
      }
      case "event-waiting":
        d.waitingOn = /-ask$/.test(e.name ?? "") ? `a question from the agent (${e.name})` : (e.name ?? "an approval");
        break;
      case "run-cancelled":
        d.cancelled = true;
        break;
      case "run-failed":
        d.failedOutright = typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "the run threw");
        break;
      case "run-completed": {
        const out = asRecord(data?.output);
        if (typeof out?.status === "string") d.status = out.status;
        if (typeof out?.summary === "string") d.summary = out.summary;
        if (typeof out?.pr === "string") d.pr = out.pr;
        if (typeof out?.turns === "number") d.turns = Math.max(d.turns, out.turns);
        break;
      }
      default:
        break;
    }
  }
  return d;
}

/** Why a git step failed, in operator terms. */
export interface GitDiagnosis {
  /** Which family: the remedies are different and so is who owns them. */
  kind: "egress" | "auth" | "not-found" | "network" | "unknown";
  /** One sentence naming the cause, quoting the line that proves it. */
  cause: string;
  /** What to do about it. */
  next: string;
}

const GIT_AUTH =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid (?:username or password|credentials)|access denied|the requested url returned error: 40[13]\b|\b40[13] (?:unauthorized|forbidden)\b/i;
const GIT_NOT_FOUND = /repository '[^']*' not found|repository not found|the requested url returned error: 404\b|does not appear to be a git repository/i;
const GIT_NETWORK =
  /could not resolve (?:host|proxy)|failed to connect to|connection (?:refused|timed out|reset)|operation timed out|network is unreachable|no route to host|timed out after \d+s|proxy connect aborted|recv failure|ssl_connect|gnutls_handshake/i;

/**
 * Read a git step's failure (fresh-machine F17).
 *
 * An egress denial and a dead token used to reach `explain` as the same bare
 * `git … (exit 128)`: the words were in the stream the error did not read
 * (git.ts now keeps them), and nothing here looked at them. The families below
 * have different owners — the project's egress allowlist, the forge token, the
 * repository URL, the host's firewall — so naming the family IS the next step.
 * Undefined for anything that is not a git step failure.
 */
export function diagnoseGitFailure(error: string): GitDiagnosis | undefined {
  if (!/git step failed \(exit/.test(error)) return undefined;
  // A run-failed error arrives JSON-encoded, its newlines escaped, so split on
  // both forms — quoting the whole blob would quote the command, not git.
  const lines = error.split(/\n|\\n/);
  const quote = (re: RegExp): string => {
    const line = lines.find((l) => re.test(l));
    return line !== undefined ? ` ("${brief(line.replace(/\\"/g, '"').replace(/["}]+$/, ""), 120)}")` : "";
  };
  const refusal = detectEgressRefusal(error);
  if (refusal !== null) {
    return { kind: "egress", cause: `The sandbox's egress allowlist refused ${refusal.host ?? "the forge"} during the clone.`, next: egressRefusalNote(refusal) };
  }
  if (GIT_AUTH.test(error)) {
    return {
      kind: "auth",
      cause: `The forge refused the worker's git credential${quote(GIT_AUTH)}.`,
      next:
        "Check the token on the EXECUTING worker (SHIP_GIT_TOKEN, or the matching SHIP_GIT_TOKENS entry): not expired or revoked, and scoped to read and push this repository. Set it with `teploy secret set` and redeploy, then re-enqueue.",
    };
  }
  if (GIT_NOT_FOUND.test(error)) {
    return {
      kind: "not-found",
      cause: `The forge answered that the repository does not exist${quote(GIT_NOT_FOUND)}.`,
      next:
        "Check the --repo URL. Forges also answer 404 when the token cannot SEE a private repository, so confirm the token's user has access to it.",
    };
  }
  if (GIT_NETWORK.test(error)) {
    return {
      kind: "network",
      cause: `The run's executor could not reach the forge${quote(GIT_NETWORK)}.`,
      next:
        "Test the forge from where the run executes, not from your shell. Inside a sandbox, git goes through the run's egress proxy on the sandbox bridge's gateway on a per-run port; a host firewall (teploy setup enables UFW) that drops traffic from the sandbox subnet makes every clone hang until this timeout — allow the subnet (docs/TROUBLESHOOTING.md, firewall). Otherwise check DNS and that the forge is up.",
    };
  }
  const said = lines.slice(1).join(" ").replace(/["}]+$/, "").trim();
  return {
    kind: "unknown",
    cause: said !== "" ? `git said: ${brief(said, 200)}` : "git exited non-zero and printed nothing.",
    next:
      "Re-run the same git command from the executing worker or sandbox to see it fail live. The usual causes, in order: the host is not on the egress allowlist, the git token, the repository URL.",
  };
}

/** Trim a task or error to something that fits on a line without lying. */
function brief(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Explain a run from its event log.
 *
 * Ordering matters: the checks run most-specific first, because a run can be
 * several things at once and only the innermost one is actionable. A run that
 * threw while parked on an approval is a crash, not a pending approval.
 */
export function explainRun(events: WorkflowEvent[]): RunExplanation {
  const d = digest(events);
  return withNetwork(d, explainDigest(d));
}

/**
 * The network overlay, applied to whatever the run's own ending was.
 *
 * Kept separate rather than folded into the ladder above because it is
 * orthogonal to it: a blocked host explains a max-steps run, a stuck run, a
 * failed step and a finished-but-empty run equally well, and it is the single
 * most actionable thing any of them can carry — an operator adds one entry to
 * one project record and the next run works. Written LAST so it leads the
 * "next step", because it is the step that is actually next.
 */
function withNetwork(d: Digest, e: RunExplanation): RunExplanation {
  if (d.blocked === undefined && !d.networkDowngraded) return e;
  const evidence = [...e.evidence];
  if (d.blocked !== undefined) evidence.push(`sandbox blocked ${d.blocked.host ?? "a host"}`);
  if (d.networkDowngraded) evidence.push("network downgraded to allowlist (external task)");
  const notes = [
    ...(d.blocked !== undefined ? [egressRefusalNote(d.blocked)] : []),
    ...(d.networkDowngraded ? [NETWORK_DOWNGRADE_NOTE] : []),
  ];
  return {
    ...e,
    ...(d.blocked !== undefined ? { headline: `Blocked by the sandbox's egress allowlist. ${e.headline}` } : {}),
    nextStep: [...notes, e.nextStep].join(" "),
    evidence,
    needsAttention: e.needsAttention || d.blocked !== undefined,
  };
}

function explainDigest(d: Digest): RunExplanation {
  const tried = d.task !== undefined ? brief(d.task) : "(the log records no task)";
  const evidence: string[] = [];
  if (d.turns > 0) evidence.push(`${d.turns} turn${d.turns === 1 ? "" : "s"}`);
  if (d.pr !== undefined) evidence.push(`pull request: ${d.pr}`);
  if (d.testOutcome !== undefined) evidence.push(`tests: ${d.testOutcome}`);

  // 1. It never started.
  if (d.events === 0) {
    return {
      headline: "This run has no events at all.",
      tried,
      stoppedAt: "Nothing was ever recorded against it.",
      nextStep:
        "The run id exists but its log is empty, which means enqueue wrote nothing or the store is pointed somewhere else. Check that the worker and whoever enqueued it share one store (NUCLEUS_URL).",
      evidence,
      needsAttention: true,
    };
  }

  // 2a. A git step could not stand the repository up (F17). Before the
  // generic "fault in Ship" branch: the run threw, but the fault is the
  // network, the token or the URL, and each has its own owner.
  const gitFailure = diagnoseGitFailure(d.failedOutright ?? d.failedStep?.error ?? "");
  if (gitFailure !== undefined && d.status === undefined) {
    return {
      headline: "Could not check out the repository.",
      tried,
      stoppedAt: gitFailure.cause,
      nextStep: gitFailure.next,
      evidence: [...evidence, `git: ${gitFailure.kind}`],
      needsAttention: true,
    };
  }

  // 2b. The worker could not write its own state directory — the no-sandbox
  // path's workspaces live there. Found by the 2026-09-24 fresh-machine rerun:
  // teploy bind-mounts the `ship-data` volume from a host directory it creates
  // root-owned, the image runs as uid 1000, and every run died at `sandbox`
  // with EACCES under a headline that blamed Ship.
  const stateFault = d.failedOutright ?? d.failedStep?.error ?? "";
  if (d.status === undefined && /EACCES[^\n]*'\/data\b/.test(stateFault)) {
    return {
      headline: "The worker cannot write its state directory (/data).",
      tried,
      stoppedAt: `The workspace could not be created: ${brief(stateFault)}`,
      nextStep:
        "The image runs as uid 1000, and teploy creates the `ship-data` volume's host directory owned by root. On the server: " +
        "`chown 1000:1000 /deployments/ship/volumes/ship-data` (install.sh does this for you), then enqueue the task again.",
      evidence,
      needsAttention: true,
    };
  }

  // 2. It threw. This is the one case where the loop itself is the problem.
  if (d.failedOutright !== undefined) {
    const nondeterminism = /nondeterminism/i.test(d.failedOutright);
    return {
      headline: nondeterminism
        ? "This run can no longer be replayed."
        : "The run stopped with an error rather than a result.",
      tried,
      stoppedAt: `The workflow threw: ${brief(d.failedOutright)}`,
      nextStep: nondeterminism
        ? "Its recorded steps no longer match what the current code would do — almost always because Ship was upgraded while this run was in flight. It cannot be resumed. Cancel it and enqueue the task again. docs/UPGRADING.md §3 explains how to avoid this next time."
        : "This is a fault in Ship or its store, not in the agent's work. The error above is the whole of what the log knows; resuming will re-run from the last completed step.",
      evidence,
      needsAttention: true,
    };
  }

  // 3. A step failed but the run continued or stopped around it.
  if (d.failedStep !== undefined && d.status === undefined) {
    return {
      headline: `The run stopped at the "${d.failedStep.name}" step.`,
      tried,
      stoppedAt: `${d.failedStep.name} failed: ${brief(d.failedStep.error)}`,
      nextStep:
        "The step is recorded as failed, so a resume restarts from it rather than from the beginning. Fix whatever it depends on — credentials, network, or the store — then resume the run.",
      evidence,
      needsAttention: true,
    };
  }

  // 4. Parked, waiting for a person.
  if (d.waitingOn !== undefined && d.status === undefined && !d.cancelled) {
    return {
      headline: "The run is waiting for you.",
      tried,
      stoppedAt: `It parked at "${d.waitingOn}" and is holding its workspace.`,
      nextStep:
        "Approve or deny it. Nothing is burning while it waits — the workspace is snapshotted — but it will not progress on its own.",
      evidence,
      needsAttention: true,
    };
  }

  if (d.cancelled) {
    return {
      headline: "Cancelled.",
      tried,
      stoppedAt: "A person stopped this run; it settled at its next step.",
      nextStep: "Nothing to do. Work completed before the cancellation is still in the log and any pull request it opened still stands.",
      evidence,
      needsAttention: false,
    };
  }

  // 5. It reached a terminal status.
  switch (d.status) {
    case "finished":
      return {
        headline: d.pr !== undefined ? "Finished, and opened a pull request." : "Finished, but published nothing.",
        tried,
        stoppedAt: d.summary !== undefined ? brief(d.summary) : "The agent declared itself done.",
        nextStep:
          d.pr !== undefined
            ? "Review the pull request. If it carries a Verification section, the tests line was produced by Ship after the agent stopped — not by the agent's own account of its work."
            : "The agent finished without a diff to push, so there is nothing to review. That usually means the task was already satisfied, or was understood as a question rather than a change.",
        evidence,
        needsAttention: d.pr === undefined,
      };

    case "max-steps":
      return {
        headline: "Ran out of turns before it finished.",
        tried,
        stoppedAt: `It reached the ${d.turns}-turn ceiling while still working.`,
        nextStep:
          d.pr !== undefined
            ? "A draft pull request was opened anyway, because real fixes die in runs that never got to say 'finish'. Read the diff: partial work is common here, and so is complete work that simply never got to declare itself done."
            : "No diff had been produced by the ceiling, so nothing was published. Raise SHIP_MAX_STEPS for this kind of task, or split it — a task that needs more exploration than turns is usually two tasks.",
        evidence,
        needsAttention: true,
      };

    case "stuck":
      return {
        headline: "Stopped making progress and gave up.",
        tried,
        stoppedAt: "Stuck detection fired: commands kept running but the workspace stopped changing.",
        nextStep:
          "Read the last few turns — this is nearly always a missing dependency, a wrong path, or a test the agent cannot run. It is rarely the model failing to understand the task.",
        evidence,
        needsAttention: true,
      };

    case "settled":
      return {
        headline: "Stopped deliberately.",
        tried,
        stoppedAt: brief(d.summary ?? "It had already made a change and further commands stopped altering the tree."),
        nextStep:
          "This is a clean stop, not a failure: the run judged itself done verifying rather than building. Treat any pull request it opened as complete work.",
        evidence,
        needsAttention: false,
      };

    case "error":
      return {
        headline: "The harness failed.",
        tried,
        stoppedAt: brief(d.summary ?? "The external harness ended with an error."),
        nextStep:
          "Read the harness-preflight and harness-run steps: a binary missing from the sandbox image, a credential that was not forwarded, or a vendor-side error. Any diff it left was published as a draft.",
        evidence,
        needsAttention: true,
      };

    case "budget-exhausted":
      return {
        headline: "Hit the spend cap.",
        tried,
        stoppedAt: "The run stopped because its source's daily budget was exhausted, not because the work was done.",
        nextStep:
          "Raise the budget for this source in Settings, or wait for the daily window to roll over, then enqueue the task again. The cap is per source and per day.",
        evidence,
        needsAttention: true,
      };

    case "plan-rejected":
      return {
        headline: "You rejected its plan.",
        tried,
        stoppedAt: "The run stopped before touching the workspace.",
        nextStep: "Nothing ran, so there is nothing to clean up. Re-enqueue with a sharper task if the plan was wrong about what you wanted.",
        evidence,
        needsAttention: false,
      };

    default:
      break;
  }

  // 6. Still going.
  return {
    headline: "Still running.",
    tried,
    stoppedAt: d.turns > 0 ? `Currently on turn ${d.turns}.` : "It has started but not yet completed a turn.",
    nextStep: "Nothing to do yet. A run with no worker touching it will look like this too — check that a worker is alive if the turn count is not moving.",
    evidence,
    needsAttention: false,
  };
}

/** How recent a worker heartbeat must be to count as alive. Workers beat every few seconds. */
export const WORKER_ALIVE_MS = 2 * 60_000;

/**
 * The fleet overlay for a run that has not ended (fresh-machine F15).
 *
 * The log alone cannot tell "a worker is on it" from "no worker is alive",
 * and the second is common on a fresh install: a worker that fails a boot
 * check (the classic is `a sandbox URL is set but no token`) exits, docker
 * restarts it, it exits again — and every run sits queued while `explain`
 * said "Still running". The heartbeat registry (fleet.ts) answers the
 * question, so the CLI passes it in. Terminal runs and runs parked on a
 * person are returned untouched: neither needs a worker right now.
 */
export function withWorkers(
  e: RunExplanation,
  events: WorkflowEvent[],
  workers: ReadonlyArray<{ lastSeen: string }>,
  now: number = Date.now(),
): RunExplanation {
  const ended = events.some((ev) => ev.type === "run-completed" || ev.type === "run-failed" || ev.type === "run-cancelled");
  if (ended || events.length === 0) return e;
  const d = digest(events);
  if (d.waitingOn !== undefined) return e;
  const alive = workers.some((w) => {
    const seen = Date.parse(w.lastSeen);
    return Number.isFinite(seen) && now - seen < WORKER_ALIVE_MS;
  });
  const claimed = events.some((ev) => ev.type !== "run-started");
  if (alive) {
    return claimed
      ? e
      : { ...e, headline: "Queued — waiting for a worker to claim it.", stoppedAt: "No step has run yet; a live worker claims it on its next tick." };
  }
  const newest = workers.map((w) => Date.parse(w.lastSeen)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const lastSeen =
    newest === undefined ? "No worker has ever checked in to this store." : `The last worker heartbeat was ${Math.round((now - newest) / 60_000)} min ago.`;
  return {
    ...e,
    headline: claimed ? "Stalled — no worker is alive to continue it." : "Queued, but no worker is alive to run it.",
    stoppedAt: `${lastSeen} ${claimed ? "The run resumes from its last completed step when one returns." : "Nothing has claimed this run."}`,
    nextStep:
      "Check the worker container: `docker ps -a` showing it `Restarting` means it exits at boot, and `docker logs ship-worker-<sha>` names why. " +
      "On a fresh install that is usually `a sandbox URL is set but no token` (SHIP_SANDBOX_URL without SHIP_SANDBOX_TOKEN — set the token, or drop the URL to run without a sandbox) " +
      "or `tick failed (store unreachable?)` (NUCLEUS_URL). If the worker is up, it is pointed at a different store than the one you enqueued into.",
    needsAttention: true,
  };
}

/** Render an explanation as plain text, for the CLI. */
export function formatExplanation(e: RunExplanation): string {
  const lines = [e.headline, "", `Asked to:   ${e.tried}`, `Stopped at: ${e.stoppedAt}`, `Next:       ${e.nextStep}`];
  if (e.evidence.length > 0) lines.push("", e.evidence.join("  ·  "));
  return lines.join("\n");
}
