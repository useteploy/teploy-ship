import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterCallOptions, ModelAdapter } from "@neutron-build/ai";

import { CRITIC_APPROVE_TOKEN, criticFeedback, isApproved, readFileTool, reviewWork } from "./critic.js";

test("isApproved accepts the exact token the critic is asked for", () => {
  assert.equal(isApproved(CRITIC_APPROVE_TOKEN), true);
  assert.equal(isApproved("  APPROVE  "), true);
  assert.equal(isApproved("APPROVE\n"), true);
});

test("isApproved tolerates case and a trailing sentence mark", () => {
  assert.equal(isApproved("Approve"), true);
  assert.equal(isApproved("APPROVE."), true);
  assert.equal(isApproved("Approve!"), true);
});

test("isApproved accepts a verdict alone on the final line", () => {
  assert.equal(isApproved("Looks correct.\nAPPROVE"), true);
  assert.equal(isApproved("Checked the diff against the task.\n\nAPPROVE"), true);
  assert.equal(isApproved("Reasoning here.\napprove."), true);
});

// The gate must fail CLOSED. A substring test (the original bug) reads every
// one of these as an approval and ships work the critic explicitly rejected.
test("isApproved rejects prose that merely contains the token", () => {
  assert.equal(isApproved("I cannot APPROVE this — the fix is wrong."), false);
  assert.equal(isApproved("I do not APPROVE."), false);
  assert.equal(isApproved("APPROVE is not warranted: the test still fails."), false);
  assert.equal(isApproved("This does not APPROVE of the change"), false);
  assert.equal(isApproved("Cannot approve — missing a null check on line 12."), false);
});

test("isApproved rejects empty and non-verdict text", () => {
  assert.equal(isApproved(""), false);
  assert.equal(isApproved("   "), false);
  assert.equal(isApproved("The diff looks fine to me."), false);
});

test("criticFeedback carries the review into an actionable nudge", () => {
  const nudge = criticFeedback("  The retry loop is unbounded.  ");
  assert.match(nudge, /The retry loop is unbounded\./);
  assert.match(nudge, /finish again/);
});

// --- A3: the reviewer sees the suite, and can read the file it is judging ---

/**
 * A model that answers "APPROVE" once and records exactly what it was asked.
 *
 * The point of these tests is the REQUEST, not the reply: the bug they exist
 * to prevent is a reviewer that forms a verdict without the suite result, or
 * one that is told about a `read_file` tool it was never given.
 */
function recordingModel(reply = CRITIC_APPROVE_TOKEN): {
  model: ModelAdapter;
  calls: AdapterCallOptions[];
} {
  const calls: AdapterCallOptions[] = [];
  const model: ModelAdapter = {
    provider: "test",
    modelId: "recorder",
    async doGenerate(options) {
      calls.push(options);
      return {
        content: [{ type: "text", text: reply }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        raw: {},
      };
    },
    async *doStream() {
      throw new Error("not used");
    },
  };
  return { model, calls };
}

function promptText(options: AdapterCallOptions): string {
  return options.messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join("")))
    .join("\n");
}

test("the critic is shown the suite result over the same diff", async () => {
  const { model, calls } = recordingModel();
  await reviewWork(model, {
    task: "fix the retry backoff",
    summary: "done",
    diff: "--- a/src/retry.ts\n+++ b/src/retry.ts",
    evidence: "Tests: **FAILED** — `pnpm test` exited 1 after 12s.",
  });
  const asked = promptText(calls[0]!);
  assert.match(asked, /Tests: \*\*FAILED\*\*/, "the suite's verdict reaches the reviewer");
  assert.match(asked, /test suite, run by the harness/, "and is labelled as the harness's, not the agent's claim");
  assert.match(asked, /Treat it as fact, not as a claim/, "with the instruction that makes it outrank the summary");
});

test("no suite result means no evidence instructions — the reviewer is not told about a signal it lacks", async () => {
  const { model, calls } = recordingModel();
  await reviewWork(model, { task: "t", summary: "s", diff: "d" });
  const asked = promptText(calls[0]!);
  assert.doesNotMatch(asked, /Treat it as fact/);
  assert.doesNotMatch(asked, /test suite, run by the harness/);
});

test("a reviewer with no reader gets no tools and exactly one turn", async () => {
  const { model, calls } = recordingModel();
  await reviewWork(model, { task: "t", summary: "s", diff: "d" });
  assert.equal(calls[0]!.tools?.length ?? 0, 0, "toolless by default — the historical shape");
  assert.doesNotMatch(promptText(calls[0]!), /read_file/, "and is not told about a tool it does not have");
});

test("a reviewer given a reader gets read_file, and is told to use it before objecting", async () => {
  const { model, calls } = recordingModel();
  await reviewWork(model, { task: "t", summary: "s", diff: "d" }, { readFile: async () => "contents" });
  assert.deepEqual(
    calls[0]!.tools?.map((t) => t.name),
    ["read_file"],
    "exactly one tool: reading. A reviewer that can run commands is a second agent",
  );
  assert.match(promptText(calls[0]!), /Read before you object/);
});

test("read_file serves a file, and reports a failure as a finding rather than throwing", async () => {
  const tool = readFileTool(async (path) => {
    if (path === "src/a.ts") return "export const a = 1;\n";
    throw new Error("no such file");
  });
  const ok = await tool.execute!({ path: "src/a.ts" }, { toolCallId: "1" });
  assert.equal(ok, "export const a = 1;\n");
  const missing = await tool.execute!({ path: "src/gone.ts" }, { toolCallId: "2" });
  assert.match(String(missing), /Could not read src\/gone\.ts: no such file/);
  const empty = await tool.execute!({ path: "  " }, { toolCallId: "3" });
  assert.match(String(empty), /needs a path/);
});

test("read_file caps a huge file and says what it withheld, rather than feeding a silent prefix", async () => {
  const tool = readFileTool(async () => "x".repeat(500), 100);
  const out = String(await tool.execute!({ path: "big.min.js" }, { toolCallId: "1" }));
  assert.equal(out.startsWith("x".repeat(100)), true);
  assert.match(out, /400 more chars/);
  assert.match(out, /read a narrower path/);
});
