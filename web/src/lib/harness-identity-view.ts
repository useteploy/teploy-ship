/**
 * The run page's "who ran this" block (S13). A read-time projection of the
 * `harnessIdentity` sibling the run-started event carries when the run was
 * enqueued with SHIP_HARNESS_RECORD=on, joined with what the sandbox reported
 * for the binary it actually ran (the `harness-preflight` step, recorded with
 * or without the flag). A run made without the flag has no identity and
 * projects to undefined, so its page is unchanged.
 *
 * Shape-checked field by field: this is JSON out of an event log, and a log
 * written by another build is a normal thing to be reading. Display only.
 */
export interface IdentityLogEvent {
  type: string;
  name?: string;
  data?: unknown;
}

export interface HarnessIdentityView {
  /** Label/value pairs, in display order. */
  rows: Array<{ label: string; value: string }>;
  /** True when the binary the sandbox reported differs from the one Ship expected. */
  revisionMismatch: boolean;
}

const str = (v: unknown, max = 120): string | undefined => (typeof v === "string" && v !== "" ? v.slice(0, max) : undefined);

export function harnessIdentityView(events: readonly IdentityLogEvent[]): HarnessIdentityView | undefined {
  const started = events.find((e) => e.type === "run-started");
  const id = (started?.data as { harnessIdentity?: Record<string, unknown> } | undefined)?.harnessIdentity;
  if (id === null || typeof id !== "object" || Array.isArray(id)) return undefined;
  const harness = (id.harness ?? {}) as Record<string, unknown>;
  const model = (id.model ?? {}) as Record<string, unknown>;
  const expected = (id.expectedRevision ?? null) as Record<string, unknown> | null;
  const config = (id.configuration ?? {}) as Record<string, unknown>;
  const harnessId = str(harness.id);
  if (harnessId === undefined) return undefined;

  const rows: HarnessIdentityView["rows"] = [{ label: "Harness", value: `${harnessId} (adapter v${str(harness.adapterVersion, 20) ?? "?"})` }];
  const shipModel = str(model.ship);
  const harnessModel = str(model.harness);
  rows.push({ label: "Model", value: harnessId === "native" ? (shipModel ?? "unknown") : (harnessModel ?? "the harness's own default") });

  // Preflight results, one per attempt (steps are `harness-preflight` or `attempt-N-harness-preflight`).
  const preflights = events
    .filter((e) => e.type === "step-completed" && typeof e.name === "string" && /(^|-)harness-preflight$/.test(e.name))
    .map((e) => (e.data as { result?: Record<string, unknown> } | undefined)?.result)
    .filter((r): r is Record<string, unknown> => r !== undefined && r !== null && typeof r === "object");
  let revisionMismatch = false;
  if (expected !== null) {
    const want = str(expected.version, 40);
    rows.push({ label: "Expected revision", value: `${str(expected.npm, 60) ?? harnessId}@${want ?? "?"}` });
    for (const p of preflights) {
      if (p.found !== true) {
        rows.push({ label: "Observed revision", value: "binary not found in the sandbox" });
        continue;
      }
      const seen = str(p.version, 60) ?? "unreported";
      const bad = want !== undefined && !seen.includes(want);
      if (bad) revisionMismatch = true;
      rows.push({ label: "Observed revision", value: bad ? `${seen} (differs from expected)` : seen });
    }
    if (preflights.length === 0) rows.push({ label: "Observed revision", value: "not observed (no preflight recorded)" });
  }

  const digest = str(config.digest, 32);
  if (digest !== undefined) {
    const names = Array.isArray(config.forwardedEnvNames) ? config.forwardedEnvNames.filter((n): n is string => typeof n === "string").slice(0, 12) : [];
    const parts = [`config ${digest}`];
    if (typeof config.timeoutMs === "number") parts.push(`timeout ${Math.round(config.timeoutMs / 60_000)} min`);
    if (config.claudeBare === true) parts.push("bare");
    if (names.length > 0) parts.push(`forwards ${names.join(", ")}`);
    rows.push({ label: "Configuration", value: parts.join(" · ") });
  }
  return { rows, revisionMismatch };
}
