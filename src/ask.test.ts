import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAction } from "./actions.js";
import { ASK_DECLINED, askAnswerMessage, askEvent, isAskEvent, pendingQuestion } from "./ask.js";

test("```ask parses to an ask action; an empty block is invalid", () => {
  const a = parseAction("I need to know.\n```ask\nDelete the rows, or archive them?\n```");
  assert.deepEqual(a, { kind: "ask", question: "Delete the rows, or archive them?" });
  assert.equal(parseAction("```ask\n\n```").kind, "invalid");
});

test("askEvent / isAskEvent name the park and recognise it with and without an attempt prefix", () => {
  assert.equal(askEvent(4), "turn-4-ask");
  assert.ok(isAskEvent("turn-4-ask"));
  assert.ok(isAskEvent("attempt-2-turn-0-ask"));
  assert.ok(!isAskEvent("turn-4-approval"));
  assert.ok(!isAskEvent(undefined));
});

test("askAnswerMessage: answer or reason becomes the observation; nothing means decide yourself", () => {
  assert.equal(askAnswerMessage({ answer: "Archive them." }), "Operator's answer: Archive them.");
  assert.equal(askAnswerMessage({ approved: true, reason: "archive" }), "Operator's answer: archive");
  assert.equal(askAnswerMessage({ approved: false }), ASK_DECLINED);
  assert.equal(askAnswerMessage({ approved: true, reason: "  " }), ASK_DECLINED);
});

test("pendingQuestion reads the question off the think step the park belongs to, only while parked on it", () => {
  const events = [
    { type: "run-started", name: undefined },
    { type: "step-completed", name: "turn-0-think", data: { result: { text: "```bash\nls\n```" } } },
    { type: "step-completed", name: "turn-0-exec", data: { result: { exitCode: 0 } } },
    { type: "step-completed", name: "turn-1-think", data: { result: { text: "Hmm.\n```ask\nWhich DB?\n```" } } },
    { type: "event-waiting", name: "turn-1-ask" },
  ];
  assert.equal(pendingQuestion(events), "Which DB?");
  assert.equal(pendingQuestion(events.slice(0, -1)), undefined);
  assert.equal(pendingQuestion([...events.slice(0, -1), { type: "event-waiting", name: "turn-1-approval" }]), undefined);
  assert.equal(pendingQuestion([...events.slice(0, 3), { type: "step-completed", name: "attempt-0-turn-1-think", data: { result: "```ask\nA or B?\n```" } }, { type: "event-waiting", name: "attempt-0-turn-1-ask" }]), "A or B?");
});
