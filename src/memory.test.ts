import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@neutron-build/ai";
import { condenseIfNeeded, historySize } from "./memory.js";

const summarize = async (transcript: string): Promise<string> => `SUMMARY(${transcript.length} chars)`;

function conversation(middleTurns: number, turnSize: number): Message[] {
  const messages: Message[] = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "TASK: do the thing" },
  ];
  for (let i = 0; i < middleTurns; i++) {
    messages.push({ role: "assistant", content: `a`.repeat(turnSize) });
    messages.push({ role: "user", content: `o`.repeat(turnSize) });
  }
  return messages;
}

test("small histories pass through untouched", async () => {
  const messages = conversation(2, 10);
  const condensed = await condenseIfNeeded(messages, summarize, { maxTokens: 28_000, keepRecent: 4, maxSummaryLayers: 3 });
  assert.deepEqual(condensed, messages);
});

test("oversized histories condense the middle and keep head + recent", async () => {
  const messages = conversation(20, 1000); // ~40k chars of middle
  const condensed = await condenseIfNeeded(messages, summarize, { maxTokens: 2_800, keepRecent: 6, maxSummaryLayers: 3 });

  // head (system + task) preserved verbatim
  assert.equal(condensed[0]?.content, "SYSTEM PROMPT");
  assert.equal(condensed[1]?.content, "TASK: do the thing");
  // a single summary message replaces the middle
  assert.equal(condensed[2]?.role, "user");
  assert.match(String(condensed[2]?.content), /Progress so far/);
  assert.match(String(condensed[2]?.content), /SUMMARY\(/);
  // the last keepRecent messages are the original tail, verbatim
  assert.deepEqual(condensed.slice(-6), messages.slice(-6));
  // and the result is dramatically smaller
  assert.ok(historySize(condensed) < historySize(messages) / 2);
});

test("condensation is skipped when there is no safe middle to summarize", async () => {
  // over budget, but keepRecent covers everything after the head
  const messages = conversation(3, 5000);
  const condensed = await condenseIfNeeded(messages, summarize, { maxTokens: 280, keepRecent: 6, maxSummaryLayers: 3 });
  assert.deepEqual(condensed, messages);
});
