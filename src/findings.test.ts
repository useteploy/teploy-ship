import assert from "node:assert/strict";
import { test } from "node:test";

import { FINDINGS_MARKER, MAX_FINDINGS, findingsSummary, normalizeSeverity, parseFindings } from "./findings.js";

const one = (extra: string): string =>
  `Looked at the deploy scripts.\n\n${FINDINGS_MARKER}\n[{"title":"t","severity":"high","file":"a.sh","detail":"d"${extra}}]`;

test("parseFindings reads the marker block a scan is told to emit", () => {
  const parsed = parseFindings(one(',"line":378,"fix":"read it from the environment"'));
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.findings, [
    { title: "t", severity: "high", file: "a.sh", line: 378, detail: "d", fix: "read it from the environment" },
  ]);
  assert.deepEqual(parsed.errors, []);
});

test("an explicit empty array is a real answer, not a missing one", () => {
  // The distinction the finish gate turns on: `found` decides whether the run
  // is sent back to work, and "this repository looks clean" must not be.
  const parsed = parseFindings(`Nothing worth reporting.\n\n${FINDINGS_MARKER}\n[]`);
  assert.equal(parsed.found, true);
  assert.equal(parsed.findings.length, 0);
  assert.equal(findingsSummary(parsed), "the scan reported no findings");
});

test("a finish with no array at all is NOT found — this is the MVP's failure, and the loop re-asks on it", () => {
  const parsed = parseFindings(
    "I reviewed the repository and found a hardcoded password in infra.sh as well as a curl-pipe-bash install path.",
  );
  assert.equal(parsed.found, false);
  assert.deepEqual(parsed.findings, []);
  assert.match(parsed.errors[0]!, /no FINDINGS_JSON array/);
  assert.equal(findingsSummary(parsed), "the scan finished without emitting a findings array");
});

test("a fenced or unmarked array still parses — format drift must not cost the whole scan", () => {
  const fenced = parseFindings('Summary.\n\n```json\n[{"title":"t","severity":"low","file":"a.ts","detail":"d"}]\n```');
  assert.equal(fenced.found, true);
  assert.equal(fenced.findings.length, 1);

  const bare = parseFindings('Summary.\n[{"title":"t","severity":"low","file":"a.ts","detail":"d"}]');
  assert.equal(bare.found, true);
  assert.equal(bare.findings.length, 1);
});

test("a bracket in prose does not win over the real array after the marker", () => {
  const text =
    `See actions.ts line [65] and the list [1, 2, 3].\n\n${FINDINGS_MARKER}\n` +
    '[{"title":"real","severity":"med","file":"src/a.ts","detail":"d"}]';
  const parsed = parseFindings(text);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]!.title, "real");
});

test("a ] inside a string does not truncate the array", () => {
  const parsed = parseFindings(
    `${FINDINGS_MARKER}\n[{"title":"t","severity":"high","file":"a.ts","detail":"the value is arr[0] and it is wrong"}]`,
  );
  assert.equal(parsed.findings.length, 1);
  assert.match(parsed.findings[0]!.detail, /arr\[0\]/);
});

test("a finding with no file is dropped, with the reason recorded", () => {
  const parsed = parseFindings(
    `${FINDINGS_MARKER}\n[{"title":"vague worry","severity":"high","detail":"something feels off"},` +
      '{"title":"real","severity":"low","file":"a.ts","detail":"d"}]',
  );
  assert.equal(parsed.findings.length, 1, "an unlocated finding cannot be checked and is not a finding");
  assert.equal(parsed.findings[0]!.title, "real");
  assert.match(parsed.errors.join(" "), /vague worry.*no file/);
});

test("aliases the model reaches for are accepted", () => {
  const parsed = parseFindings(
    `${FINDINGS_MARKER}\n[{"title":"t","severity":"critical","files":["src/a.ts"],"evidence":"e","proposed_fix":"f","line_number":12}]`,
  );
  assert.deepEqual(parsed.findings, [
    { title: "t", severity: "high", file: "src/a.ts", line: 12, detail: "e", fix: "f" },
  ]);
});

test("severity is normalised, never a reason to drop a finding", () => {
  assert.equal(normalizeSeverity("CRITICAL"), "high");
  assert.equal(normalizeSeverity("medium"), "med");
  assert.equal(normalizeSeverity("nit"), "low");
  assert.equal(normalizeSeverity(undefined), "med", "an unrecognised severity must not lose the finding");
  const parsed = parseFindings(`${FINDINGS_MARKER}\n[{"title":"t","severity":"spicy","file":"a.ts","detail":"d"}]`);
  assert.equal(parsed.findings[0]!.severity, "med");
});

test("duplicates collapse and the cap truncates rather than refusing the array", () => {
  const dupes = [
    '{"title":"same","severity":"low","file":"a.ts","detail":"d"}',
    '{"title":"SAME","severity":"high","file":"A.TS","detail":"d"}',
  ];
  const many = Array.from(
    { length: MAX_FINDINGS + 3 },
    (_, i) => `{"title":"t${i}","severity":"low","file":"f${i}.ts","detail":"d"}`,
  );
  const parsed = parseFindings(`${FINDINGS_MARKER}\n[${[...dupes, ...many].join(",")}]`);
  assert.equal(parsed.findings.length, MAX_FINDINGS);
  assert.match(parsed.errors.join(" "), /duplicate/);
  assert.match(parsed.errors.join(" "), new RegExp(`over the ${MAX_FINDINGS} cap`));
});

test("parseFindings never throws — it runs inside a recorded step", () => {
  // A step that throws re-runs on replay and can branch differently, which is
  // the determinism rule stated throughout durable.ts.
  for (const input of ["", "[", "[{", `${FINDINGS_MARKER}\n[not json]`, '[{"title":1}]', "[[]]"]) {
    assert.doesNotThrow(() => parseFindings(input), `input ${JSON.stringify(input)}`);
  }
  assert.equal(parseFindings("").found, false);
});

test("findingsSummary counts by severity", () => {
  const parsed = parseFindings(
    `${FINDINGS_MARKER}\n[{"title":"a","severity":"high","file":"a","detail":"d"},` +
      '{"title":"b","severity":"high","file":"b","detail":"d"},{"title":"c","severity":"low","file":"c","detail":"d"}]',
  );
  assert.equal(findingsSummary(parsed), "3 finding(s): 2 high, 1 low");
});
