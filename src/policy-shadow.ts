import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { NETWORK_TIERS } from "./egress.js";
import type { NetworkTier } from "./egress.js";
import { AUTHORITIES } from "./ladder.js";
import type { Authority } from "./ladder.js";
import { AUTHORITY_ACTIONS } from "./governance.js";
import type { Governance } from "./governance.js";
import { explainRefusal, resolvePolicy, validateLayer } from "./policy-inheritance.js";
import type { EffectivePolicy, PolicyLayer, PolicyLimits, PolicyRequest } from "./policy-inheritance.js";
import { stateDir } from "./run-store.js";
import { setShadowObserver, suppressShadow } from "./shadow-hook.js";
import type { ShadowEvent, ShadowObserver, ShadowPrincipal, ShadowProjectLike } from "./shadow-hook.js";

/**
 * S25 in SHADOW mode: run `resolvePolicy` next to every gated decision, record
 * where it would have decided differently, and change nothing.
 *
 * Flag `SHIP_POLICY_SHADOW=on` (default off). Off installs no observer, so the
 * decision points behave and print exactly as before. On, each decision point
 * (shadow-hook.ts) reports its outcome AFTER deciding; this module builds the
 * layers, resolves the policy, and appends one JSON line per DISAGREEMENT to
 * `policy-shadow.jsonl` in the state directory (`SHIP_POLICY_SHADOW_FILE`
 * overrides). `teploy-ship policy shadow-report` summarises that file.
 *
 * WHAT THE LAYERS ARE. Derived from data Ship already has, additive only:
 *  - org: a fully OPEN ceiling (any model/tool, network open, no spend limit,
 *    top authority) plus the governance grants as the organisation's action
 *    rules. Ship has no mandatory organisation limit today, so inventing one
 *    would manufacture disagreements. The one exception is the explicit
 *    `SHIP_DAILY_BUDGET_USD`, which is an operator-declared deployment cap.
 *  - project: the project record (authority + ladder + neverAuto, network,
 *    egress allowlist, weekly budget) and the daily cap the existing code
 *    ACTUALLY applied (repo > source > default). A source-policy budget with no
 *    project record is loaded as a project-rank layer `project:source:<name>`.
 *  - user / service_account: the principal, with no limits of its own (silence
 *    in a human's layer means inherit).
 *  - declared (optional): `policy-layers.json` in the state directory
 *    (`SHIP_POLICY_LAYERS_FILE`). This is where an operator states the policy
 *    they WANT (an organisation budget, a revoked user, a network ceiling) so
 *    the shadow shows what adopting it would change. Declared layers are added
 *    to the derived ones; two layers of one level resolve to the stricter.
 *
 * Because derived layers mirror today's configuration, a deployment with no
 * declared layers records few disagreements by construction. The shadow earns
 * its keep once layers are declared, and on the dimensions Ship does not
 * enforce at all today (weekly budget, repo host versus egress).
 *
 * SERVICE ACCOUNTS. The role of a service account is NOT decided (product
 * confirmation owed, AUDIT_OPEN). The shadow therefore treats a service account
 * as an id-only match, as policy-inheritance does: a role grant never admits
 * it. Ship has no service-account principals yet; one appears only when a
 * caller sets `serviceAccount` or a declared `service_account:<id>` layer
 * names the principal, and every such record is tagged.
 *
 * WHAT IS NOT RECORDED. Agreements are not counted (volume), so the report
 * cannot give a disagreement RATE; it says so. A comparison the shadow could
 * not make (bad layers file, resolution failure) is recorded as an `error`
 * record, so "no disagreements" is never confused with "could not check".
 */

export type DisagreementKind = "existing-allows-policy-denies" | "policy-allows-existing-denies";

export type ShadowPoint = ShadowEvent["point"];

export interface ShadowRecord {
  v: 1;
  at: string;
  type: "disagreement" | "error";
  point: ShadowPoint;
  dimension: string;
  kind?: DisagreementKind;
  /** Who or what the decision was about (principal, repo, source). */
  subject: string;
  existing: string;
  policy: string;
  /** Layers that jointly set the policy limit. */
  layers: string[];
  rule?: string;
  /** True when the subject is a service account: matched by id only, role never consulted. */
  serviceAccount?: boolean;
  note?: string;
}

export interface ShadowSink {
  append(record: ShadowRecord): Promise<void>;
}

export const SHADOW_FLAG = "SHIP_POLICY_SHADOW";

export function shadowFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHADOW_FLAG]?.trim().toLowerCase() === "on";
}

export const shadowFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIP_POLICY_SHADOW_FILE ?? join(stateDir(), "policy-shadow.jsonl");
export const layersFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIP_POLICY_LAYERS_FILE ?? join(stateDir(), "policy-layers.json");

// ── layer loader ──────────────────────────────────────────────────────────

export interface LayerInput {
  governance?: Pick<Governance, "authority">;
  principal?: ShadowPrincipal | null;
  project?: ShadowProjectLike | null;
  /** Stand-in id when the daily cap came from a source policy and no project record exists. */
  sourceName?: string;
  /** The daily cap the existing code applied (repo > source > default). */
  dailyCapUSD?: number;
  declared?: readonly PolicyLayer[];
  env?: NodeJS.ProcessEnv;
}

const UNATTRIBUTED = "(shadow-unattributed)";

function deploymentBudget(env: NodeJS.ProcessEnv): number | "unlimited" {
  const raw = env.SHIP_DAILY_BUDGET_USD;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : "unlimited";
}

export function loadShadowLayers(input: LayerInput): { layers: PolicyLayer[]; problems: string[] } {
  const env = input.env ?? process.env;
  const problems: string[] = [];
  const org: PolicyLimits = {
    models: "*",
    tools: "*",
    network: "open",
    egressAllow: "*",
    dailyBudgetUSD: deploymentBudget(env),
    weeklyBudgetUSD: "unlimited",
    authority: "auto_normal",
    provisioning: "apply",
    workspace: "write",
  };
  if (input.governance !== undefined) {
    org.actions = Object.fromEntries(AUTHORITY_ACTIONS.map((a) => [a, input.governance!.authority[a]])) as PolicyLimits["actions"];
  }
  const layers: PolicyLayer[] = [{ kind: "org", id: "deployment", limits: org }];

  const projectId = input.project?.repo ?? (input.sourceName !== undefined ? `source:${input.sourceName}` : undefined);
  if (projectId !== undefined) {
    const p = input.project ?? {};
    const limits: PolicyLimits = {
      // Mirrors effectiveAuthority's own default: a record that declares nothing is `send`.
      authority: p.authority ?? "send",
      ...(p.neverAuto === true ? { neverAuto: true } : {}),
      ...(p.verification !== undefined ? { verification: p.verification } : {}),
      ...(p.sandboxNetwork !== undefined ? { network: p.sandboxNetwork } : {}),
      ...(p.sandboxEgressAllow !== undefined ? { egressAllow: p.sandboxEgressAllow } : {}),
      ...(input.dailyCapUSD !== undefined && input.dailyCapUSD > 0 ? { dailyBudgetUSD: input.dailyCapUSD } : {}),
      ...(p.weeklyBudgetUSD !== undefined ? { weeklyBudgetUSD: p.weeklyBudgetUSD } : {}),
    };
    layers.push({ kind: "project", id: projectId, limits });
  }

  const principal = input.principal ?? null;
  const principalId = principal?.user ?? UNATTRIBUTED;
  const declaredForPrincipal = (input.declared ?? []).find(
    (l) => (l.kind === "user" || l.kind === "service_account") && l.id === principalId,
  );
  const isSA = principal?.serviceAccount === true || declaredForPrincipal?.kind === "service_account";

  for (const l of input.declared ?? []) {
    const bad = validateLayer(l);
    if (bad.length > 0) {
      problems.push(`declared layer ${l.kind}:${l.id}: ${bad.join("; ")}`);
      continue;
    }
    if (l.kind === "org") layers.push(l);
    else if (l.kind === "project") {
      if (l.id === projectId) layers.push(l);
    } else if (l.id === principalId) layers.push(l);
  }
  if (declaredForPrincipal === undefined) {
    layers.push({ kind: isSA ? "service_account" : "user", id: principalId, limits: {} });
  }
  return { layers, problems };
}

/** Parse the optional declared-layers file. Missing file is not a problem; a malformed one is reported. */
export async function readDeclaredLayers(path: string): Promise<{ layers: PolicyLayer[]; problem?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { layers: [] };
    return { layers: [], problem: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    const arr = Array.isArray(raw) ? raw : (raw as { layers?: unknown })?.layers;
    if (!Array.isArray(arr)) return { layers: [], problem: `${path}: expected an array of layers or {"layers": [...]}` };
    const ok: PolicyLayer[] = [];
    for (const l of arr) {
      const o = l as Partial<PolicyLayer>;
      if (!["org", "project", "user", "service_account"].includes(String(o?.kind)) || typeof o?.id !== "string" || typeof o?.limits !== "object" || o.limits === null) {
        return { layers: [], problem: `${path}: every layer needs kind, id and limits` };
      }
      ok.push(o as PolicyLayer);
    }
    return { layers: ok };
  } catch (error) {
    return { layers: [], problem: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── comparison ────────────────────────────────────────────────────────────

const tierIndex = (t: NetworkTier): number => NETWORK_TIERS.indexOf(t);

interface Compared {
  dimension: string;
  existing: string;
  policy: string;
  layers: string[];
  rule?: string;
  kind: DisagreementKind;
  note?: string;
}

function byRequest(policy: EffectivePolicy, request: PolicyRequest, existingAllowed: boolean, dimension: string, existing: string): Compared | null {
  const refusal = explainRefusal(policy, request);
  const policyAllows = refusal === null;
  if (policyAllows === existingAllowed) return null;
  return {
    dimension,
    existing,
    policy: policyAllows ? "allow" : "deny",
    layers: refusal?.layers ?? [],
    ...(refusal !== null ? { rule: refusal.rule } : {}),
    kind: existingAllowed ? "existing-allows-policy-denies" : "policy-allows-existing-denies",
  };
}

export interface ShadowObserverOptions {
  sink: ShadowSink;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Declared layers; defaults to reading `layersFile(env)` on every decision. */
  declaredLayers?: () => Promise<{ layers: PolicyLayer[]; problem?: string }>;
  /** Test seam: the resolver under observation. Defaults to `resolvePolicy`; a buggy one proves the shadow notices. */
  resolve?: (layers: readonly PolicyLayer[], now: Date) => EffectivePolicy;
}

const inflight = new Set<Promise<void>>();

/** Resolves when every comparison started so far has been recorded (tests; the CLI exits without it, which is fine for a log). */
export async function flushShadow(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

/** Builds the observer. Exported so tests install it with a fake sink and fake layers. */
export function createShadowObserver(options: ShadowObserverOptions): ShadowObserver {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const readDeclared = options.declaredLayers ?? (() => readDeclaredLayers(layersFile(env)));
  const resolve = options.resolve ?? resolvePolicy;

  const emit = async (point: ShadowPoint, subject: string, serviceAccount: boolean, c: Compared | null): Promise<void> => {
    if (c === null) return;
    await options.sink.append({
      v: 1,
      at: now().toISOString(),
      type: "disagreement",
      point,
      dimension: c.dimension,
      kind: c.kind,
      subject,
      existing: c.existing,
      policy: c.policy,
      layers: c.layers,
      ...(c.rule !== undefined ? { rule: c.rule } : {}),
      ...(serviceAccount ? { serviceAccount: true } : {}),
      ...(c.note !== undefined ? { note: c.note } : {}),
    });
  };
  const fail = (point: ShadowPoint, subject: string, message: string): Promise<void> =>
    options.sink.append({ v: 1, at: now().toISOString(), type: "error", point, dimension: "-", subject, existing: "-", policy: "-", layers: [], note: message });

  const run: ShadowObserver = async (event) => {
    // The observer is suppressed (shadow-hook) while it runs; resolvePolicy calls effectiveAuthority.
    const declared = await readDeclared();
    const principalOf = (e: ShadowEvent): ShadowPrincipal | null => (e.point === "mayDo" ? (e.principal ?? null) : null);
    let subject = "";
    let sa = false;
    try {
      let project: ShadowProjectLike | null = null;
      let dailyCap: number | undefined;
      let sourceName: string | undefined;
      if (event.point === "authority") {
        project = event.project;
        sourceName = "(unnamed-project)"; // used only when the record carries no repo
      }
      if (event.point === "budget") {
        project = await event.loadProject().catch(() => null);
        dailyCap = event.budget;
        sourceName = event.source;
      }
      const principal = principalOf(event);
      if (event.point === "mayDo" && principal === null) return; // no principal: existing denies, nothing to resolve for
      subject =
        event.point === "mayDo" ? (principal?.user ?? "") :
        event.point === "repo" ? event.url :
        event.point === "budget" ? `${event.source}${event.repo !== undefined ? ` ${event.repo}` : ""}` :
        event.point === "authority" ? (event.project.repo ?? "(project)") : "(context-free)";

      const { layers, problems } = loadShadowLayers({
        env,
        ...(event.point === "mayDo" ? { governance: event.governance } : {}),
        principal,
        project,
        ...(sourceName !== undefined ? { sourceName } : {}),
        ...(dailyCap !== undefined ? { dailyCapUSD: dailyCap } : {}),
        declared: declared.layers,
      });
      if (declared.problem !== undefined) await fail(event.point, subject, `declared layers ignored: ${declared.problem}`);
      for (const p of problems) await fail(event.point, subject, `declared layer ignored: ${p}`);
      const policy = suppressShadow(() => resolve(layers, now()));
      sa = policy.principal?.kind === "service_account";

      const found: Array<Compared | null> = [];
      switch (event.point) {
        case "mayDo":
          found.push(
            byRequest(policy, { kind: "action", action: event.action, principal: { user: principal!.user, role: principal!.role } }, event.allowed, `actions.${event.action}`, event.allowed ? "allow" : "deny"),
          );
          break;
        case "authority": {
          const idx = (a: Authority | "none"): number => (a === "none" ? -1 : AUTHORITIES.indexOf(a));
          const have = idx(event.result);
          const want = idx(policy.authority);
          if (want !== have) {
            found.push({
              dimension: "authority",
              existing: event.result,
              policy: policy.authority,
              layers: policy.explanations.authority.decidedBy,
              kind: want < have ? "existing-allows-policy-denies" : "policy-allows-existing-denies",
              ...(policy.explanations.authority.note !== undefined ? { note: policy.explanations.authority.note } : {}),
            });
          }
          break;
        }
        case "network":
          // The tier is a CHOICE (flag > env > config), not a ceiling: only a tier above the policy is a disagreement.
          if (event.result !== null && tierIndex(event.result) > tierIndex(policy.network)) {
            found.push({
              dimension: "network",
              existing: event.result,
              policy: policy.network,
              layers: policy.explanations.network.decidedBy,
              kind: "existing-allows-policy-denies",
              note: "resolveNetworkTier has no project context: only organisation and declared org layers can apply",
            });
          }
          break;
        case "egress":
          for (const entry of event.result ?? []) {
            found.push(
              byRequest(policy, { kind: "egress", destination: entry }, true, "egressAllow", `allow ${entry}`),
            );
          }
          break;
        case "repo":
          // Proxy: a repository is cloned from INSIDE the sandbox, so its host must be reachable under the policy's egress rules.
          if (event.host !== null) {
            const c = byRequest(policy, { kind: "egress", destination: event.host }, event.allowed, "egressAllow", event.allowed ? `repo ${event.host} allowed` : `repo ${event.host} refused`);
            found.push(c === null ? null : { ...c, note: "proxy: repo allowlist versus the policy's egress rules for the clone host" });
          }
          break;
        case "budget": {
          const spent = event.committed === null ? 0 : Math.max(0, event.committed - event.estimate);
          const common = { spentUSD: spent, costUSD: event.estimate };
          found.push(byRequest(policy, { kind: "spend", scope: "daily", ...common }, event.existingAllowed, "dailyBudgetUSD", event.existingAllowed ? "allow" : "deny"));
          // Weekly spend is not enforced today and no weekly total is read: today's committed spend is a LOWER BOUND.
          const w = byRequest(policy, { kind: "spend", scope: "weekly", ...common }, true, "weeklyBudgetUSD", "not enforced");
          found.push(w === null ? null : { ...w, note: "weekly spend lower-bounded by today's committed spend" });
          break;
        }
      }
      for (const c of found) await emit(event.point, subject, sa, c);
    } catch (error) {
      await fail(event.point, subject, `shadow comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (event) => {
    const p = Promise.resolve(run(event));
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };
}

// ── sink and installation ─────────────────────────────────────────────────

export function fileSink(path: string): ShadowSink {
  return {
    async append(record) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`);
    },
  };
}

let installed = false;

/** Installs the file-backed shadow when `SHIP_POLICY_SHADOW=on`. Off: does nothing at all. Idempotent. */
export function installPolicyShadowFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!shadowFlagOn(env) || installed) return shadowFlagOn(env);
  installed = true;
  const inner = createShadowObserver({ sink: fileSink(shadowFile(env)), env });
  // A failure to WRITE the record must not surface anywhere; shadow-hook swallows it, this keeps one line for the operator.
  setShadowObserver(async (event) => {
    try {
      await inner(event);
    } catch (error) {
      process.stderr.write(`[ship] policy shadow: could not record (${error instanceof Error ? error.message : String(error)})\n`);
    }
  });
  return true;
}

/** Test seam: install an observer with an injected sink, or remove it. */
export function installPolicyShadow(options: ShadowObserverOptions | null): void {
  installed = options !== null;
  setShadowObserver(options === null ? null : createShadowObserver(options));
}

// ── report ────────────────────────────────────────────────────────────────

export interface ShadowGroup {
  point: ShadowPoint;
  dimension: string;
  kind: DisagreementKind;
  subject: string;
  count: number;
  first: string;
  last: string;
  existing: string;
  policy: string;
  layers: string[];
  rule?: string;
  serviceAccount: boolean;
}

export interface ShadowSummary {
  disagreements: number;
  errors: number;
  malformedLines: number;
  byKind: Record<DisagreementKind, number>;
  byDimension: Record<string, number>;
  groups: ShadowGroup[];
  errorSamples: string[];
  serviceAccountDisagreements: number;
  notes: string[];
  /** False when the record file does not exist: the shadow never ran (or flag off). Unknown, not zero. */
  fileFound: boolean;
}

export const REPORT_NOTES: readonly string[] = [
  "Service-account role is NOT decided (product confirmation owed). Service accounts are treated as id-only matches: a role grant never admits one. Records tagged [service-account] reflect that assumption, not a settled rule.",
  "Only disagreements and shadow errors are recorded. Agreeing decisions are not counted, so this report cannot give a disagreement rate; zero disagreements means none were seen, not that every decision was checked.",
  "Layers are derived from existing governance, project, egress and ladder data and mirror today's configuration; add declared layers (policy-layers.json) to see what a real organisation policy would change.",
  "Shadow only: nothing here changed an outcome. Decision points without project or principal context (network tier, egress allowlist) can only see organisation-level layers.",
];

export function parseShadowRecords(text: string): { records: ShadowRecord[]; malformed: number } {
  const records: ShadowRecord[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as ShadowRecord;
      if (r?.v === 1 && (r.type === "disagreement" || r.type === "error") && typeof r.point === "string") records.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export function summariseShadow(records: readonly ShadowRecord[], malformed = 0): ShadowSummary {
  const byKind: Record<DisagreementKind, number> = { "existing-allows-policy-denies": 0, "policy-allows-existing-denies": 0 };
  const byDimension: Record<string, number> = {};
  const groups = new Map<string, ShadowGroup>();
  const errorSamples: string[] = [];
  let errors = 0;
  let disagreements = 0;
  let sa = 0;
  for (const r of records) {
    if (r.type === "error") {
      errors++;
      if (r.note !== undefined && !errorSamples.includes(r.note) && errorSamples.length < 5) errorSamples.push(r.note);
      continue;
    }
    if (r.kind === undefined) continue;
    disagreements++;
    byKind[r.kind]++;
    byDimension[r.dimension] = (byDimension[r.dimension] ?? 0) + 1;
    if (r.serviceAccount === true) sa++;
    const key = [r.point, r.dimension, r.kind, r.subject, r.existing, r.policy].join("\u0000");
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        point: r.point,
        dimension: r.dimension,
        kind: r.kind,
        subject: r.subject,
        count: 1,
        first: r.at,
        last: r.at,
        existing: r.existing,
        policy: r.policy,
        layers: r.layers,
        ...(r.rule !== undefined ? { rule: r.rule } : {}),
        serviceAccount: r.serviceAccount === true,
      });
    } else {
      g.count++;
      if (r.at < g.first) g.first = r.at;
      if (r.at > g.last) g.last = r.at;
    }
  }
  return {
    disagreements,
    errors,
    malformedLines: malformed,
    byKind,
    byDimension,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.point.localeCompare(b.point)),
    errorSamples,
    serviceAccountDisagreements: sa,
    notes: [...REPORT_NOTES],
    fileFound: true,
  };
}

export function renderShadowReport(s: ShadowSummary, file: string): string {
  const out: string[] = [];
  out.push(`policy shadow report (${file})`);
  if (!s.fileFound) out.push(`no record file: the shadow has not recorded anything here (${SHADOW_FLAG} is off, or never ran). This is unknown, not zero disagreements.`);
  out.push(
    `${s.disagreements} disagreement(s): ${s.byKind["existing-allows-policy-denies"]} existing allows / policy denies, ` +
      `${s.byKind["policy-allows-existing-denies"]} policy allows / existing denies`,
  );
  if (s.errors > 0) out.push(`${s.errors} shadow error(s): comparisons that could not be made (unknown, NOT agreement)`);
  if (s.malformedLines > 0) out.push(`${s.malformedLines} unreadable line(s) skipped`);
  if (s.serviceAccountDisagreements > 0) out.push(`${s.serviceAccountDisagreements} involve a service account (id-only match assumed)`);
  const dims = Object.entries(s.byDimension).sort((a, b) => b[1] - a[1]);
  if (dims.length > 0) out.push(`by dimension: ${dims.map(([d, n]) => `${d}=${n}`).join(", ")}`);
  for (const g of s.groups) {
    out.push("");
    out.push(`${g.count}x ${g.kind}${g.serviceAccount ? " [service-account]" : ""}`);
    out.push(`  ${g.point} / ${g.dimension} / ${g.subject}: existing ${g.existing}, policy ${g.policy}`);
    if (g.layers.length > 0) out.push(`  decided by: ${g.layers.join(", ")}`);
    if (g.rule !== undefined) out.push(`  rule: ${g.rule}`);
    out.push(`  seen ${g.first} .. ${g.last}`);
  }
  for (const e of s.errorSamples) out.push(`error: ${e}`);
  out.push("");
  for (const n of s.notes) out.push(`note: ${n}`);
  return out.join("\n");
}

export async function readShadowSummary(path: string): Promise<ShadowSummary> {
  let text = "";
  let fileFound = true;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fileFound = false;
  }
  const { records, malformed } = parseShadowRecords(text);
  return { ...summariseShadow(records, malformed), fileFound };
}
