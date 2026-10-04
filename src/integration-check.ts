/**
 * S18 — the executed two-repository integration-check kind.
 *
 * integration-evidence.ts is the contract; coordination.ts only scans. This is
 * the missing executor leg: run a DECLARED pair-level command against the exact
 * producer and consumer revisions inside an AgentExecutor (LocalExecutor in
 * tests, the sandbox executor in production) and record evidence of class
 * "executed-pair" on the coordination.
 *
 * Choices worth knowing:
 *  - The trees are not trusted to be at the revision: each directory's HEAD is
 *    read back (`git rev-parse HEAD`) and must equal the recorded sha, and the
 *    tree must be clean. A mismatch records "not-run" (nothing ran, so it is
 *    neither pass nor fail) and the command is never executed.
 *  - Exit 0 is "passed", any other exit is "failed". A timeout, truncated
 *    output or an executor error is "unknown": the test did not give an answer.
 *  - The command is the coordination's own declaration; placeholders {producer}
 *    and {consumer} become the shell-quoted directories. Nothing is taken from
 *    a model.
 *  - Default off: SHIP_INTEGRATION_CHECK=on AND a declaration on the record.
 *    Without both, coordinationComplete is unchanged.
 */

import { withFileLock, assertSafeId } from "./file-store.js";
import { coordinationKey, loadCoordination } from "./coordination.js";
import type { CoordinationRecord } from "./coordination.js";
import type { IntegrationEvidence, EvidenceResult } from "./integration-evidence.js";
import type { ShipRuntime } from "./runtime.js";
import type { AgentExecutor } from "@neutron-build/agents";

export function integrationCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SHIP_INTEGRATION_CHECK ?? "").trim().toLowerCase() === "on";
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The revisions the pair currently stands at, from the coordination record. */
export function currentPairRevisions(record: CoordinationRecord): {
  producer: { repo: string; sha: string };
  consumer: { repo: string; sha: string };
} {
  return {
    producer: { repo: record.api.repo, sha: record.api.anchorSha ?? "" },
    consumer: { repo: record.client.repo, sha: record.client.mergedSha ?? record.client.anchorSha ?? "" },
  };
}

export interface PairTrees {
  /** Directory (inside the executor) holding the producer checkout. */
  producerDir: string;
  /** Directory (inside the executor) holding the consumer checkout. */
  consumerDir: string;
}

async function headState(executor: AgentExecutor, dir: string): Promise<{ sha?: string; dirty: boolean; problem?: string }> {
  const head = await executor.exec("git rev-parse HEAD", { cwd: dir, timeoutMs: 30_000 });
  if (head.exitCode !== 0) return { dirty: false, problem: `not a git checkout (${head.stderr.trim().slice(0, 120)})` };
  const status = await executor.exec("git status --porcelain", { cwd: dir, timeoutMs: 30_000 });
  if (status.exitCode !== 0) return { dirty: false, problem: "git status failed" };
  return { sha: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

/**
 * Run the declared command against the trees and return the evidence (which
 * the caller records). Never throws for a test outcome; executor faults are
 * "unknown".
 */
export async function runIntegrationCheck(input: {
  executor: AgentExecutor;
  record: CoordinationRecord;
  trees: PairTrees;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<IntegrationEvidence> {
  const { executor, record, trees } = input;
  const declared = record.integrationCheck;
  if (declared === undefined) throw new Error("This coordination did not declare an integration check.");
  const cur = currentPairRevisions(record);
  const at = (): string => (input.now?.() ?? new Date()).toISOString();
  const base = { class: "executed-pair" as const, producer: cur.producer, consumer: cur.consumer, command: declared.command };
  const out = (result: EvidenceResult, source: string): IntegrationEvidence => ({ ...base, result, at: at(), source });

  try {
    for (const [side, dir, want] of [
      ["producer", trees.producerDir, cur.producer.sha],
      ["consumer", trees.consumerDir, cur.consumer.sha],
    ] as const) {
      const s = await headState(executor, dir);
      if (s.problem !== undefined) return out("not-run", `${side} tree unusable: ${s.problem}`);
      if (s.sha !== want) return out("not-run", `${side} tree is at ${s.sha ?? "?"}, not the recorded ${want || "(unrecorded)"}`);
      if (s.dirty) return out("not-run", `${side} tree has uncommitted changes, so it is not the recorded revision`);
    }
    const command = declared.command
      .replaceAll("{producer}", shellQuote(trees.producerDir))
      .replaceAll("{consumer}", shellQuote(trees.consumerDir));
    const res = await executor.exec(command, { timeoutMs: input.timeoutMs ?? 120_000 });
    const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-400);
    if (res.timedOut) return out("unknown", `timed out: ${tail}`);
    if (res.truncated) return out("unknown", `output truncated, exit ${res.exitCode}: ${tail}`);
    return out(res.exitCode === 0 ? "passed" : "failed", `exit ${res.exitCode}: ${tail}`);
  } catch (error) {
    return out("unknown", `executor error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run the check and append its evidence to the coordination (additive field,
 * under the record's lock). Refuses unless the flag is on and the coordination
 * declared the check.
 */
export async function runCoordinationIntegrationCheck(
  runtime: ShipRuntime,
  coordinationId: string,
  options: { executor: AgentExecutor; trees: PairTrees; env?: NodeJS.ProcessEnv; now?: () => Date; timeoutMs?: number },
): Promise<{ record: CoordinationRecord; evidence: IntegrationEvidence }> {
  if (!integrationCheckEnabled(options.env)) throw new Error("The executed integration check is off (SHIP_INTEGRATION_CHECK is not on).");
  const record = await loadCoordination(runtime, coordinationId);
  if (record === null) throw new Error(`No coordination ${coordinationId}`);
  if (record.integrationCheck === undefined) throw new Error("This coordination did not declare an integration check.");
  // Run outside the lock (it can take minutes); the evidence carries the
  // revisions it ran against, so a record that moved meanwhile reads stale.
  const evidence = await runIntegrationCheck({
    executor: options.executor,
    record,
    trees: options.trees,
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  let saved: CoordinationRecord | null = null;
  await withFileLock(coordinationKey(assertSafeId("coordination id", coordinationId)), async () => {
    const current = await loadCoordination(runtime, coordinationId);
    if (current === null || current.integrationCheck === undefined) throw new Error(`No coordination ${coordinationId}`);
    const next: CoordinationRecord = {
      ...current,
      updatedAt: new Date().toISOString(),
      integrationCheck: { ...current.integrationCheck, evidence: [...current.integrationCheck.evidence, evidence] },
    };
    await runtime.config.set(coordinationKey(coordinationId), JSON.stringify(next), "coordination");
    saved = next;
  });
  return { record: saved!, evidence };
}
