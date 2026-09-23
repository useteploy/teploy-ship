import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attributeIncident,
  attributeServiceMatch,
  createIncident,
  diagnoseIncident,
  digestIncident,
  gradeDiagnosis,
  listIncidents,
  sweepIncidents,
  type IncidentConfig,
  type IncidentEnqueueOptions,
  type IncidentEventLog,
  type IncidentProjectView,
} from "./incidents.js";
import type { ParsedFindings } from "./findings.js";

/**
 * S17 starter — the incident record store, the two negative guards and the
 * read-only diagnosis journey they gate.
 *
 * The two negatives the journey is graded on:
 *  - WRONG SERVICE: attribution resolves one repo or refuses, listing what it
 *    matched — zero and (worse) multiple matches both park, never guess.
 *  - UNCERTAIN DIAGNOSIS: a write-up that asserts without evidence is graded
 *    down and escalates, using canned transcripts shaped exactly like the
 *    scan-findings step a real run records.
 */

function memoryConfig(): IncidentConfig {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

const PROJECTS: IncidentProjectView[] = [
  { repo: "tyler/web", url: "https://git.example.com/tyler/web.git", observeService: "fylun-web" },
  { repo: "tyler/api", url: "https://git.example.com/tyler/api.git", observeService: "fylun-api" },
  { repo: "tyler/web-cache", url: "https://git.example.com/tyler/web-cache.git", observeService: "web" },
  { repo: "tyler/docs", url: "https://git.example.com/tyler/docs.git" },
];

function projects(list: readonly IncidentProjectView[] = PROJECTS): { list(): Promise<readonly IncidentProjectView[]> } {
  return { list: async () => list };
}

let clock = 0;
const now = (): number => 1_700_000_000_000 + clock++ * 1_000;
let seq = 0;
const newId = (): string => `inc-test${String(++seq).padStart(4, "0")}`;
let runSeq = 0;
const newRunId = (): string => `run-diag${String(++runSeq).padStart(4, "0")}`;

async function openIncident(config: IncidentConfig, alert: { alertText: string; serviceHint?: string }) {
  return createIncident(config, alert, { now, newId });
}

// ------------------------------------------------------------------ attribution

test("attribution: exact match wins, case- and space-insensitively", () => {
  const exact = attributeServiceMatch(PROJECTS, "  FYLUN-WEB ");
  assert.equal(exact.kind, "attributed");
  assert.equal(exact.kind === "attributed" && exact.repo, "tyler/web");
  // "web" substrings two services but exactly names one: exact goes first.
  const short = attributeServiceMatch(PROJECTS, "web");
  assert.equal(short.kind, "attributed");
  assert.equal(short.kind === "attributed" && short.repo, "tyler/web-cache");
});

test("attribution: a unique substring binds the service an operator half-typed", () => {
  const outcome = attributeServiceMatch(PROJECTS, "fylun-web");
  assert.equal(outcome.kind, "attributed");
  assert.equal(outcome.kind === "attributed" && outcome.repo, "tyler/web");
});

test("WRONG-SERVICE NEGATIVE: an ambiguous hint refuses and lists every candidate", async () => {
  const outcome = attributeServiceMatch(PROJECTS, "fylun");
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  assert.match(outcome.reason, /ambiguous/);
  assert.deepEqual(
    outcome.candidates,
    [
      { repo: "tyler/web", observeService: "fylun-web" },
      { repo: "tyler/api", observeService: "fylun-api" },
    ],
  );

  // And through the store: the incident parks on needs-attribution carrying
  // the candidates, so a human breaks the tie instead of a guess doing it.
  const config = memoryConfig();
  const incident = await openIncident(config, { alertText: "error rate up", serviceHint: "fylun" });
  const parked = await attributeIncident({ config, projects: projects() }, incident.id, { now });
  assert.equal(parked.status, "needs-attribution");
  assert.equal(parked.attribution, undefined);
  assert.equal(parked.attributionRefusal?.candidates.length, 2);
  assert.match(parked.attributionRefusal?.reason ?? "", /ambiguous/);
});

test("WRONG-SERVICE NEGATIVE: zero matches and no hint at all both refuse with no candidates", async () => {
  assert.deepEqual(attributeServiceMatch(PROJECTS, "nothing"), {
    kind: "refused",
    reason: 'no project declares an Observe service matching "nothing"',
    candidates: [],
  });
  const noHint = attributeServiceMatch(PROJECTS, "");
  assert.equal(noHint.kind, "refused");
  assert.deepEqual(noHint.kind === "refused" && noHint.candidates, []);

  const config = memoryConfig();
  const incident = await openIncident(config, { alertText: "alert with no service name" });
  const parked = await attributeIncident({ config, projects: projects() }, incident.id, { now });
  assert.equal(parked.status, "needs-attribution");
  assert.deepEqual(parked.attributionRefusal?.candidates, []);
});

test("attribution: a project without an observeService is never a candidate", () => {
  for (const hint of ["docs", "tyler/docs", ""]) {
    const outcome = attributeServiceMatch(PROJECTS, hint);
    assert.equal(outcome.kind, "refused", `hint "${hint}" must not bind tyler/docs`);
  }
});

test("attribution: two projects declaring the SAME service name refuse (configuration mistake)", () => {
  const dupes: IncidentProjectView[] = [
    { repo: "a/one", observeService: "shared" },
    { repo: "a/two", observeService: "shared" },
  ];
  const outcome = attributeServiceMatch(dupes, "shared");
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.kind === "refused" && outcome.candidates.length, 2);
});

test("re-attribution is allowed after a refusal (with a corrected hint), and forbidden while a run is in flight", async () => {
  const config = memoryConfig();
  const incident = await openIncident(config, { alertText: "alert", serviceHint: "nope" });
  const refused = await attributeIncident({ config, projects: projects() }, incident.id, { now });
  assert.equal(refused.status, "needs-attribution");
  // The operator answers the refusal in place: the corrected hint is written
  // onto the record and the exact match binds.
  const bound = await attributeIncident({ config, projects: projects() }, incident.id, { now, hint: "fylun-web" });
  assert.equal(bound.status, "attributed");
  assert.equal(bound.attribution?.repo, "tyler/web");
  assert.equal(bound.attribution?.observeService, "fylun-web");
  assert.equal(bound.serviceHint, "fylun-web");
  assert.equal(bound.attributionRefusal, undefined);

  const diagnosing = { ...bound, status: "diagnosing" as const, diagnosisRunId: "run-x" };
  await config.set(`SHIP_INCIDENT_${bound.id}`, JSON.stringify(diagnosing), "incidents");
  await assert.rejects(
    () => attributeIncident({ config, projects: projects() }, bound.id, { now }),
    /in flight/,
  );
});

// ----------------------------------------------------------------------- store

test("create rejects empty alert text, clamps over-long input, and the index stays bounded", async () => {
  const config = memoryConfig();
  await assert.rejects(() => createIncident(config, { alertText: "   " }, { now, newId }), /needs the alert text/);
  const long = await createIncident(config, { alertText: "x".repeat(7_000) }, { now, newId });
  assert.equal(long.alertText.length <= 6_000, true);

  for (let i = 0; i < 205; i++) await createIncident(config, { alertText: `alert ${i}` }, { now, newId });
  const listed = await listIncidents(config);
  assert.equal(listed.length, 200);
  // Newest first: the last-created incident leads the list.
  assert.match(listed[0]!.alertText, /alert 204$/);
});

test("listIncidents skips a corrupt record instead of failing the page", async () => {
  const config = memoryConfig();
  const good = await openIncident(config, { alertText: "good" });
  await openIncident(config, { alertText: "bad" });
  const ids = JSON.parse((await config.get("SHIP_INCIDENTS_INDEX")) ?? "[]") as string[];
  // Newest first, so the corrupt one is the head of the index.
  await config.set(`SHIP_INCIDENT_${ids[0]!}`, "{not json", "incidents");
  const listed = await listIncidents(config);
  assert.deepEqual(listed.map((i) => i.id), [good.id]);
});

// -------------------------------------------------------------------- diagnose

function captureEnqueue(): { enqueue: (options: IncidentEnqueueOptions) => Promise<void>; calls: IncidentEnqueueOptions[] } {
  const calls: IncidentEnqueueOptions[] = [];
  return { calls, enqueue: async (options) => { calls.push(options); } };
}

async function attributedIncident(config: IncidentConfig): Promise<string> {
  const incident = await openIncident(config, { alertText: "p95 up 2653ms after deploy", serviceHint: "fylun-web" });
  await attributeIncident({ config, projects: projects() }, incident.id, { now });
  return incident.id;
}

test("diagnose refuses until attributed, then enqueues exactly one READ-ONLY scan on the attributed repo", async () => {
  const config = memoryConfig();
  const unattributed = await openIncident(config, { alertText: "alert" });
  const { calls, enqueue } = captureEnqueue();
  await assert.rejects(() => diagnoseIncident({ config, enqueue, model: "m" }, unattributed.id), /Attribute this incident/);

  const id = await attributedIncident(config);
  const record = await diagnoseIncident({ config, enqueue, model: "test-model", now, newRunId }, id);
  assert.equal(record.status, "diagnosing");
  assert.equal(calls.length, 1);
  const enqueued = calls[0]!;
  // The read-only contract, as recorded facts of the enqueue rather than
  // promises in prose: scan mode, the attributed repo (clone URL preferred),
  // its own spend lane, alert-driven trust.
  assert.equal(enqueued.mode, "scan");
  assert.equal(enqueued.repo, "https://git.example.com/tyler/web.git");
  assert.equal(enqueued.source, "incidents");
  assert.equal(enqueued.trust, "external");
  assert.equal(enqueued.model, "test-model");
  assert.equal(record.diagnosisRunId, enqueued.runId, "the run id links back to the incident");
  assert.match(enqueued.task, /p95 up 2653ms after deploy/);
  assert.match(enqueued.task, /Confidence: high/);
  assert.match(enqueued.task, /Do not implement anything/);

  // One run at a time per incident.
  await assert.rejects(() => diagnoseIncident({ config, enqueue, model: "m", now, newRunId }, id), /in flight/);
});

// ---------------------------------------------------------------------- digest

type ScanRunOptions = {
  mode?: string;
  findings?: ParsedFindings;
  summary?: string;
  terminal?: "run-completed" | "run-failed" | "run-cancelled";
  error?: string;
};

/** A run log shaped exactly like the events a real scan writes. */
function scanRunEvents(options: ScanRunOptions): IncidentEventLog[] {
  const events: IncidentEventLog[] = [
    {
      type: "run-started",
      data: {
        input: {
          task: "diagnose",
          repo: "https://git.example.com/tyler/web.git",
          mode: options.mode ?? "scan",
        },
      },
    },
  ];
  if (options.findings !== undefined) {
    events.push({ type: "step-completed", name: "scan-findings", data: { result: options.findings } });
  }
  if (options.terminal === "run-failed") {
    events.push({ type: "run-failed", data: { error: options.error ?? "boom" } });
  } else if (options.terminal === "run-cancelled") {
    events.push({ type: "run-cancelled", data: {} });
  } else {
    events.push({ type: "run-completed", data: { output: { status: "finished", summary: options.summary ?? "" } } });
  }
  return events;
}

function memoryStore(runs: Map<string, IncidentEventLog[]>, throwOn?: string): { load(runId: string): Promise<IncidentEventLog[]> } {
  return {
    async load(runId) {
      if (runId === throwOn) throw new Error("unreadable log");
      return runs.get(runId) ?? [];
    },
  };
}

async function diagnosingIncident(
  config: IncidentConfig,
  runs: Map<string, IncidentEventLog[]>,
  run: IncidentEventLog[],
): Promise<string> {
  const id = await attributedIncident(config);
  const { enqueue } = captureEnqueue();
  const record = await diagnoseIncident({ config, enqueue, model: "m", now, newRunId }, id);
  runs.set(record.diagnosisRunId!, run);
  return id;
}

const LOCATED_FINDING: ParsedFindings = {
  found: true,
  errors: [],
  findings: [
    {
      title: "retry loop re-reads a closed response body",
      severity: "high",
      file: "src/client.ts",
      line: 88,
      detail: "the loop retries on EOF but the body was already consumed, so every retry 413s",
      fix: "buffer the body once before the retry loop; affected files: src/client.ts",
    },
  ],
};

test("UNCERTAIN-DIAGNOSIS NEGATIVE: a confident write-up with no evidence is graded low and escalates", async () => {
  // The canned transcript: asserts a root cause, cites a file but no line,
  // never states confidence — exactly the finish that reads as a diagnosis
  // and is not one.
  const graded = gradeDiagnosis(
    {
      found: true,
      errors: [],
      findings: [{ title: "the retry loop is broken", severity: "high", file: "src/client.ts", detail: "clearly the cause" }],
    },
    "Root cause identified. The retry loop is broken and the fix is ready to ship.",
  );
  assert.equal(graded.confidence, "low");
  assert.equal(graded.uncertainty.reported, false);
  assert.equal(graded.uncertainty.escalates, true);
  assert.match(graded.uncertainty.rationale, /no confidence level/);
  const raise = graded.uncertainty.wouldRaise.join(" | ");
  assert.match(raise, /Confidence: high/);
  assert.match(raise, /line citations/);
  assert.match(raise, /fix proposal/);

  // And through the digest, so the INCIDENT (not just the grader) says it.
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const id = await diagnosingIncident(config, runs, scanRunEvents({ findings: { found: true, errors: [], findings: [{ title: "the retry loop is broken", severity: "high", file: "src/client.ts", detail: "clearly the cause" }] }, summary: "Root cause identified. The fix is ready." }));
  const result = await digestIncident({ config, store: memoryStore(runs) }, id, { now });
  assert.equal(result.changed, true);
  assert.ok(result.changed && result.record.status === "diagnosed");
  const diagnosis = result.changed ? result.record.diagnosis : undefined;
  assert.equal(diagnosis?.confidence, "low");
  assert.equal(diagnosis?.uncertainty.escalates, true);
});

test("grading: a claimed high with no line-level citations steps down to medium", () => {
  const unlocated: ParsedFindings = {
    found: true,
    errors: [],
    findings: [{ title: "the retry loop is broken", severity: "high", file: "src/client.ts", detail: "the cause", fix: "buffer the body" }],
  };
  const graded = gradeDiagnosis(unlocated, "Confidence: high\nWould raise: nothing.");
  assert.equal(graded.confidence, "medium");
  assert.equal(graded.uncertainty.escalates, false);
  assert.match(graded.uncertainty.rationale, /no line-level citations/);
});

test("grading: an honest medium with located evidence and a proposal is taken at its word", () => {
  const graded = gradeDiagnosis(
    LOCATED_FINDING,
    "The 413s come from the retry loop re-reading a consumed body (src/client.ts:88).\nConfidence: medium\nWould raise: a failing test that reproduces the 413.",
  );
  assert.equal(graded.confidence, "medium");
  assert.equal(graded.uncertainty.reported, true);
  assert.equal(graded.uncertainty.escalates, false);
  assert.deepEqual(graded.uncertainty.wouldRaise, []);
});

test("grading: zero findings is low and escalates, whatever was claimed", () => {
  const graded = gradeDiagnosis({ found: true, errors: [], findings: [] }, "Nothing in this repository explains the alert. Confidence: high");
  assert.equal(graded.confidence, "low");
  assert.equal(graded.uncertainty.escalates, true);
  assert.match(graded.uncertainty.rationale, /no findings/);
});

test("digest: a good run lands diagnosed with findings, confidence, proposal scope and the run link", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const id = await diagnosingIncident(
    config,
    runs,
    scanRunEvents({ findings: LOCATED_FINDING, summary: "The 413s come from the retry loop.\nConfidence: medium\nWould raise: a reproducing test." }),
  );
  const result = await digestIncident({ config, store: memoryStore(runs) }, id, { now });
  assert.ok(result.changed && result.record.status === "diagnosed");
  const record = result.changed ? result.record : undefined;
  assert.equal(record?.diagnosis?.findings.length, 1);
  assert.equal(record?.diagnosis?.confidence, "medium");
  assert.deepEqual(record?.diagnosis?.proposalFiles, ["src/client.ts"]);
  assert.match(record?.diagnosis?.summary ?? "", /Confidence: medium/);
  assert.equal(record?.diagnosis?.runId, record?.diagnosisRunId, "the diagnosis links back to the run");
});

test("digest: a still-running run changes nothing; a settled one digests exactly once", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const id = await diagnosingIncident(config, runs, [
    { type: "run-started", data: { input: { task: "t", repo: "r", mode: "scan" } } },
  ]);
  const store = memoryStore(runs);
  assert.deepEqual(await digestIncident({ config, store }, id, { now }), { changed: false });

  runs.set((await listIncidents(config)).find((i) => i.id === id)!.diagnosisRunId!, scanRunEvents({ findings: LOCATED_FINDING, summary: "Confidence: low" }));
  const first = await digestIncident({ config, store }, id, { now });
  assert.equal(first.changed, true);
  const second = await digestIncident({ config, store }, id, { now });
  assert.equal(second.changed, false, "a digested incident is not diagnosing; re-digesting is a no-op");
});

test("digest: failed, cancelled and array-less runs are diagnosis-failed with the reason recorded", async () => {
  for (const [name, events, match] of [
    ["failed", scanRunEvents({ terminal: "run-failed", error: "sandbox gone" }), /failed: sandbox gone/],
    ["cancelled", scanRunEvents({ terminal: "run-cancelled" }), /cancelled/],
    ["no findings array", scanRunEvents({ findings: { found: false, findings: [], errors: ["no array"] }, summary: "prose only" }), /without a findings array/],
  ] as const) {
    const config = memoryConfig();
    const runs = new Map<string, IncidentEventLog[]>();
    const id = await diagnosingIncident(config, runs, [...events]);
    const result = await digestIncident({ config, store: memoryStore(runs) }, id, { now });
    assert.ok(result.changed && result.record.status === "diagnosis-failed", name);
    assert.match(result.changed ? result.record.failure ?? "" : "", match, name);
  }
});

test("READ-ONLY GUARD: a linked run that is not a scan is refused, not digested", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const id = await diagnosingIncident(config, runs, scanRunEvents({ mode: "fix", findings: LOCATED_FINDING, summary: "fixed it" }));
  const result = await digestIncident({ config, store: memoryStore(runs) }, id, { now });
  assert.ok(result.changed && result.record.status === "diagnosis-failed");
  assert.match(result.changed ? result.record.failure ?? "" : "", /not a read-only scan/);
});

// ---------------------------------------------------------------------- sweep

test("sweepIncidents digests every settled diagnosing incident, isolates errors, and is idempotent", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const settled = await diagnosingIncident(config, runs, scanRunEvents({ findings: LOCATED_FINDING, summary: "Confidence: medium" }));
  const running = await diagnosingIncident(config, runs, [{ type: "run-started", data: { input: { mode: "scan" } } }]);
  const broken = await diagnosingIncident(config, runs, scanRunEvents({ findings: LOCATED_FINDING, summary: "x" }));

  const brokenRunId = (await listIncidents(config)).find((i) => i.id === broken)!.diagnosisRunId!;
  const runtime = { config, store: memoryStore(runs, brokenRunId) };
  const first = await sweepIncidents(runtime);
  assert.equal(first.digested, 1);
  assert.deepEqual(first.errors.map((e) => e.id), [broken]);
  assert.match(first.errors[0]!.error, /unreadable log/);

  const records = await listIncidents(config);
  assert.equal(records.find((i) => i.id === settled)?.status, "diagnosed");
  assert.equal(records.find((i) => i.id === running)?.status, "diagnosing");
  assert.equal(records.find((i) => i.id === broken)?.status, "diagnosing");

  const second = await sweepIncidents(runtime);
  assert.equal(second.digested, 0);
  // The unreadable log is repaired and settles as a completed run with no
  // findings step: the incident fails honestly rather than staying diagnosing
  // forever on one bad event log.
  runs.set(brokenRunId, scanRunEvents({ summary: "x" }));
  const third = await sweepIncidents({ config, store: memoryStore(runs) });
  assert.equal(third.digested, 1);
  assert.equal((await listIncidents(config)).find((i) => i.id === broken)?.status, "diagnosis-failed");
});
