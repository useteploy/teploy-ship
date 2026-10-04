/**
 * S17 part: incident evidence model and read-only timeline. PURE and UNWIRED.
 *
 * WHY. incidents.ts grades a scan run's write-up. Before (or beside) a model
 * reads anything, the observations themselves — health, a log excerpt, recent
 * deploys, migration state — should be turned into a record that keeps three
 * things apart that diagnoses habitually blur: what was OBSERVED, what is only
 * a HYPOTHESIS, and what is UNKNOWN. A page that shows "error rate up after
 * deploy" as a cause has already done the damage.
 *
 * RULES (each has a negative control in the test file).
 *  - Only observations attributed to the incident's own service become facts.
 *    Another service's numbers are listed as set aside, never evidence (the
 *    wrong-service story at the head of incidents.ts).
 *  - Unavailable telemetry, absent traffic or too few samples is UNKNOWN, never
 *    healthy. Healthy needs enough samples in a window.
 *  - A hypothesis never reaches "high" confidence here (the type forbids it),
 *    states what would confirm it, and is correlation by construction: a deploy
 *    before onset is a candidate, not a cause. "medium" needs two independent
 *    kinds of evidence pointing the same way.
 *  - A proposal is always `candidate-only`; nothing here can mark a fix certain
 *    or authorised. Low or missing confidence sets an actionable escalation.
 *  - Nothing observed is dropped: unparseable timestamps keep their entry,
 *    listed after the ordered ones, with an unknown-order flag.
 *
 * No I/O, no clock (the caller passes `now` inputs as observation times), no
 * model. Log text is CLAMPED here but must be redacted by the caller, as with
 * every other excerpt in incidents.ts.
 */

export type HealthStatus = "healthy" | "unhealthy" | "unavailable";

export interface HealthObservation {
  service: string;
  at: string;
  status: HealthStatus;
  /** Release the reading was attributed to, when the source knows. */
  release?: string;
  /** Requests/samples behind the reading; 0 or missing = no traffic evidence. */
  samples?: number;
  /** Why unavailable. */
  detail?: string;
}

export interface LogObservation {
  service: string;
  at: string;
  release?: string;
  excerpt: string;
}

export interface DeployObservation {
  service: string;
  at: string;
  revision: string;
  outcome: "succeeded" | "failed" | "unknown";
}

export interface MigrationObservation {
  service: string;
  /** "applied": ids were applied at/after `at`; "none": read and nothing applied; "unknown": not read. */
  state: "applied" | "none" | "unknown";
  at?: string;
  ids?: string[];
}

export interface IncidentEvidenceInput {
  /** The service the incident was attributed to. */
  service: string;
  health?: HealthObservation[];
  logs?: LogObservation[];
  deploys?: DeployObservation[];
  migration?: MigrationObservation;
  /** Minimum samples for a healthy reading to count. Default 5. */
  minSamples?: number;
  /** A deploy older than this before onset is not offered as a candidate. Default 24h. */
  deployWindowMs?: number;
}

export type EvidenceKind = "health" | "log" | "deploy" | "migration";

export interface Fact {
  id: string;
  kind: EvidenceKind;
  at?: string;
  /** What was observed, stated without interpretation. */
  statement: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  /** Never "high". */
  confidence: "low" | "medium";
  basis: string[];
  caveat: string;
  wouldConfirm: string[];
}

export interface Unknown {
  id: string;
  about: string;
  /** What to do to find out. */
  toResolve: string;
}

export interface SetAside {
  kind: EvidenceKind;
  service: string;
  reason: string;
}

export interface TimelineEntry {
  at: string | null;
  /** True when the timestamp could not be parsed; the entry sorts last. */
  orderUnknown: boolean;
  kind: EvidenceKind;
  factId: string;
  text: string;
}

export type Assessment = "unhealthy-observed" | "healthy-observed" | "unknown";

export interface IncidentEvidence {
  service: string;
  assessment: Assessment;
  facts: Fact[];
  hypotheses: Hypothesis[];
  unknowns: Unknown[];
  setAside: SetAside[];
  timeline: TimelineEntry[];
  /** A proposal can only ever be a candidate for a human to authorise. */
  proposal: { status: "candidate-only"; basis: string[]; note: string };
  escalation: { required: boolean; reason: string; actions: string[] };
}

export const LOG_EXCERPT_MAX = 600;
const ERROR_LINE = /\b(error|exception|fatal|panic|traceback|unhandled|5\d\d)\b/i;
const SCHEMA_LINE = /(column|relation|table)\b.*\b(does not exist|not found|missing)|\bmigration\b.*\b(fail|error|pending|lock)/i;

const clamp = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`);
const ts = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const sameService = (a: string, b: string): boolean => a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

export function buildIncidentEvidence(input: IncidentEvidenceInput): IncidentEvidence {
  const minSamples = input.minSamples ?? 5;
  const deployWindowMs = input.deployWindowMs ?? 24 * 3600_000;
  const facts: Fact[] = [];
  const unknowns: Unknown[] = [];
  const setAside: SetAside[] = [];
  const hypotheses: Hypothesis[] = [];
  const add = (kind: EvidenceKind, at: string | undefined, statement: string): Fact => {
    const f: Fact = { id: `f${facts.length + 1}`, kind, ...(at !== undefined ? { at } : {}), statement };
    facts.push(f);
    return f;
  };
  const unk = (about: string, toResolve: string): void => {
    unknowns.push({ id: `u${unknowns.length + 1}`, about, toResolve });
  };

  // ---- attribution: only the incident's own service becomes evidence
  const mine = <T extends { service: string }>(kind: EvidenceKind, xs: T[] | undefined): T[] => {
    const out: T[] = [];
    for (const x of xs ?? []) {
      if (sameService(x.service, input.service)) out.push(x);
      else setAside.push({ kind, service: x.service, reason: `attributed to "${x.service}", not the incident's service "${input.service}"` });
    }
    return out;
  };
  const health = mine("health", input.health);
  const logs = mine("log", input.logs);
  const deploys = mine("deploy", input.deploys);
  let migration = input.migration;
  if (migration !== undefined && !sameService(migration.service, input.service)) {
    setAside.push({ kind: "migration", service: migration.service, reason: `attributed to "${migration.service}", not the incident's service "${input.service}"` });
    migration = undefined;
  }

  // ---- health
  const unhealthy: { f: Fact; h: HealthObservation }[] = [];
  let healthyCounted = 0;
  let healthyThin = 0;
  let unavailable = 0;
  for (const h of health) {
    if (h.status === "unavailable") {
      unavailable++;
      add("health", h.at, `health read of ${h.service} was unavailable${h.detail ? ` (${clamp(h.detail, 120)})` : ""}`);
    } else if (h.status === "unhealthy") {
      const f = add("health", h.at, `${h.service} reported unhealthy${h.release ? ` on release ${h.release}` : ""} (${h.samples ?? 0} samples)`);
      unhealthy.push({ f, h });
    } else if ((h.samples ?? 0) >= minSamples) {
      healthyCounted++;
      add("health", h.at, `${h.service} reported healthy over ${h.samples} samples`);
    } else {
      healthyThin++;
      add("health", h.at, `${h.service} reported healthy but over only ${h.samples ?? 0} samples (< ${minSamples}); not counted as healthy`);
    }
  }
  let assessment: Assessment;
  if (unhealthy.length > 0) assessment = "unhealthy-observed";
  else if (healthyCounted > 0) assessment = "healthy-observed";
  else assessment = "unknown";
  if (assessment === "unknown") {
    unk(
      "current health",
      health.length === 0
        ? "no health reading for this service: read Observe (or the target's health endpoint) for it"
        : unavailable > 0 && healthyThin === 0
          ? "health reads were unavailable: fix telemetry access, then re-read"
          : `healthy readings had fewer than ${minSamples} samples: wait for traffic or read a longer window`,
    );
  }
  if (assessment === "unhealthy-observed" && healthyCounted > 0) {
    unk("whether the fault is ongoing", "healthy and unhealthy readings both exist: order them by time and re-read the latest window");
  }

  // ---- logs (observed lines only; no interpretation beyond a pattern count)
  const errorLogs: { f: Fact; l: LogObservation }[] = [];
  const schemaLogs: { f: Fact; l: LogObservation }[] = [];
  for (const l of logs) {
    const lines = l.excerpt.split("\n");
    const errs = lines.filter((x) => ERROR_LINE.test(x));
    const schema = lines.filter((x) => SCHEMA_LINE.test(x));
    const f = add("log", l.at, `log excerpt${l.release ? ` (release ${l.release})` : ""} has ${errs.length} of ${lines.length} line(s) matching an error pattern: ${clamp(errs[0] ?? lines[0] ?? "", LOG_EXCERPT_MAX)}`);
    if (errs.length > 0) errorLogs.push({ f, l });
    if (schema.length > 0) schemaLogs.push({ f, l });
  }
  if (logs.length === 0) unk("log evidence", "no log excerpt for this service: read the service logs around the first unhealthy reading");

  // ---- deploys
  const deployFacts = new Map<DeployObservation, Fact>();
  for (const d of deploys) {
    deployFacts.set(d, add("deploy", d.at, `deploy of revision ${d.revision} ${d.outcome}`));
  }
  if (input.deploys === undefined) unk("recent deploys", "deploy history was not read: read the delivery records for this service");

  // ---- migration
  let migFact: Fact | undefined;
  if (migration === undefined) {
    unk("migration state", "migration state was not read for this service: read the applied-migration list from the target");
  } else if (migration.state === "unknown") {
    unk("migration state", "migration state could not be read: read the applied-migration list from the target");
  } else if (migration.state === "none") {
    add("migration", migration.at, "no migration was applied in the observed period");
  } else {
    migFact = add("migration", migration.at, `migration(s) applied: ${(migration.ids ?? []).join(", ") || "(ids not recorded)"}`);
  }

  // ---- hypotheses: onset = the earliest unhealthy reading we can order
  const onsets = unhealthy.map((u) => ({ u, t: ts(u.h.at) })).filter((x): x is { u: typeof x.u; t: number } => x.t !== null).sort((a, b) => a.t - b.t);
  const onset = onsets[0];
  if (assessment === "unhealthy-observed") {
    if (onset === undefined) {
      unk("onset time", "no unhealthy reading has a parseable timestamp, so nothing can be correlated with it");
    } else {
      const cands = deploys
        .map((d) => ({ d, t: ts(d.at) }))
        .filter((x): x is { d: DeployObservation; t: number } => x.t !== null && x.d.outcome === "succeeded" && x.t <= onset.t && onset.t - x.t <= deployWindowMs)
        .sort((a, b) => b.t - a.t);
      const deploy = cands[0];
      if (deploy !== undefined) {
        const rel = deploy.d.revision;
        const attributed = onset.u.h.release === rel;
        const corroborated = errorLogs.some((e) => e.l.release === rel);
        const strong = attributed && corroborated;
        hypotheses.push({
          id: `h${hypotheses.length + 1}`,
          statement: `the fault may have been introduced by the deploy of ${rel}`,
          confidence: strong ? "medium" : "low",
          basis: [deployFacts.get(deploy.d)!.id, onset.u.f.id, ...(strong ? errorLogs.filter((e) => e.l.release === rel).map((e) => e.f.id) : [])],
          caveat: "timing correlation only; a deploy before onset is a candidate, not a cause",
          wouldConfirm: [
            ...(attributed ? [] : [`a health reading attributed to release ${rel} (the first unhealthy reading names ${onset.u.h.release ?? "no release"})`]),
            ...(corroborated ? [] : [`error log lines from release ${rel}`]),
            "the unhealthy reading clearing after recovery to the previous release",
          ],
        });
      } else if (deploys.length > 0 || input.deploys !== undefined) {
        add("deploy", undefined, "no succeeded deploy of this service precedes the first unhealthy reading within the window");
      }
      if (migFact !== undefined && migration?.state === "applied") {
        const mt = ts(migration.at);
        const before = mt !== null && mt <= onset.t;
        if (before) {
          const corroborated = schemaLogs.length > 0;
          hypotheses.push({
            id: `h${hypotheses.length + 1}`,
            statement: "the fault may be related to a schema change applied before onset",
            confidence: corroborated ? "medium" : "low",
            basis: [migFact.id, onset.u.f.id, ...schemaLogs.map((s) => s.f.id)],
            caveat: "a migration before onset is a candidate, not a cause",
            wouldConfirm: [
              ...(corroborated ? [] : ["log lines naming a missing column/relation or a failed migration"]),
              "the failure reproducing against the pre-migration schema",
            ],
          });
        } else if (mt === null) {
          unk("migration timing", "the migration observation has no parseable time, so it cannot be ordered against onset");
        }
      }
      if (hypotheses.length === 0) {
        unk("cause", "no deploy or migration correlates with the first unhealthy reading: widen the window or investigate dependencies and load");
      }
    }
  }

  // ---- timeline: ordered where we can, never dropping
  const timeline: TimelineEntry[] = facts.map((f) => {
    const t = ts(f.at);
    return { at: t === null ? null : new Date(t).toISOString(), orderUnknown: f.at !== undefined && t === null, kind: f.kind, factId: f.id, text: f.statement };
  });
  const dated = timeline.filter((e) => e.at !== null).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!) || a.factId.localeCompare(b.factId, "en", { numeric: true }));
  const undated = timeline.filter((e) => e.at === null);

  // ---- escalation: required unless healthy evidence stands, or the best hypothesis is medium and nothing is unresolved
  const best = hypotheses.some((h) => h.confidence === "medium") ? "medium" : hypotheses.length > 0 ? "low" : "none";
  const actions = [...unknowns.map((u) => u.toResolve), ...hypotheses.filter((h) => h.confidence === "low").flatMap((h) => h.wouldConfirm)];
  let reason: string;
  let required: boolean;
  if (assessment === "healthy-observed" && unknowns.every((u) => u.about !== "current health")) {
    required = false;
    reason = "healthy readings with enough samples; no fault observed (observation window only)";
  } else if (assessment === "unknown") {
    required = true;
    reason = "health is unknown; unknown is not healthy";
  } else if (best === "medium") {
    required = true;
    reason = "best hypothesis is medium confidence and correlational: a human must confirm before any change";
  } else {
    required = true;
    reason = best === "low" ? "only low-confidence hypotheses" : "no supported hypothesis";
  }

  return {
    service: input.service,
    assessment,
    facts,
    hypotheses,
    unknowns,
    setAside,
    timeline: [...dated, ...undated],
    proposal: {
      status: "candidate-only",
      basis: hypotheses.map((h) => h.id),
      note: hypotheses.length === 0 ? "no proposal: nothing supports one" : "any change is a candidate to investigate read-only first; it is not certain and is not authorised",
    },
    escalation: { required, reason, actions: [...new Set(actions)] },
  };
}
