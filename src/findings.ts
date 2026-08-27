/**
 * Scan findings — the deliverable of a `mode: "scan"` run (L2 / D3).
 *
 * WHY THIS FILE EXISTS AT ALL. The prompt-only scan MVP asked the agent to
 * write `.teploy-agent/findings.json`, which is the one path in the workspace
 * that CANNOT hold a deliverable: `validateActionPath` refuses it
 * (actions.ts:65), `setupRepo` git-excludes it (git.ts:141, :556) and the
 * publish screen lists it as never-publishable (publish-policy.ts:62). Three of
 * seven nightly scans parked on `cat > .teploy-agent/findings.json`
 * (approval.test.ts:39 still pins that exact command as an approval-required
 * one) and all seven produced zero findings.
 *
 * So findings are RUN DATA, not a repo path. They come out of the agent's own
 * ```finish block, are parsed here, and are recorded as a `scan-findings` step
 * plus a field on the run's output — both of which live in the event log and
 * survive the sandbox by construction. No file is written anywhere, so nothing
 * can be refused, excluded, parked on, or accidentally pushed.
 *
 * Dependency-free on purpose, like plan.ts: the dashboard imports the types.
 */

/** How bad the scan says it is. Three levels, because a fourth is never used. */
export type FindingSeverity = "low" | "med" | "high";

export interface ScanFinding {
  /** One line naming the defect. */
  title: string;
  severity: FindingSeverity;
  /**
   * Repo-relative path the finding is about. REQUIRED, and a finding without
   * one is dropped: an unlocated finding cannot be checked, cannot be deduped
   * (the L2 fingerprint is repo + title + files) and cannot be turned into a
   * task anyone can act on.
   */
  file: string;
  /** 1-based line, when the finding is about a specific one. */
  line?: number;
  /** What is wrong, and how the scan established it. */
  detail: string;
  /** What to do about it, when the scan proposes something concrete. */
  fix?: string;
}

export interface ParsedFindings {
  /**
   * Whether a findings array was located AT ALL. Distinct from
   * `findings.length === 0`, and the distinction is the forcing function: an
   * explicit `[]` is a scan reporting a clean repository and is honoured, while
   * `found: false` is a finish that ignored the contract and is sent back once
   * (see SCAN_FINDINGS_NUDGE in durable.ts).
   */
  found: boolean;
  findings: ScanFinding[];
  /** Why entries were dropped, or why nothing parsed. Recorded on the step. */
  errors: string[];
}

/**
 * Hard cap on findings per scan. A scan that reports fifty things has reported
 * nothing: the list stops being a queue and becomes a wall. Extra entries are
 * dropped with a recorded reason rather than the whole array being refused —
 * 25 real findings are worth more than a validation error.
 */
export const MAX_FINDINGS = 25;

const MAX_TITLE = 200;
const MAX_FILE = 512;
const MAX_TEXT = 2000;

/** The marker the scan prompt tells the agent to put before its JSON array. */
export const FINDINGS_MARKER = "FINDINGS_JSON";

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** First non-empty string among several aliases the model may have used. */
function alias(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = str(record[key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Normalise whatever word the model reached for.
 *
 * Deliberately forgiving, and deliberately never dropping a finding over it:
 * the severity is the least load-bearing field here, and refusing a real
 * security finding because it said "critical" instead of "high" would be the
 * MVP's failure mode wearing a validator.
 */
export function normalizeSeverity(value: unknown): FindingSeverity {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "high" || raw === "critical" || raw === "crit" || raw === "severe" || raw === "blocker") return "high";
  if (raw === "low" || raw === "minor" || raw === "info" || raw === "nit" || raw === "trivial") return "low";
  return "med"; // "med", "medium", "moderate", anything unrecognised
}

/**
 * Slice a balanced JSON array starting at `from`, or null if it never closes.
 *
 * String-aware, because a `]` inside a finding's detail text ("see line [42]")
 * would otherwise end the slice early and turn a whole scan into a parse error.
 */
function sliceArray(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * Locate the findings array in a finish message.
 *
 * The agent is told to emit `FINDINGS_JSON` followed by the array, but a
 * scan's whole value is destroyed by a format quibble, so this also accepts a
 * bare array anywhere in the message and a fenced one (the fence body contains
 * the `[`, so no fence handling is needed — the bracket scan finds it either
 * way). Searching only AFTER the last marker when one is present keeps a
 * bracketed citation earlier in the prose from winning.
 */
function locateArray(text: string): unknown[] | null {
  const marker = text.toUpperCase().lastIndexOf(FINDINGS_MARKER);
  const region = marker === -1 ? text : text.slice(marker + FINDINGS_MARKER.length);
  let empty: unknown[] | null = null;
  for (let i = region.indexOf("["); i !== -1; i = region.indexOf("[", i + 1)) {
    const slice = sliceArray(region, i);
    if (slice === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    // An array of objects is the contract. An empty array is a real answer
    // ("nothing found") but is also what a stray `[]` in prose looks like, so
    // it is only used when no object array turns up later in the message.
    if (parsed.length > 0 && parsed.every((e) => typeof e === "object" && e !== null && !Array.isArray(e))) return parsed;
    if (parsed.length === 0 && empty === null) empty = parsed;
  }
  return empty;
}

/**
 * Parse and validate the findings a scan run's finish message carries.
 *
 * Never throws: this runs inside a recorded step, and a step that throws
 * re-runs on replay and can branch differently (the rule stated throughout
 * durable.ts). Everything it refuses is reported in `errors` instead.
 */
export function parseFindings(text: string): ParsedFindings {
  const errors: string[] = [];
  const located = locateArray(text ?? "");
  if (located === null) {
    return {
      found: false,
      findings: [],
      errors: [`no ${FINDINGS_MARKER} array found in the finish message`],
    };
  }

  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  let overCap = 0;
  for (const [index, entry] of located.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`entry ${index + 1} is not an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const title = alias(record, ["title", "summary", "name"]);
    if (title === null) {
      errors.push(`entry ${index + 1} has no title`);
      continue;
    }
    // `files: [...]` is what the L2 sketch proposed; the singular `file` is
    // what a finding actually needs. Both are accepted, first element wins —
    // a finding spanning six files is six findings or a bad finding.
    const list = Array.isArray(record.files) ? record.files.find((f) => typeof f === "string" && f.trim() !== "") : undefined;
    const file = alias(record, ["file", "path", "location"]) ?? (typeof list === "string" ? list : null);
    if (file === null) {
      errors.push(`dropped "${clamp(title, 60)}": no file, so nothing can check it`);
      continue;
    }
    const detail = alias(record, ["detail", "evidence", "description", "message", "why"]) ?? title;
    const fix = alias(record, ["fix", "proposed_fix", "proposedFix", "remediation", "suggestion"]);
    const rawLine = record.line ?? record.lineNumber ?? record.line_number;
    const line = typeof rawLine === "number" && Number.isFinite(rawLine) && rawLine >= 1 ? Math.trunc(rawLine) : undefined;

    const key = `${clamp(file, MAX_FILE).toLowerCase()} ${clamp(title, MAX_TITLE).toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`dropped a duplicate of "${clamp(title, 60)}" in ${clamp(file, 120)}`);
      continue;
    }
    seen.add(key);

    if (findings.length >= MAX_FINDINGS) {
      overCap += 1;
      continue;
    }
    findings.push({
      title: clamp(title, MAX_TITLE),
      severity: normalizeSeverity(record.severity),
      file: clamp(file, MAX_FILE),
      ...(line !== undefined ? { line } : {}),
      detail: clamp(detail, MAX_TEXT),
      ...(fix !== null ? { fix: clamp(fix, MAX_TEXT) } : {}),
    });
  }
  if (overCap > 0) errors.push(`dropped ${overCap} finding(s) over the ${MAX_FINDINGS} cap`);
  return { found: true, findings, errors };
}

/** One line for the run timeline and the CLI. */
export function findingsSummary(parsed: ParsedFindings): string {
  if (!parsed.found) return "the scan finished without emitting a findings array";
  if (parsed.findings.length === 0) return "the scan reported no findings";
  const counts: Record<FindingSeverity, number> = { high: 0, med: 0, low: 0 };
  for (const f of parsed.findings) counts[f.severity] += 1;
  const parts = (["high", "med", "low"] as const).filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `${parsed.findings.length} finding(s): ${parts.join(", ")}`;
}
