import { createHash, randomUUID } from "node:crypto";

import { generateText } from "@neutron-build/ai";
import type { Message, ModelAdapter, Usage } from "@neutron-build/ai";
import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { Action } from "./actions.js";
import { FINISH_NUDGE_CLEAN_TREE, FINISH_NUDGE_FAILED, FINISH_NUDGE_NO_EVIDENCE, FINISH_NUDGE_NO_WORK, FINISH_NUDGE_VERIFY, describeAction, parseAction } from "./actions.js";
import type { ApprovalPolicy } from "./approval.js";
import { formatSearchHits } from "./code-index.js";
import type { CodeSearchHit } from "./code-index.js";
import { criticFeedback, isApproved, reviewWork } from "./critic.js";
import { workingDiff } from "./git.js";
import { ensureKernel, installKernel, runCell, stopKernel } from "./kernel.js";
import { condenseIfNeeded, defaultCondenseConfig } from "./memory.js";
import type { CondenseConfig } from "./memory.js";
import { formatObservation, systemPrompt } from "./prompt.js";
import { scrub } from "./redact.js";
import { RecoveryTracker, defaultRecoveryConfig } from "./recovery.js";
import type { RecoveryConfig } from "./recovery.js";

export interface AgentStep {
  index: number;
  /** The model's full response (reasoning + the action block). */
  thought: string;
  action: Action;
  /** Execution result, absent for finish/none. */
  result?: ExecResult;
  observation?: string;
}

export interface AgentEvent {
  type: "thought" | "action" | "observation" | "finish" | "error";
  step: number;
  text: string;
}

/**
 * Semantic code retrieval for the live loop: a query in, ranked chunks out.
 *
 * A bare function rather than the `CodeSearch` interface (code-index.ts) on
 * purpose. `CodeSearch` is repo-scoped — every call takes a repo key, and it
 * also carries `refresh`, which needs an executor and a clone. The live loop
 * has no repo concept and nothing to refresh, so it should not learn one: the
 * caller closes over the repo key (and the result limit) and hands the loop the
 * one capability it actually uses. durable.ts keeps the full interface, because
 * it is the thing that clones and indexes.
 */
export type AgentCodeSearch = (query: string) => Promise<CodeSearchHit[]>;

export interface RunAgentOptions {
  model: ModelAdapter;
  executor: AgentExecutor;
  task: string;
  /** Absolute workdir shown to the agent (default /work — the sandbox convention). */
  workdir?: string;
  /** Continue a prior conversation (e.g. a previous run's result.messages); task becomes the next user turn. */
  priorMessages?: Message[];
  /** Max action turns before giving up (default 20). */
  maxSteps?: number;
  /** Per-action wall-clock cap, ms (default 120000). */
  actionTimeoutMs?: number;
  /** Cap on an observation fed back to the model, chars (default 8000). */
  maxObservationChars?: number;
  /** Classifies each executable action; "required" actions must be approved. */
  approveAction?: ApprovalPolicy;
  /** Resolver for approval-required actions in the live loop (true = run). */
  onApprovalRequest?: (action: Action) => boolean | Promise<boolean>;
  /** Loop/failure recovery tuning; false disables stuck detection. */
  recovery?: RecoveryConfig | false;
  /** Context condensation tuning; false disables it. */
  condense?: CondenseConfig | false;
  /** Persistent python kernel (variables survive between actions); false = per-file execution. */
  kernel?: boolean;
  /**
   * Namespaces this session's kernel cells and scratch files. Defaults to a
   * random id; set it only to make a test deterministic. Reusing one across
   * two sessions in the same workspace reintroduces the collision it exists
   * to prevent.
   */
  sessionId?: string;
  /**
   * Verified-finish guard (default on): the FIRST finish of a run is held
   * once — with zero successful executions the agent is told to do the
   * work; otherwise it is told to prove each deliverable with a real
   * command before finishing again. A second finish is always honored
   * (never an infinite refusal loop), and a finish on the final step is
   * honored immediately (a nudge there could only burn the run).
   */
  requireVerifiedFinish?: boolean;
  /**
   * Independent critic pass (default off): once a finish survives the
   * verify nudge above, an independent reviewer (Team/TeamPolicy over a
   * single critic member — see critic.ts) checks the working-tree diff
   * against the task and either approves or sends the run back once with
   * concrete feedback. Bounded to a single critic-triggered retry per run
   * — this never loops. Needs a git working tree; a non-repo run or an
   * empty diff skips the pass and finishes as today.
   */
  critic?: boolean;
  /**
   * Deliberate termination (default off): when the working tree already holds
   * a change and successful commands stop changing it, the agent is verifying
   * rather than building — so offer it a finish instead of only telling it to
   * build, and end that run as `settled` rather than as an error.
   *
   * Measured motivation: on the 2026-08-16 SWE-bench sweep 15/50 runs ended in
   * the spinning abort, at steps 28-38 of 40, and 13 of them were holding a
   * non-empty patch at the time.
   *
   * READ THIS BEFORE INTERPRETING A SWEEP. The population this touches is
   * WIDER than those 15 aborts, and the nudge is the entire measurable effect:
   *
   * - The nudge fires at the FIRST spinning rut over any dirty tree. On the
   *   2026-08-16 data that reaches the 23 runs that finished deliberately
   *   (median 28 steps, 20/23 resolved) and the 12 cap-outs as well as the 15
   *   aborts. It can therefore talk a run that would have finished correctly
   *   into stopping sooner — the score can move DOWN, not only up.
   * - The relabel and the summary preservation contribute exactly nothing to a
   *   benchmark: the stop fires at the same step the abort would have, and the
   *   harness reads the patch from the tree after the run regardless of status.
   *
   * So a sweep with this on measures one thing only: whether offering a
   * settled agent a finish produces better patches than letting it spin. Do
   * not read a delta as being about the aborts.
   *
   * Bounded: at most one extra nudge per run, and the stop fires at the exact
   * step the abort would have. It builds on stuck detection, so
   * `recovery: false` disables this too.
   */
  finishWhenSettled?: boolean;
  /**
   * Semantic code retrieval (default absent). When supplied, the system prompt
   * advertises the ```search action and each search turn feeds the ranked hits
   * back as an observation.
   *
   * When ABSENT the run is byte-identical to one without this option: the
   * prompt does not mention search (prompt.ts only emits the block on
   * `search === true`), and a ```search the model invents anyway falls through
   * to the same refusal as before. That is deliberate — it is what keeps a
   * sweep with the index off comparable to the 35/50 baseline that predates
   * this option.
   *
   * A search is retrieval, not work: it does not count as a successful action,
   * does not clear the verified-finish evidence gate, and is not fed to the
   * recovery tracker. See the handler in the loop for why each of those
   * matters.
   */
  codeSearch?: AgentCodeSearch;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
}

export interface AgentResult {
  /**
   * `settled` = stopped deliberately by the settle path (finishWhenSettled),
   * with work in the tree. It is NOT `finished`: the agent never said so.
   */
  status: "finished" | "max-steps" | "aborted" | "error" | "settled";
  /** The finish summary, or the reason the run ended. */
  summary: string;
  steps: AgentStep[];
  /** Full conversation, for inspection or a follow-up turn. */
  messages: Message[];
  /** Total model usage across every call in the run (cache fields included). */
  usage: Usage;
}

/**
 * The CodeAct loop: assemble the conversation, ask the model for one
 * action, execute it in the sandbox, feed the observation back, repeat
 * until the agent finishes or the step budget runs out. This is the
 * agent "brain" — thin on purpose in M1 (the AI SDK owns model calls,
 * the executor owns compute); recovery/eval tuning is a later milestone.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const workdir = options.workdir ?? "/work";
  // Cell ids must be unique across SESSIONS, not just within one. They used to
  // be s0, s1, … restarting at zero for every runAgent call, so a caller
  // reusing an executor/workspace for a follow-up session wrote a new cell-s0
  // whose done-s0 marker already existed: the kernel skipped it and the caller
  // read the FIRST session's output back as the result of the second.
  const session = options.sessionId ?? randomUUID().slice(0, 8);
  const maxSteps = options.maxSteps ?? 20;
  const maxObs = options.maxObservationChars ?? 8000;
  const emit = options.onEvent ?? (() => {});

  // A continued conversation gets THIS session's system prompt, not whatever
  // the caller happened to bring. priorMessages used to be used verbatim, so a
  // follow-up could run with no system message at all, or with a stale one
  // naming a different workdir and a weaker completion/security policy — and
  // this is an exported API, so that was not just an internal assumption.
  // `search` is the seam: the loop can handle a ```search action and the parser
  // has always produced one, but a model that is never TOLD the action exists
  // will never emit it — a capability wired at both ends and connected at
  // neither. Passing `false` is identical to passing nothing (prompt.ts tests
  // `=== true`), so an option-less run's prompt is unchanged.
  const system: Message = {
    role: "system",
    content: systemPrompt({ workdir, task: options.task, search: options.codeSearch !== undefined }),
  };
  let messages: Message[] =
    options.priorMessages !== undefined && options.priorMessages.length > 0
      ? [system, ...options.priorMessages.filter((m) => m.role !== "system"), { role: "user", content: options.task }]
      : [system, { role: "user", content: "Begin. Work step by step and verify before finishing." }];
  const steps: AgentStep[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const addTo = (u: Usage): void => {
    const cacheRead = (usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    const cacheWrite = (usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    usage = {
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      totalTokens: usage.totalTokens + u.totalTokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
  };

  const recovery =
    options.recovery === false
      ? null
      : new RecoveryTracker({
          ...(options.recovery ?? defaultRecoveryConfig),
          // Layered on top of whatever recovery config the caller supplied, so
          // the option works with a custom tracker config as well as the default.
          ...(options.finishWhenSettled === true ? { settle: true } : {}),
        });
  const condense = options.condense === false ? null : (options.condense ?? defaultCondenseConfig);
  const summarize = async (transcript: string): Promise<string> => {
    const generated = await generateText({
      model: options.model,
      system: "Summarize this agent transcript into a compact progress recap: what was attempted, what worked, what failed, current state, and what remains. Be specific about file names and results.",
      prompt: transcript,
      maxOutputTokens: 800,
    });
    addTo(generated.usage);
    return generated.text;
  };

  let kernelUsed = false;
  let anySuccessfulAction = false;
  let finishNudged = false;
  /** Bounded holds for a finish over an unchanged tree. See FINISH_NUDGE_CLEAN_TREE. */
  let cleanTreeNudges = 0;
  let evidenceNudged = false;
  /** Executions (successful or not) since the verify nudge was issued. */
  let execsSinceNudge = 0;
  let failNudges = 0;
  let lastExecFailed = false;
  let criticDone = false;
  /**
   * The most recent finish the gate HELD. A run that ends any other way still
   * has the agent's own account of the work; ending on a harness sentence when
   * one of these exists throws it away.
   */
  let lastHeldFinish: string | undefined;
  try {
  for (let index = 0; index < maxSteps; index++) {
    if (options.abortSignal?.aborted) {
      return { status: "aborted", summary: "Run aborted.", steps, messages, usage };
    }

    // Keep the conversation inside the model's window before each call.
    if (condense !== null) {
      try {
        messages = await condenseIfNeeded(messages, summarize, condense);
      } catch (error) {
        emit({ type: "error", step: index, text: `condense failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    let thought: string;
    try {
      const generateOptions: Parameters<typeof generateText>[0] = { model: options.model, messages };
      if (options.abortSignal !== undefined) generateOptions.abortSignal = options.abortSignal;
      const generated = await generateText(generateOptions);
      addTo(generated.usage);
      thought = generated.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Model call failed: ${message}`, steps, messages, usage };
    }

    // A rare empty model response would serialize to an empty text content
    // block, which Anthropic rejects on the NEXT call ("text content blocks
    // must be non-empty") — killing the whole run. Keep the stored turn
    // non-empty; parseAction on the empty thought yields a "none" action, so
    // the loop nudges for a real action below.
    messages.push({ role: "assistant", content: thought.trim() === "" ? "(no response)" : thought });
    const action = parseAction(thought);
    emit({ type: "thought", step: index, text: thought });
    emit({ type: "action", step: index, text: describeAction(action) });

    if (action.kind === "finish") {
      // Two holds, both bounded: the first finish gets one verify/do-work
      // nudge; any finish whose most recent execution FAILED gets a
      // fix-it nudge (at most twice) — an agent that just watched its
      // tests fail does not get to walk away. Cap + final-step passthrough
      // guarantee termination.
      if (options.requireVerifiedFinish !== false && index + 1 < maxSteps) {
        let nudge: string | null = null;
        if (!finishNudged) {
          finishNudged = true;
          execsSinceNudge = 0;
          nudge = anySuccessfulAction ? FINISH_NUDGE_VERIFY : FINISH_NUDGE_NO_WORK;
        } else if (lastExecFailed && failNudges < 2) {
          failNudges += 1;
          nudge = FINISH_NUDGE_FAILED;
        } else if (!evidenceNudged && execsSinceNudge === 0) {
          // Asked to prove the work and came back having run NOTHING. This is
          // the hallucinated-verification finish the gate exists to catch; the
          // old gate accepted it because it only ever held the first finish.
          evidenceNudged = true;
          nudge = FINISH_NUDGE_NO_EVIDENCE;
        } else if (options.critic === true && !criticDone) {
          criticDone = true;
          // The critic is a safety net over a run that already succeeded, so
          // an infrastructure failure here (executor torn down, model call
          // rejected) must not take the run down with it: skip the review and
          // let the finish stand. Note this fails open only on a broken
          // review — an actual verdict that is not an approval still blocks.
          try {
            const diff = await workingDiff(options.executor);
            if (diff.trim() !== "") {
              const review = await reviewWork(options.model, { task: options.task, summary: action.message, diff });
              addTo(review.usage);
              if (!isApproved(review.text)) {
                nudge = criticFeedback(review.text);
              }
            }
          } catch (err) {
            emit({ type: "observation", step: index, text: `critic skipped: ${String(err)}` });
          }
        }
        // Last resort before honouring a finish: is the tree actually changed?
        // Every branch above asks about COMMANDS, which an agent satisfies with
        // read-only ones while writing nothing. Bounded at two holds, and only
        // where a fingerprint exists (a git repo), so a task whose deliverable
        // is not a diff is unaffected.
        if (nudge === null && cleanTreeNudges < 2) {
          const fp = await workspaceFingerprint(options.executor);
          if (fp !== undefined && !fp.dirty) {
            cleanTreeNudges += 1;
            nudge = FINISH_NUDGE_CLEAN_TREE;
          }
        }
        if (nudge !== null) {
          // Only the benign "prove it" hold leaves the agent's claim usable as
          // the run's official account. Every other hold is a REJECTION —
          // FINISH_NUDGE_NO_WORK (nothing done), FINISH_NUDGE_FAILED (its last
          // command failed), FINISH_NUDGE_NO_EVIDENCE (claimed verification it
          // never ran), or a critic disapproval — and adopting the claim there
          // would launder a judgement the run explicitly refused into
          // `result.summary`, which becomes the git commit message
          // (cli.ts:517), the PR body (cli.ts:545) and the repo memory note.
          // Clearing rather than leaving the previous value matters: an
          // earlier VERIFY claim must not survive a later rejection.
          lastHeldFinish = nudge === FINISH_NUDGE_VERIFY ? action.message : undefined;
          messages.push({ role: "user", content: nudge });
          steps.push({ index, thought, action });
          emit({ type: "observation", step: index, text: nudge });
          continue;
        }
      }
      steps.push({ index, thought, action });
      emit({ type: "finish", step: index, text: action.message });
      return { status: "finished", summary: action.message, steps, messages, usage };
    }

    if (action.kind === "search" && options.codeSearch !== undefined) {
      // Retrieval, not execution. Three things this deliberately does NOT do,
      // each of which would be a quiet regression:
      //
      // - It does not set `anySuccessfulAction` or bump `execsSinceNudge`.
      //   FINISH_NUDGE_NO_EVIDENCE fires on `execsSinceNudge === 0`, so
      //   counting a search as evidence would let an agent answer "prove it"
      //   with a database lookup and walk away — precisely the hallucinated
      //   verification that gate exists to catch.
      // - It does not touch `lastExecFailed`; no command ran, so the last
      //   command's verdict still stands.
      // - It does not call `recovery.observe`, matching every other
      //   non-executing branch (none/invalid/denied) and durable.ts's own
      //   search step. Consequence, accepted: repeated identical searches are
      //   not loop-detected, only bounded by maxSteps — exactly as a refused
      //   search is today.
      //
      // Fails open like the critic pass: a broken index degrades search to a
      // hint to use grep, it never ends the run.
      let observation: string;
      try {
        // scrub() for the same reason every command observation gets it
        // (prompt.ts formatObservation): this text reaches the model, the
        // event stream, the PR body and Observe. Search hits are REPO CONTENT
        // — a committed .env fixture, a token in a test file, a credential in
        // a config sample — so they are exactly as capable of carrying a
        // secret as a command's stdout, and they were the only observation in
        // the loop bypassing redaction.
        observation = scrub(formatSearchHits(action.query, await options.codeSearch(action.query)));
      } catch (error) {
        observation = `Code search failed (${error instanceof Error ? error.message : String(error)}). Use grep/rg via \`\`\`bash instead.`;
      }
      observation = truncate(observation, maxObs);
      messages.push({ role: "user", content: observation });
      steps.push({ index, thought, action, observation });
      emit({ type: "observation", step: index, text: observation });
      continue;
    }

    if (action.kind === "none" || action.kind === "invalid" || action.kind === "search") {
      // No runnable action (or a malformed one): feed the reason back.
      // ```search reaches here only when no `codeSearch` was supplied (it
      // needs a Nucleus code index behind it) — the prompt never advertised
      // it, so this catches a model inventing the action, and points it at
      // grep. Wording unchanged from before `codeSearch` existed.
      const nudge =
        action.kind === "invalid"
          ? action.message
          : action.kind === "search"
            ? "Code search is not available in this session. Use grep/rg via ```bash instead."
            : "No code block found. Respond with exactly one fenced code block (bash/python/edit/create), or a ```finish block if done.";
      messages.push({ role: "user", content: nudge });
      steps.push({ index, thought, action });
      emit({ type: "observation", step: index, text: nudge });
      continue;
    }

    if (options.approveAction !== undefined && (await options.approveAction(action)) === "required") {
      if (options.onApprovalRequest === undefined) {
        // No resolver in the live loop: treat as denied and let the agent adapt.
        const denied = "Action denied: it requires approval and no approver is available. Choose a safer action.";
        messages.push({ role: "user", content: denied });
        steps.push({ index, thought, action });
        emit({ type: "observation", step: index, text: denied });
        continue;
      }
      const approved = await options.onApprovalRequest(action);
      if (!approved) {
        const denied = "Action denied by the operator. Choose a different approach.";
        messages.push({ role: "user", content: denied });
        steps.push({ index, thought, action });
        emit({ type: "observation", step: index, text: denied });
        continue;
      }
    }

    if (action.kind === "python") kernelUsed = true;
    let result: ExecResult;
    try {
      result = await executeAction(options.executor, action, options.actionTimeoutMs, `${session}-s${index}`, options.kernel !== false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", step: index, text: message });
      return { status: "error", summary: `Execution failed: ${message}`, steps, messages, usage };
    }

    if (result.exitCode === 0) anySuccessfulAction = true;
    execsSinceNudge += 1;
    lastExecFailed = result.exitCode !== 0;
    const observation = truncate(formatObservation(result), maxObs);
    messages.push({ role: "user", content: observation });
    steps.push({ index, thought, action, result, observation });
    emit({ type: "observation", step: index, text: observation });

    // Recovery: break loops, thrashing, and busywork before they burn the
    // budget. The diff fingerprint is what turns "the command worked" into
    // "the work moved"; it is advisory, so a non-repo workspace just passes
    // undefined and the progress check stays dormant.
    if (recovery !== null) {
      const fingerprint = await workspaceFingerprint(options.executor);
      const signal = recovery.observe(action, result.exitCode, fingerprint?.hash, fingerprint?.dirty);
      if (signal.kind === "abort") {
        emit({ type: "error", step: index, text: signal.message });
        return { status: "error", summary: signal.message, steps, messages, usage };
      }
      if (signal.kind === "stop") {
        // The work is in the tree and has stopped moving: end on the agent's
        // own last account of it where there is one, rather than on a harness
        // sentence that tells a reviewer nothing.
        const summary = lastHeldFinish ?? signal.message;
        emit({ type: "finish", step: index, text: summary });
        return { status: "settled", summary, steps, messages, usage };
      }
      if (signal.kind === "nudge") {
        messages.push({ role: "user", content: signal.message });
        emit({ type: "observation", step: index, text: signal.message });
      }
    }
  }

  return {
    status: "max-steps",
    summary: `Reached the ${maxSteps}-step limit without finishing.`,
    steps,
    messages,
    usage,
  };
  } finally {
    // A local kernel is a real OS process; never leak it past the run.
    if (kernelUsed && options.kernel !== false) {
      await stopKernel(options.executor);
    }
  }
}

/**
 * Execute a code action through an executor. Shared by the live loop and
 * the durable workflow. `scriptSuffix` keeps replayed and live runs
 * writing the same paths (a durable step must be deterministic — no
 * Date.now() in filenames).
 *
 * Python prefers the persistent kernel (variables survive between
 * actions); if the kernel can't start in this workspace it falls back to
 * per-file execution. Edit/create run over getFile/putFile — structured
 * file surgery with no shell quoting anywhere.
 */
export async function executeAction(
  executor: AgentExecutor,
  action: Extract<Action, { kind: "bash" | "python" | "edit" | "create" }>,
  timeoutMs?: number,
  scriptSuffix?: string,
  useKernel = true,
): Promise<ExecResult> {
  const opts = timeoutMs !== undefined ? { timeoutMs } : {};
  const suffix = scriptSuffix ?? String(Date.now());

  switch (action.kind) {
    case "bash":
      return executor.exec(action.code, opts);

    case "python": {
      if (useKernel) {
        await installKernel(executor);
        if (await ensureKernel(executor)) {
          return runCell(executor, suffix, action.code, timeoutMs);
        }
      }
      const scriptPath = `.teploy-agent/step-${suffix}.py`;
      await executor.putFile(scriptPath, action.code);
      return executor.exec(`python3 ${scriptPath}`, opts);
    }

    case "create":
      await executor.putFile(action.file, action.content);
      return ok(`created ${action.file} (${action.content.length} chars)`);

    case "edit": {
      let current: string;
      try {
        current = new TextDecoder().decode(await executor.getFile(action.file));
      } catch {
        return fail(`edit failed: no such file: ${action.file} (use \`\`\`create for new files)`);
      }
      const occurrences = action.search === "" ? 0 : current.split(action.search).length - 1;
      if (occurrences === 0) {
        return fail(
          `edit failed: SEARCH text not found in ${action.file}. Read the file and copy the exact text (whitespace matters).`,
        );
      }
      if (occurrences > 1) {
        return fail(
          `edit failed: SEARCH text appears ${occurrences} times in ${action.file}. Include more surrounding lines to make it unique.`,
        );
      }
      await executor.putFile(action.file, current.replace(action.search, action.replace));
      return ok(`edited ${action.file}: 1 replacement`);
    }
  }
}

function ok(message: string): ExecResult {
  return { exitCode: 0, stdout: message, stderr: "", timedOut: false, truncated: false };
}

function fail(message: string): ExecResult {
  return { exitCode: 1, stdout: "", stderr: message, timedOut: false, truncated: false };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} chars truncated] ...\n${text.slice(-tail)}`;
}

/** Harness scratch inside the workspace — never the agent's deliverable. */
const AGENT_SCRATCH = ".teploy-agent";

/** What `workspaceFingerprint` answers: has the work changed, and is there any. */
export interface WorkspaceFingerprint {
  hash: string;
  dirty: boolean;
}

/**
 * A cheap stand-in for "has the work changed": the hash of the working-tree
 * diff stat. Undefined outside a git repo, in which case progress detection is
 * simply off rather than guessing.
 *
 * `dirty` is the second question the same output answers — is there any
 * candidate work in the tree at all — which is what separates "verifying a
 * finished change" from "never built anything". It is derived from the stat,
 * not from the hash: the hash of an EMPTY diff is a perfectly stable value, so
 * a run that never edits anything looks identical to one that settled.
 *
 * Exported so the durable loop (durable.ts) fingerprints with THIS function
 * rather than a hand-synced copy. Two implementations of the same measurement,
 * kept in step by hand, is precisely the failure this codebase keeps finding.
 * The durable loop wraps the call in a recorded step, which is what keeps the
 * read replay-safe; the function itself performs real I/O and must never be
 * called outside one there.
 */
export async function workspaceFingerprint(
  executor: AgentExecutor,
): Promise<WorkspaceFingerprint | undefined> {
  const result = await executor.exec("git add -A >/dev/null 2>&1; git diff --cached --stat", { timeoutMs: 30_000 }).catch(() => null);
  if (result === null || result.exitCode !== 0) return undefined;
  // Hash the raw stat exactly as before — changing what is hashed would change
  // progress detection for every caller, settle option or not.
  return { hash: createHash("sha256").update(result.stdout).digest("hex").slice(0, 16), dirty: statTouchesWork(result.stdout) };
}

/**
 * Does a `--stat` name at least one changed path that is the agent's work?
 *
 * Path lines are `<path> | <n> <+->`; the trailing "N files changed" summary
 * has no bar. Kernel scratch is excluded here as well as by the repo-local
 * git exclude the repo/benchmark paths install, because a plain `run` in an
 * arbitrary directory has no such exclude — and scratch alone must never make
 * an empty run look like finished work.
 */
function statTouchesWork(stat: string): boolean {
  for (const line of stat.split("\n")) {
    const bar = line.lastIndexOf("|");
    if (bar === -1) continue;
    const path = line.slice(0, bar).trim();
    if (path === "" || path === AGENT_SCRATCH || path.startsWith(`${AGENT_SCRATCH}/`)) continue;
    return true;
  }
  return false;
}
