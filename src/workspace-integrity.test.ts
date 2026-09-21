import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentExecutor } from "@neutron-build/agents";
import { assertRestoredRepository } from "./workspace-integrity.js";
const repo = "https://git.example.com/team/site.git";
const executor = (stdout: string, exitCode = 0) => ({ exec: async () => ({ stdout, stderr: "", exitCode }) }) as unknown as AgentExecutor;
test("restore refuses missing checkout and wrong repository before agent execution", async () => {
  await assert.rejects(assertRestoredRepository(executor("", 128), repo), /missing a valid repository/);
  await assert.rejects(assertRestoredRepository(executor(`true\n${"a".repeat(40)}\nhttps://git.example.com/team/other`), repo), /different repository/);
  await assertRestoredRepository(executor(`true\n${"a".repeat(40)}\nhttps://git.example.com/team/site`), repo);
  await assertRestoredRepository(executor(`true\n${"b".repeat(40)}\nhttps://git.example.com/fork/site`), repo, true);
});
