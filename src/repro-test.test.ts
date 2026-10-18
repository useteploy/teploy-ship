import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import { runReproTestGate } from "./repro-test.js";

test("EV6: a failed stash restore after the base leg aborts the step instead of publishing the base tree", async () => {
  const seen: string[] = [];
  const executor = {
    async exec(command: string) {
      seen.push(command);
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false });
      if (command.startsWith("git diff --cached --numstat")) return ok("3\t0\tsrc/fix.ts\n4\t0\tsrc/fix.test.ts\n");
      if (command.startsWith("git diff --cached --name-only")) return ok("");
      if (command === "git stash pop") return { exitCode: 1, stdout: "", stderr: "conflict", timedOut: false, truncated: false };
      if (command.includes("npm test")) return { exitCode: 1, stdout: "", stderr: "fail", timedOut: false, truncated: false };
      return ok();
    },
  } as unknown as AgentExecutor;
  await assert.rejects(
    runReproTestGate(executor, { tests: { command: "npm test" } } as never, { testCommand: "npm test" } as never),
    /nothing is published/,
  );
  assert.ok(seen.some((c) => c.startsWith("git stash push")), "the base leg stashed the non-test change");
});
