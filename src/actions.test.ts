import assert from "node:assert/strict";
import { test } from "node:test";

import { describeAction, parseAction } from "./actions.js";

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

// --- C2: the change-size ceiling -------------------------------------------
//
// The loop is one action per turn, and an `edit` action used to carry exactly
// one hunk whose SEARCH had to be globally unique in the file. So a rename
// across 30 call sites cost 30 of the run's 40 turns and could not finish —
// while the publish gate's own caps are 200 files and 20k lines. The ceiling
// was entirely in the action format.

test("one edit block can carry several hunks for the same file", () => {
  const action = parseAction(
    "```edit src/a.ts\n" +
      "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n" +
      "<<<<<<< SEARCH\nconst b = 1;\n=======\nconst b = 2;\n>>>>>>> REPLACE\n" +
      "```",
  );
  assert.equal(action.kind, "edit");
  assert.equal(action.kind === "edit" ? action.edits.length : 0, 2);
  assert.deepEqual(
    action.kind === "edit" ? action.edits.map((e) => e.file) : [],
    ["src/a.ts", "src/a.ts"],
  );
});

test("one edit block can carry several FILES, via --- headers", () => {
  const action = parseAction(
    "```edit\n" +
      "--- src/a.ts\n<<<<<<< SEARCH\noldName(\n=======\nnewName(\n>>>>>>> REPLACE\n" +
      "--- src/b.ts\n<<<<<<< SEARCH\noldName(\n=======\nnewName(\n>>>>>>> REPLACE\n" +
      "```",
  );
  assert.equal(action.kind, "edit");
  const edits = action.kind === "edit" ? action.edits : [];
  assert.deepEqual(edits.map((e) => e.file), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(edits.map((e) => e.search), ["oldName(\n", "oldName(\n"]);
});

test("the single-file form is unchanged, so every existing transcript still parses", () => {
  const action = parseAction("```edit path/to/file.py\n<<<<<<< SEARCH\nreturn x - 1\n=======\nreturn x + 1\n>>>>>>> REPLACE\n```");
  assert.deepEqual(action, {
    kind: "edit",
    edits: [{ file: "path/to/file.py", search: "return x - 1\n", replace: "return x + 1\n", all: false }],
  });
});

test("`all` is opt-in and parsed off the fence and off a --- header", () => {
  const fence = parseAction("```edit src/a.ts all\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```");
  assert.equal(fence.kind === "edit" ? fence.edits[0]?.all : null, true);
  assert.equal(fence.kind === "edit" ? fence.edits[0]?.file : null, "src/a.ts");

  const header = parseAction("```edit\n--- src/a.ts all\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```");
  assert.equal(header.kind === "edit" ? header.edits[0]?.all : null, true);
  assert.equal(header.kind === "edit" ? header.edits[0]?.file : null, "src/a.ts");

  const plain = parseAction("```edit src/a.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```");
  assert.equal(plain.kind === "edit" ? plain.edits[0]?.all : null, false, "never on by default");
});

test("path validation still binds every file in a multi-file edit", () => {
  const escape = parseAction(
    "```edit\n--- src/a.ts\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n" +
      "--- ../../etc/passwd\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```",
  );
  assert.equal(escape.kind, "invalid");
  assert.match(escape.kind === "invalid" ? escape.message : "", /'\.\.' is not allowed/);

  const git = parseAction("```edit\n--- .git/config\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```");
  assert.equal(git.kind, "invalid");
});

test("an edit block with no hunk is an actionable error, not a silent no-op", () => {
  const empty = parseAction("```edit src/a.ts\njust some prose\n```");
  assert.equal(empty.kind, "invalid");
  assert.match(empty.kind === "invalid" ? empty.message : "", /SEARCH/);
  assert.match(empty.kind === "invalid" ? empty.message : "", /more than one file/, "and it teaches the way out");

  const headerOnly = parseAction("```edit\n--- src/a.ts\nnothing here\n```");
  assert.equal(headerOnly.kind, "invalid");
  assert.match(headerOnly.kind === "invalid" ? headerOnly.message : "", /no SEARCH\/REPLACE hunk under "--- src\/a\.ts"/);
});

test("a bare edit fence with no path and no headers still says what it needs", () => {
  const bare = parseAction("```edit\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```");
  assert.equal(bare.kind, "invalid");
  assert.match(bare.kind === "invalid" ? bare.message : "", /needs a file path/);
});

test("describeAction summarises a multi-file edit without dumping it", () => {
  const one = describeAction({ kind: "edit", edits: [{ file: "a.ts", search: "x", replace: "y", all: false }] });
  assert.equal(one, "edit: a.ts");
  const many = describeAction({
    kind: "edit",
    edits: [
      { file: "a.ts", search: "x", replace: "y", all: false },
      { file: "b.ts", search: "x", replace: "y", all: false },
      { file: "b.ts", search: "p", replace: "q", all: false },
    ],
  });
  assert.equal(many, "edit: 2 files (3 hunks)");
});
