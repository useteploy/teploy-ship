import type { EventStore } from "@neutron-build/workflow";
import { assertSafeId } from "./file-store.js";

/** Stable conversation anchor, separate from an execution attempt's run ID.
 * Old histories are resolved without rewriting their events or workflow inputs.
 */
export async function taskRootRunId(store: Pick<EventStore, "load">, runId: string): Promise<string> {
  const seen = new Set<string>();
  let current = runId;
  for (let depth = 0; depth < 128; depth++) {
    assertSafeId("run id", current);
    if (seen.has(current)) throw new Error("Conversation history contains a cycle");
    seen.add(current);
    const started = (await store.load(current)).find(e => e.type === "run-started");
    if (!started) throw new Error(`Conversation history is missing run ${current}`);
    const data = started.data as { taskRootRunId?: unknown; input?: { parentRunId?: unknown } };
    // Newly recorded anchors avoid walking an ever-growing chain on follow-up.
    if (typeof data.taskRootRunId === "string") {
      const root = assertSafeId("task root run id", data.taskRootRunId);
      if (root === current) {
        if (data.input?.parentRunId !== undefined) throw new Error("Conversation anchor is not a root run");
        return root;
      }
      const rootStart = (await store.load(root)).find(e => e.type === "run-started");
      if (!rootStart) throw new Error(`Conversation history is missing root ${root}`);
      const rootData = rootStart.data as { input?: { parentRunId?: unknown } };
      if (rootData.input?.parentRunId !== undefined) throw new Error("Conversation anchor is not a root run");
      return root;
    }
    const parent = data.input?.parentRunId;
    if (parent === undefined) return current;
    if (typeof parent !== "string") throw new Error("Conversation history has an invalid parent reference");
    current = parent;
  }
  throw new Error("Conversation history exceeds the legacy traversal limit");
}
