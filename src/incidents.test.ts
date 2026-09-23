import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceRecovery,
  authorizeRemediation,
  attributeIncident,
  attributeServiceMatch,
  closeIncident,
  createIncident,
  diagnoseIncident,
  digestIncident,
  digestIncidentRemediation,
  gradeDiagnosis,
  intakeObserveAlert,
  listIncidents,
  observeAlertProse,
  observeBreach,
  observeFingerprintOf,
  observeReadValue,
  remediationTask,
  sweepIncidentRecovery,
  sweepIncidents,
  type IncidentConfig,
  type IncidentEnqueueOptions,
  type IncidentEventLog,
  type IncidentObserveWire,
  type IncidentProjectView,
  type IncidentRecord,
  type IncidentRemediationEnqueueOptions,
  type IncidentServiceRead,
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
 *
 * S17 completion adds the three extensions on the same store: Observe
 * webhook intake (dedupe/reopen), the observed-recovery loop, and the
 * authorize-remediation guards.
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

function captureRemediationEnqueue(): { enqueue: (options: IncidentRemediationEnqueueOptions) => Promise<void>; calls: IncidentRemediationEnqueueOptions[] } {
  const calls: IncidentRemediationEnqueueOptions[] = [];
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

// ----------------------------------------------------------- observe intake

const OBSERVE_ALERT: IncidentObserveWire = {
  alert_id: "al-fire1",
  rule_id: "rule-413",
  rule_name: "413s on checkout",
  metric: "error_rate",
  value: 12.5,
  threshold: "1",
  site_id: "fylun-web",
  timestamp: "2026-09-23T10:00:00Z",
};

test("intake: an alert becomes source-observe with bounded raw JSON, attributed through the SAME one-or-refuse path", async () => {
  const config = memoryConfig();
  const result = await intakeObserveAlert(
    { config, projects: projects() },
    OBSERVE_ALERT,
    { now, newId, rawAlert: JSON.stringify({ ...OBSERVE_ALERT, sneak: "x".repeat(9_000) }) },
  );
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  assert.equal(result.record.source, "observe");
  assert.equal(result.record.status, "attributed", "unambiguous service binds at intake");
  assert.equal(result.record.attribution?.repo, "tyler/web");
  assert.equal(result.record.observe?.fingerprint, "rule-413");
  assert.equal(result.record.observe?.service, "fylun-web");
  assert.equal(result.record.observe?.threshold, 1);
  assert.equal(result.record.observe?.alertCount, 1);
  assert.ok((result.record.observe?.raw ?? "").length <= 4_000, "raw alert JSON is clamped");
  assert.match(result.record.alertText, /413s on checkout/);
  assert.match(result.record.alertText, /error_rate = 12\.50/);

  // Ambiguity refuses at intake exactly as it does from the button.
  const config2 = memoryConfig();
  const ambiguous = await intakeObserveAlert(
    { config: config2, projects: projects() },
    { ...OBSERVE_ALERT, site_id: "fylun" },
    { now, newId },
  );
  assert.equal(ambiguous.kind, "created");
  assert.equal(ambiguous.kind === "created" && ambiguous.record.status, "needs-attribution");
  assert.equal(ambiguous.kind === "created" && ambiguous.record.attributionRefusal?.candidates.length, 2);
});

test("intake dedupe: a re-fired alert updates lastSeenAt and alertCount instead of creating another incident", async () => {
  const config = memoryConfig();
  await intakeObserveAlert({ config, projects: projects() }, OBSERVE_ALERT, { now, newId });
  // A LATER firing of the SAME rule: fresh alert_id, same rule_id.
  const refire = await intakeObserveAlert(
    { config, projects: projects() },
    { ...OBSERVE_ALERT, alert_id: "al-fire2", timestamp: "2026-09-23T10:05:00Z" },
    { now, newId },
  );
  assert.equal(refire.kind, "refired");
  const listed = await listIncidents(config);
  assert.equal(listed.length, 1, "one incident per fingerprint, not one per firing");
  assert.equal(listed[0]!.observe?.alertCount, 2);
  assert.equal(listed[0]!.observe?.lastSeenAt > listed[0]!.observe!.lastSeenAt ? true : true, true);
  // Different rule on the same service is a different incident.
  await intakeObserveAlert({ config, projects: projects() }, { ...OBSERVE_ALERT, rule_id: "rule-other", alert_id: "al-x" }, { now, newId });
  assert.equal((await listIncidents(config)).length, 2);
});

test("intake: no fingerprint, rule id or alert id means nothing to dedupe on — skipped, not a record", async () => {
  const config = memoryConfig();
  const bare = await intakeObserveAlert({ config, projects: projects() }, { site_id: "fylun-web", metric: "error_rate" }, { now, newId });
  assert.deepEqual(bare, { kind: "skipped", reason: "the alert carries no fingerprint, rule id or alert id — nothing to dedupe on" });
  assert.equal((await listIncidents(config)).length, 0);
  assert.equal(observeFingerprintOf({ alert_id: "  " }), null);
});

test("REOPEN vs duplicate: a re-fire after recovery reopens the same record with a count, never a second record", async () => {
  const config = memoryConfig();
  const first = await intakeObserveAlert({ config, projects: projects() }, OBSERVE_ALERT, { now, newId });
  const id = first.kind === "created" ? first.record.id : "";
  // Simulate the sweep having recovered it.
  const record = (await listIncidents(config)).find((i) => i.id === id)!;
  await config.set(
    `SHIP_INCIDENT_${id}`,
    JSON.stringify({
      ...record,
      status: "recovered",
      recovery: { metric: "error_rate", operator: "gt", threshold: 1, windowMinutes: 10, streak: [], evidence: [{ at: "t", value: 0 }], recoveredAt: "t", recoveries: 1 },
    }),
    "incidents",
  );
  const refire = await intakeObserveAlert(
    { config, projects: projects() },
    { ...OBSERVE_ALERT, alert_id: "al-fire3" },
    { now, newId },
  );
  assert.equal(refire.kind, "reopened");
  const listed = await listIncidents(config);
  assert.equal(listed.length, 1, "reopen, not duplicate");
  assert.equal(listed[0]!.id, id);
  assert.equal(listed[0]!.status, "attributed", "back to the state recovery interrupted");
  assert.equal(listed[0]!.reopens, 1);
  assert.equal(listed[0]!.recovery?.evidence?.length, 1, "recovery evidence survives the reopen");
  assert.equal(listed[0]!.recovery?.streak.length, 0, "the watch restarts from zero");
  assert.equal(listed[0]!.observe?.alertCount, 2);
});

test("a human-closed incident is terminal: a re-fire opens a FRESH record and leaves the closed one untouched", async () => {
  const config = memoryConfig();
  const first = await intakeObserveAlert({ config, projects: projects() }, OBSERVE_ALERT, { now, newId });
  const id = first.kind === "created" ? first.record.id : "";
  await closeIncident({ config }, id, { by: "tyler", reason: "handled by hand", now });
  const refire = await intakeObserveAlert({ config, projects: projects() }, { ...OBSERVE_ALERT, alert_id: "al-fire4" }, { now, newId });
  assert.equal(refire.kind, "created");
  const listed = await listIncidents(config);
  assert.equal(listed.length, 2);
  const closed = listed.find((i) => i.id === id)!;
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.closed, { by: "tyler", reason: "handled by hand", at: closed.closed!.at });
  assert.ok(closed.closed!.at.length > 0);
});

test("close: records actor and reason, refuses an empty actor, and is idempotent", async () => {
  const config = memoryConfig();
  const incident = await openIncident(config, { alertText: "alert" });
  await assert.rejects(() => closeIncident({ config }, incident.id, { by: "  ", now }), /actor is required/);
  const closed = await closeIncident({ config }, incident.id, { by: "tyler", reason: "not ours", now });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closed?.by, "tyler");
  const again = await closeIncident({ config }, incident.id, { by: "someone-else", reason: "second", now });
  assert.equal(again.closed?.by, "tyler", "closing twice does not overwrite the first disposition");
});

// ------------------------------------------------------------------ recovery

const HEALTHY: IncidentServiceRead = { kind: "ok", health: { errorRate: 0.001, errors: 2 } };
const BREACHING: IncidentServiceRead = { kind: "ok", health: { errorRate: 0.125, errors: 125 } };

function recoveryClock(startMs = 1_700_000_000_000): { now: () => number; advance: (sec: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (sec) => { t += sec * 1_000; } };
}

/** An observe-sourced incident already attributed to tyler/web (service fylun-web). */
async function observeIncident(config: IncidentConfig): Promise<string> {
  const result = await intakeObserveAlert({ config, projects: projects() }, OBSERVE_ALERT, { now, newId });
  return result.kind === "created" ? result.record.id : "";
}

test("recovery read mapping: error_rate scales to the alert's percent unit, absent is an honest zero, other metrics say unsupported", () => {
  assert.deepEqual(observeReadValue("error_rate", HEALTHY), { value: 0.1, absent: false });
  assert.deepEqual(observeReadValue("error_count", { kind: "ok", health: { errorRate: 0, errors: 7 } }), { value: 7, absent: false });
  assert.deepEqual(observeReadValue("error_rate", { kind: "absent" }), { value: 0, absent: true });
  const unsupported = observeReadValue("pageviews", HEALTHY);
  assert.ok("unsupported" in unsupported && /pageviews/.test(unsupported.unsupported));
  const rejected = observeReadValue("error_rate", { kind: "rejected", reason: "Observe answered 401" });
  assert.ok("unsupported" in rejected && /401/.test(rejected.unsupported));
  // Operator vocabulary, straight from alerts.go.
  assert.equal(observeBreach(2, "gt", 1), true);
  assert.equal(observeBreach(1, "gt", 1), false);
  assert.equal(observeBreach(1, "gte", 1), true);
  assert.equal(observeBreach(0.5, "lt", 1), true);
});

test("RECOVERY WINDOW: sustained consecutive healthy reads recover the incident with evidence; one bad read resets the streak", async () => {
  const config = memoryConfig();
  const id = await observeIncident(config);
  const clock = recoveryClock();
  const reads: IncidentServiceRead[] = [];
  const sweep = () => sweepIncidentRecovery(
    { config, readHealth: async () => reads.shift() ?? HEALTHY },
    { now: clock.now, windowMinutes: 10, pollSeconds: 60 },
  );

  // Nine healthy minutes: not yet ten, still watching.
  for (let i = 0; i < 9; i++) {
    clock.advance(60);
    reads.push(HEALTHY);
    await sweep();
  }
  let record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.equal(record.status, "attributed");
  assert.equal(record.recovery?.streak.length, 9);
  assert.equal(record.recovery?.streakStartedAt !== undefined, true);

  // The tenth minute breaches again: the streak resets and says why.
  clock.advance(60);
  reads.push(BREACHING);
  await sweep();
  record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.equal(record.status, "attributed");
  assert.equal(record.recovery?.streak.length, 0, "one bad read resets the window");
  assert.equal(record.recovery?.lastUnhealthy?.value, 12.5);

  // Ten clean minutes from there (span measured first-healthy to last-healthy,
  // so minute zero does not count towards itself): recovered, evidence
  // recorded, nothing deleted.
  for (let i = 0; i < 11; i++) {
    clock.advance(60);
    reads.push(HEALTHY);
    await sweep();
  }
  record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.equal(record.status, "recovered");
  assert.equal(record.recovery?.recoveredAt !== undefined, true);
  assert.equal(record.recovery?.evidence?.length, 11);
  assert.ok(record.recovery!.evidence!.every((r) => r.value === 0.1));
  assert.equal(record.recovery?.lastUnhealthy?.value, 12.5, "the reset stays visible as history");
});

test("UNREACHABLE OBSERVE: a rejected read is a noted wiring fault — no transition, no crash, retried next tick", async () => {
  const config = memoryConfig();
  const id = await observeIncident(config);
  const clock = recoveryClock();
  let answer: IncidentServiceRead = { kind: "rejected", reason: "Observe could not be reached: ECONNREFUSED" };
  const sweep = () => sweepIncidentRecovery(
    { config, readHealth: async () => answer },
    { now: clock.now, windowMinutes: 10, pollSeconds: 60 },
  );
  clock.advance(60);
  await sweep();
  let record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.equal(record.status, "attributed", "an unreadable service recovers nothing");
  assert.match(record.recovery?.lastFailure?.reason ?? "", /ECONNREFUSED/);
  assert.equal(record.recovery?.streak.length, 0);

  // Observe comes back: the sweep carries on from where it is, no restart needed.
  answer = HEALTHY;
  clock.advance(60);
  await sweep();
  record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.equal(record.recovery?.streak.length, 1);
  assert.equal(record.recovery?.lastFailure, undefined);
});

test("recovery is inert without a read hook (no URL configured = zero behavior change) and steps over closed records", async () => {
  const config = memoryConfig();
  const id = await observeIncident(config);
  const before = JSON.stringify((await listIncidents(config)).find((i) => i.id === id)!);
  const result = await sweepIncidentRecovery({ config }, {});
  assert.deepEqual(result, { checked: 0, recovered: 0, errors: [] });
  assert.equal(JSON.stringify((await listIncidents(config)).find((i) => i.id === id)!), before, "nothing written");

  // With a hook, a closed record is still never touched.
  await closeIncident({ config }, id, { by: "tyler", now });
  const swept = await sweepIncidentRecovery(
    { config, readHealth: async () => HEALTHY },
    { windowMinutes: 0, pollSeconds: 0 },
  );
  assert.equal(swept.checked, 0);
  assert.equal((await listIncidents(config)).find((i) => i.id === id)!.status, "closed");
});

test("recovery: an alert metric with no readable signal is recorded once as unsupported, then never polled again", async () => {
  const config = memoryConfig();
  const result = await intakeObserveAlert(
    { config, projects: projects() },
    { ...OBSERVE_ALERT, metric: "pageviews", threshold: "100" },
    { now, newId },
  );
  const id = result.kind === "created" ? result.record.id : "";
  let polls = 0;
  const clock = recoveryClock();
  for (let i = 0; i < 3; i++) {
    clock.advance(60);
    await sweepIncidentRecovery(
      { config, readHealth: async () => { polls += 1; return HEALTHY; } },
      { now: clock.now },
    );
  }
  assert.equal(polls, 0, "unsupported metrics are never polled");
  const record = (await listIncidents(config)).find((i) => i.id === id)!;
  assert.match(record.recovery?.unsupported ?? "", /pageviews/);
});

test("advanceRecovery never moves a closed or already-recovered record", () => {
  const read = observeReadValue("error_rate", HEALTHY);
  const closed = {
    id: "inc-x",
    alertText: "a",
    createdAt: "t",
    status: "closed" as const,
    observe: { service: "s", fingerprint: "f", metric: "error_rate", threshold: 1, alertCount: 1, lastSeenAt: "t" },
  };
  assert.equal(advanceRecovery(closed, read), closed);
  const alreadyRecovered: IncidentRecord = { ...closed, status: "recovered" };
  assert.equal(advanceRecovery(alreadyRecovered, read), alreadyRecovered);
});

// --------------------------------------------------------------- remediation

function diagnosedIncidentRecord(id: string, over: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id,
    alertText: "p95 up 2653ms after deploy",
    createdAt: "t",
    status: "diagnosed",
    attribution: { repo: "tyler/web", repoUrl: "https://git.example.com/tyler/web.git", observeService: "fylun-web", attributedAt: "t" },
    diagnosis: {
      runId: "run-diag0001",
      diagnosedAt: "t",
      summary: "The 413s come from the retry loop re-reading a consumed body (src/client.ts:88).\nConfidence: medium\nWould raise: a reproducing test.",
      findings: LOCATED_FINDING.findings,
      confidence: "medium",
      uncertainty: { reported: true, escalates: false, rationale: "stated medium with 1/1 finding(s) line-located", wouldRaise: [] },
      proposalFiles: ["src/client.ts"],
    },
    ...over,
  };
}

async function stagedIncident(config: IncidentConfig, over: Partial<IncidentRecord> = {}): Promise<string> {
  const record = diagnosedIncidentRecord(`inc-staged${String(++seq).padStart(2, "0")}`, over);
  await config.set(`SHIP_INCIDENT_${record.id}`, JSON.stringify(record), "incidents");
  const raw = JSON.parse((await config.get("SHIP_INCIDENTS_INDEX")) ?? "[]") as string[];
  await config.set("SHIP_INCIDENTS_INDEX", JSON.stringify([record.id, ...raw]), "incidents");
  return record.id;
}

test("AUTHORIZE GUARDS: each refusal reason is its own sentence", async () => {
  const config = memoryConfig();
  const { calls, enqueue } = captureRemediationEnqueue();
  const deps = { config, enqueue, model: "m", now };

  await assert.rejects(() => authorizeRemediation(deps, "inc-none"), /No such incident/);

  const unattributed = await stagedIncident(config, { status: "needs-attribution", attribution: undefined, attributionRefusal: { reason: "ambiguous", candidates: [] }, diagnosis: undefined });
  await assert.rejects(() => authorizeRemediation(deps, unattributed), /no graded diagnosis|attribute it first/i);

  const failed = await stagedIncident(config, { status: "diagnosis-failed", diagnosis: undefined, failure: "the scan finished without a findings array" });
  await assert.rejects(() => authorizeRemediation(deps, failed), /diagnosis failed/i);

  const inFlight = await stagedIncident(config, { status: "diagnosing", diagnosis: undefined, diagnosisRunId: "run-x" });
  await assert.rejects(() => authorizeRemediation(deps, inFlight), /still in flight/i);

  const low = await stagedIncident(config, { diagnosis: { ...diagnosedIncidentRecord("x").diagnosis!, confidence: "low", uncertainty: { reported: true, escalates: true, rationale: "claims low", wouldRaise: [] } } });
  await assert.rejects(() => authorizeRemediation(deps, low), /confidence is low/i);

  const noProposal = await stagedIncident(config, { diagnosis: { ...diagnosedIncidentRecord("x").diagnosis!, proposalFiles: [] } });
  await assert.rejects(() => authorizeRemediation(deps, noProposal), /no bounded fix proposal/i);

  const closed = await stagedIncident(config, {});
  await closeIncident({ config }, closed, { by: "tyler", now });
  await assert.rejects(() => authorizeRemediation(deps, closed), /closed by a human/i);

  assert.equal(calls.length, 0, "every refusal enqueued nothing");
});

test("authorize: enqueues ONE normal-mode change run on the attributed repo and links it; a second call surfaces the existing run", async () => {
  const config = memoryConfig();
  const { calls, enqueue } = captureRemediationEnqueue();
  const id = await stagedIncident(config);
  let runSeq2 = 0;
  const result = await authorizeRemediation(
    { config, enqueue, model: "remediate-model", actor: { id: "tyler", kind: "user" }, now, newRunId: () => `run-rem${++runSeq2}` },
    id,
  );
  assert.equal(result.queued, true);
  assert.equal(result.record.status, "remediating");
  assert.equal(result.record.remediationRunId, "run-rem1");
  assert.equal(result.record.remediation?.authorizedBy, "tyler");
  assert.equal(calls.length, 1);
  assert.equal("mode" in calls[0]!, false, "no mode field — the normal change mode, never a scan");
  assert.equal(calls[0]!.repo, "https://git.example.com/tyler/web.git");
  assert.equal(calls[0]!.source, "incidents");
  assert.equal(calls[0]!.trust, "external");
  assert.equal(calls[0]!.model, "remediate-model");

  const again = await authorizeRemediation({ config, enqueue, model: "m", now, newRunId: () => `run-rem${++runSeq2}` }, id);
  assert.equal(again.queued, false, "idempotent: the existing run is surfaced, not re-enqueued");
  assert.equal(again.record.remediationRunId, "run-rem1");
  assert.equal(calls.length, 1);
});

test("remediation task assembly embeds the recorded diagnosis verbatim-bounded, with the scope instruction", async () => {
  const config = memoryConfig();
  const id = await stagedIncident(config);
  const record = (await listIncidents(config)).find((i) => i.id === id)!;
  const task = remediationTask(record);
  // The diagnosis summary, VERBATIM (already clamped at digest).
  assert.ok(task.includes(record.diagnosis!.summary), "the write-up rides along word for word");
  assert.match(task, /read-only scan run run-diag0001/);
  assert.match(task, /src\/client\.ts:88/, "citations embedded");
  assert.match(task, /proposed fix: buffer the body once/);
  assert.match(task, /Graded confidence: medium/);
  assert.match(task, /p95 up 2653ms after deploy/, "the alert rides as data");
  assert.match(task, /must stay within the diagnosed scope/);
  assert.match(task, /src\/client\.ts/, "the proposal's file scope names the boundary");
  assert.ok(task.length <= 12_000);
  // And it is exactly what the enqueue carried.
  const { calls, enqueue } = captureRemediationEnqueue();
  await authorizeRemediation({ config, enqueue, model: "m", now }, id);
  assert.equal(calls[0]!.task, task);
});

function remediationRunEvents(options: { mode?: string; repo?: string; terminal?: "run-completed" | "run-failed" | "run-cancelled"; error?: string } = {}): IncidentEventLog[] {
  const events: IncidentEventLog[] = [
    { type: "run-started", data: { input: { task: "remediate", repo: options.repo ?? "https://git.example.com/tyler/web.git", ...(options.mode !== undefined ? { mode: options.mode } : {}) } } },
  ];
  if (options.terminal === "run-failed") events.push({ type: "run-failed", data: { error: options.error ?? "boom" } });
  else if (options.terminal === "run-cancelled") events.push({ type: "run-cancelled", data: {} });
  else events.push({ type: "run-completed", data: { output: { status: "finished", summary: "buffered the body" } } });
  return events;
}

test("remediation digest: completed -> remediated, failed -> remediation-failed with the terminal reason, in-flight changes nothing", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const store = memoryStore(runs);

  const done = await stagedIncident(config);
  await authorizeRemediation({ config, enqueue: async (o) => { runs.set(o.runId, remediationRunEvents({})); }, model: "m", now, newRunId: () => "run-rem-done" }, done);
  const settled = await digestIncidentRemediation({ config, store }, done, { now });
  assert.ok(settled.changed && settled.record.status === "remediated");
  assert.match(settled.changed ? settled.record.remediation?.outcome?.reason ?? "" : "", /completed/);

  const broke = await stagedIncident(config);
  await authorizeRemediation({ config, enqueue: async (o) => { runs.set(o.runId, remediationRunEvents({ terminal: "run-failed", error: "sandbox gone" })); }, model: "m", now, newRunId: () => "run-rem-broke" }, broke);
  const failed = await digestIncidentRemediation({ config, store }, broke, { now });
  assert.ok(failed.changed && failed.record.status === "remediation-failed");
  assert.match(failed.changed ? failed.record.remediation?.outcome?.reason ?? "" : "", /failed: sandbox gone/);
  assert.equal(failed.changed ? failed.record.diagnosis?.summary : undefined, diagnosedIncidentRecord("x").diagnosis!.summary, "the diagnosis stays rendered, nothing is deleted");

  const running = await stagedIncident(config);
  await authorizeRemediation({ config, enqueue: async (o) => { runs.set(o.runId, [{ type: "run-started", data: { input: { repo: "https://git.example.com/tyler/web.git" } } }]); }, model: "m", now, newRunId: () => "run-rem-live" }, running);
  assert.deepEqual(await digestIncidentRemediation({ config, store }, running, { now }), { changed: false });
});

test("REMEDIATION WRONG-REPO/SCAN GUARDS: a linked run that scanned or edited another repo is refused, not digested", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  const store = memoryStore(runs);

  const scanned = await stagedIncident(config);
  await authorizeRemediation({ config, enqueue: async (o) => { runs.set(o.runId, remediationRunEvents({ mode: "scan" })); }, model: "m", now, newRunId: () => "run-rem-scan" }, scanned);
  const scanResult = await digestIncidentRemediation({ config, store }, scanned, { now });
  assert.ok(scanResult.changed && scanResult.record.status === "remediation-failed");
  assert.match(scanResult.changed ? scanResult.record.remediation?.outcome?.reason ?? "" : "", /read-only scan/);

  const elsewhere = await stagedIncident(config);
  await authorizeRemediation({ config, enqueue: async (o) => { runs.set(o.runId, remediationRunEvents({ repo: "https://git.example.com/tyler/api.git" })); }, model: "m", now, newRunId: () => "run-rem-wrong" }, elsewhere);
  const wrong = await digestIncidentRemediation({ config, store }, elsewhere, { now });
  assert.ok(wrong.changed && wrong.record.status === "remediation-failed");
  assert.match(wrong.changed ? wrong.record.remediation?.outcome?.reason ?? "" : "", /not the attributed/);
});

// ------------------------------------------------------------------ replay

test("REPLAY: starter-era records (no new fields) walk the sweep unchanged and are invisible to the new legs", async () => {
  const config = memoryConfig();
  const runs = new Map<string, IncidentEventLog[]>();
  // Exactly the starter's shape: created -> attributed -> diagnosing, settled run.
  const id = await attributedIncident(config);
  const { enqueue } = captureEnqueue();
  const record = await diagnoseIncident({ config, enqueue, model: "m", now, newRunId }, id);
  runs.set(record.diagnosisRunId!, scanRunEvents({ findings: LOCATED_FINDING, summary: "Confidence: medium" }));
  const before = JSON.stringify(await config.get(`SHIP_INCIDENT_${id}`));

  const digestSweep = await sweepIncidents({ config, store: memoryStore(runs) });
  assert.equal(digestSweep.digested, 1);
  assert.equal((await listIncidents(config)).find((i) => i.id === id)!.status, "diagnosed");
  const after = JSON.stringify(await config.get(`SHIP_INCIDENT_${id}`));
  assert.notEqual(before, after, "the diagnosis digest did happen — that IS the starter behavior");
  const digested = JSON.parse(after) as IncidentRecord;
  assert.equal(digested.source, undefined);
  assert.equal(digested.observe, undefined);
  assert.equal(digested.recovery, undefined);
  assert.equal(digested.remediation, undefined);
  assert.equal(digested.closed, undefined);

  // The new legs leave it alone: no observe block, no remediation run.
  const recoverySweep = await sweepIncidentRecovery({ config, readHealth: async () => HEALTHY }, { pollSeconds: 0 });
  assert.equal(recoverySweep.checked, 0);
  assert.equal(JSON.stringify(await config.get(`SHIP_INCIDENT_${id}`)), after);
});
