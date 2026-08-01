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

test("parses a search action; empty query is invalid", () => {
  assert.deepEqual(parseAction("Let me find it.\n```search\nwhere is retry backoff handled?\n```"), {
    kind: "search",
    query: "where is retry backoff handled?",
  });
  assert.equal(parseAction("```search\n\n```").kind, "invalid");
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

test("XML tool-call dialect is rescued into real actions", () => {
  // observed live: Haiku emits its native tool syntax, hallucinates the
  // result, then finishes — the invoke must win over the trailing finish
  const relapse = `I'll check the log.
<function_calls>
<invoke name="bash">
<parameter name="command">wc -l events.log</parameter>
</invoke>
</function_calls>
Great, 12 lines. All done.
\`\`\`finish
Processed the log.
\`\`\``;
  const action = parseAction(relapse);
  assert.equal(action.kind, "bash");
  assert.equal((action as { code: string }).code, "wc -l events.log");

  const py = parseAction('<invoke name="python">\n<parameter name="code">print(1+1)</parameter>\n</invoke>');
  assert.equal(py.kind, "python");

  // a fenced block that comes FIRST still wins
  const fencedFirst = parseAction('```bash\nls\n```\n<invoke name="bash"><parameter name="command">rm x</parameter></invoke>');
  assert.equal(fencedFirst.kind, "bash");
  assert.equal((fencedFirst as { code: string }).code, "ls\n");

  // unknown tools and cut-off invokes get the corrective message, not silence
  const unknown = parseAction('<invoke name="str_replace_editor"><parameter name="path">x</parameter></invoke>');
  assert.equal(unknown.kind, "invalid");
  const cutOff = parseAction('<invoke name="bash">\n<parameter name="command">ls');
  assert.equal(cutOff.kind, "invalid");
});

test("TS-055: model-supplied paths cannot escape the workspace or touch git internals", () => {
  const bad = [
    "/etc/passwd",
    "../../secrets.txt",
    "a/../../b",
    "C:\\Windows\\system32\\drivers\\etc\\hosts",
    ".git/config",
    ".teploy-agent/kernel/kernel.py",
  ];
  for (const file of bad) {
    const action = parseAction("```create " + file + "\nx\n```");
    assert.equal(action.kind, "invalid", `${file} must be refused`);
  }
  for (const file of bad) {
    const action = parseAction("```edit " + file + "\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```");
    assert.equal(action.kind, "invalid", `${file} must be refused for edit too`);
  }

  // Ordinary relative paths still work, including dotfiles that are not git's.
  for (const file of ["src/index.ts", "./lib/util.js", "docs/.eslintrc.json", ".github/workflows/ci.yml"]) {
    const action = parseAction("```create " + file + "\nx\n```");
    assert.equal(action.kind, "create", `${file} should be allowed`);
  }
});

test("TS-055: the XML rescue picks the command parameter by NAME, not by position", () => {
  // Native tool-call payloads often put `description` first. Taking the first
  // parameter ran the description as a shell command and dropped the real one.
  const xml =
    '<invoke name="bash">' +
    '<parameter name="description">List the files in the repository</parameter>' +
    '<parameter name="command">ls -la</parameter>' +
    "</invoke>";
  const action = parseAction(xml);
  assert.equal(action.kind, "bash");
  assert.equal(action.kind === "bash" ? action.code : "", "ls -la");

  const py =
    '<invoke name="python">' +
    '<parameter name="explanation">compute the total</parameter>' +
    '<parameter name="code">print(1+1)</parameter>' +
    "</invoke>";
  const pyAction = parseAction(py);
  assert.equal(pyAction.kind, "python");
  assert.equal(pyAction.kind === "python" ? pyAction.code : "", "print(1+1)");

  // No recognisable command parameter at all is a correction, not a guess.
  const vague = '<invoke name="bash"><parameter name="notes">something</parameter></invoke>';
  assert.equal(parseAction(vague).kind, "invalid");
});
