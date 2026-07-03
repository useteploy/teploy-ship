import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAction } from "./actions.js";

test("parses a bash action", () => {
  assert.deepEqual(parseAction("Let me list files.\n```bash\nls -la\n```"), { kind: "bash", code: "ls -la\n" });
});

test("bare and sh fences are bash", () => {
  assert.equal(parseAction("```\necho hi\n```").kind, "bash");
  assert.equal(parseAction("```sh\necho hi\n```").kind, "bash");
});

test("parses a python action", () => {
  assert.deepEqual(parseAction("```python\nprint(2+2)\n```"), { kind: "python", code: "print(2+2)\n" });
  assert.equal(parseAction("```py\nx=1\n```").kind, "python");
});

test("finish carries the summary", () => {
  assert.deepEqual(parseAction("All done.\n```finish\nBuilt and ran it; output was 42.\n```"), {
    kind: "finish",
    message: "Built and ran it; output was 42.",
  });
});

test("takes the FIRST actionable block (one action per turn)", () => {
  const action = parseAction("```bash\nfirst\n```\nthen\n```bash\nsecond\n```");
  assert.deepEqual(action, { kind: "bash", code: "first\n" });
});

test("skips non-action fences to find the real action", () => {
  const action = parseAction("Here's the data:\n```json\n{\"a\":1}\n```\nNow run:\n```bash\ncat file\n```");
  assert.deepEqual(action, { kind: "bash", code: "cat file\n" });
});

test("prose with no code block yields none", () => {
  assert.deepEqual(parseAction("I think we should consider the options first."), { kind: "none" });
});
