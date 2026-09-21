import type { AgentExecutor } from "@neutron-build/agents";
/** Recovery check, not a substitute for sandbox isolation or commit-bound tests. */
export async function assertRestoredRepository(executor: AgentExecutor, expectedRepo?: string, isPullRequest = false): Promise<void> {
  if (!expectedRepo) return;
  const result = await executor.exec("git rev-parse --is-inside-work-tree && git rev-parse --verify HEAD && git remote get-url origin", { timeoutMs: 15000 });
  const [inside, head, origin] = result.stdout.trim().split(/\r?\n/);
  if (result.exitCode !== 0 || inside !== "true" || !/^[a-f0-9]{40,64}$/.test(head ?? "") || !origin) {
    throw new Error("Restored workspace is missing a valid repository checkout. Work stopped before the agent could act. Start a fresh attempt; do not reconstruct files from conversation history.");
  }
  const canonical = (value: string) => {
    try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`.toLowerCase(); }
    catch { return value.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase(); }
  };
  // PR work may be checked out from a fork. The forge resolver owns that identity.
  if (!isPullRequest && canonical(origin) !== canonical(expectedRepo)) throw new Error("Restored workspace belongs to a different repository. Work stopped; start a fresh attempt on the intended project.");
}
