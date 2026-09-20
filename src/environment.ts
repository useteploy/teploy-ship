import type { AgentExecutor } from "@neutron-build/agents";
import { safeForDisplay } from "./redact.js";

export interface EnvironmentPreparation {
  command: string;
  timeoutMs: number;
}
export interface EnvironmentResult {
  kind: "passed" | "failed";
  command: string;
  output: string;
  durationMs: number;
  exitCode?: number;
}
export function normalizePreparation(
  value: unknown,
): EnvironmentPreparation | undefined {
  if (value === undefined || value === null) return undefined;
  const p = value as Partial<EnvironmentPreparation>;
  const command = typeof p.command === "string" ? p.command.trim() : "";
  if (!command) return undefined;
  if (command.length > 8000)
    throw new Error("Environment preparation must be at most 8000 characters");
  const timeoutMs = p.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000)
    throw new Error("Environment timeout must be between 1 and 900 seconds");
  return { command, timeoutMs };
}
/** Operator-configured setup executes inside the same isolated workspace as the task. */
export async function prepareEnvironment(
  executor: AgentExecutor,
  preparation: EnvironmentPreparation,
): Promise<EnvironmentResult> {
  const start = Date.now();
  try {
    const r = await executor.exec(preparation.command, {
      timeoutMs: preparation.timeoutMs,
    });
    return {
      kind: r.exitCode === 0 ? "passed" : "failed",
      command: preparation.command,
      exitCode: r.exitCode,
      output: safeForDisplay(r.stdout + "\n" + r.stderr, 20000),
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      kind: "failed",
      command: preparation.command,
      output: safeForDisplay(e instanceof Error ? e.message : String(e)),
      durationMs: Date.now() - start,
    };
  }
}
