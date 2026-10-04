import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "./run-store.js";
import { conformanceChecks, effectivePermissions, hasExcess, validateManifest } from "./tool-manifest.js";
import type { AdminGrant, ConformanceFinding, Effect, ObservedCall, ToolManifest, ValidationResult } from "./tool-manifest.js";

/**
 * S24 wired OBSERVE-ONLY: the tool manifest contract next to Ship's real tool
 * path, enforcing nothing.
 *
 * Flag `SHIP_TOOL_MANIFEST=shadow|on` (default off). Off, `observeToolCall` is
 * one env read and a return: executeAction (agent.ts) behaves exactly as before.
 * Both settings only RECORD: `shadow` appends one JSON line per non-conforming
 * call to `tool-manifest-shadow.jsonl` in the state directory
 * (`SHIP_TOOL_MANIFEST_SHADOW_FILE` overrides); `on` additionally writes a one
 * line summary to stderr so an operator watching a run sees it. Neither ever
 * blocks, quarantines or alters a call. Enforcement stays with the credential
 * scope and the executor's own controls (egress allowlist, read-only mounts),
 * which is what manifest rule 3 says a declaration is not.
 *
 * WHICH MANIFEST. Ship has no installed-tool registry, so there is nothing to
 * look a manifest up in. The operator names one file, `SHIP_TOOL_MANIFEST_FILE`,
 * that declares Ship's own loop actions as tools (`bash`, `python`, `edit`,
 * `create`). No file means nothing is checked and nothing is recorded: an
 * "unknown-tool" finding for every call would be noise, not information. A file
 * that cannot be read or does not validate is recorded ONCE as an `error`
 * record, so "no findings" is never confused with "could not check".
 *
 * WHAT IS OBSERVABLE. The loop sees which action ran: bash/python are `exec`,
 * edit/create are `write`. It does not see the network hosts a command
 * contacted or the secret values the executor injected, so `hosts` and
 * `secretValues` are empty here and `undeclared-host`, `secret-in-argv` and
 * `secret-in-prompt` cannot fire from this path. Closing that needs the
 * executor/credential layer to report them; recorded as open in the report.
 */

export type ToolManifestMode = "off" | "shadow" | "on";

export function toolManifestMode(env: NodeJS.ProcessEnv = process.env): ToolManifestMode {
  const v = (env.SHIP_TOOL_MANIFEST ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

export function toolManifestShadowFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIP_TOOL_MANIFEST_SHADOW_FILE ?? join(stateDir(), "tool-manifest-shadow.jsonl");
}

export type ShadowRecord =
  | { at: string; kind: "finding"; tool: string; finding: ConformanceFinding }
  | { at: string; kind: "error"; error: string };

type Loaded = { manifest: ToolManifest } | { error: string };
const loaded = new Map<string, Loaded>();
const reportedErrors = new Set<string>();

function loadManifest(path: string): Loaded {
  const cached = loaded.get(path);
  if (cached !== undefined) return cached;
  let result: Loaded;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const v = validateManifest(parsed);
    result = v.ok ? { manifest: parsed as ToolManifest } : { error: `manifest ${path} is invalid: ${v.errors.join("; ")}` };
  } catch (error) {
    result = { error: `manifest ${path} unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  loaded.set(path, result);
  return result;
}

/** Test seam: forget cached manifests and reported errors. */
export function resetToolManifestShadow(): void {
  loaded.clear();
  reportedErrors.clear();
}

/** What the loop actually saw, as an ObservedCall. See the header for what is missing. */
export function observedFromAction(action: { kind: string; code?: string }): ObservedCall {
  const effects: Effect[] = action.kind === "bash" || action.kind === "python" ? ["exec"] : ["write"];
  return { tool: action.kind, effects, hosts: [], argv: typeof action.code === "string" ? [action.code] : [], secretValues: [] };
}

async function record(file: string, rec: ShadowRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(rec)}\n`, "utf8");
}

/**
 * Report a call that ALREADY happened. Never throws, never returns anything the
 * caller uses, never delays it (the write is not awaited). Returns the pending
 * writes only so a test can wait for them.
 */
export function observeToolCall(action: { kind: string; code?: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const mode = toolManifestMode(env);
  if (mode === "off") return Promise.resolve();
  try {
    const path = env.SHIP_TOOL_MANIFEST_FILE;
    if (path === undefined || path === "") return Promise.resolve();
    const file = toolManifestShadowFile(env);
    const at = new Date().toISOString();
    const m = loadManifest(path);
    const pending: Promise<void>[] = [];
    if ("error" in m) {
      // loadManifest caches, so this branch repeats; record only the first.
      if (!reportedErrors.has(path)) {
        reportedErrors.add(path);
        pending.push(record(file, { at, kind: "error", error: m.error }));
        if (mode === "on") process.stderr.write(`[tool-manifest] ${m.error}\n`);
      }
    } else {
      for (const finding of conformanceChecks(m.manifest, observedFromAction(action))) {
        pending.push(record(file, { at, kind: "finding", tool: action.kind, finding }));
        if (mode === "on") process.stderr.write(`[tool-manifest] ${finding.kind}: ${finding.detail}\n`);
      }
    }
    return Promise.all(pending.map((p) => p.catch(() => {}))).then(() => {});
  } catch {
    // The shadow must never fail the call it is watching.
    return Promise.resolve();
  }
}

export async function readShadowRecords(file: string): Promise<ShadowRecord[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as ShadowRecord);
}

// ------------------------------------------------------------ dry-run view

interface PermissionLists { effects: string[]; hosts: string[]; scopes: string[] }

export interface DryRunReport {
  validation: ValidationResult;
  /** Empty when the manifest did not validate: a malformed manifest gets nothing. */
  tools: { tool: string; granted: PermissionLists; excess: PermissionLists; hasExcess: boolean }[];
  grant: AdminGrant;
  /** Always true: this view persists nothing and grants nothing. */
  dryRun: true;
}

/** Parse an admin grant from `--grant`: inline JSON or a path to a JSON file. Absent grants nothing. */
export function parseGrant(value: string | undefined): AdminGrant {
  if (value === undefined) return { effects: [], hosts: [], scopes: [] };
  const text = value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8");
  const g = JSON.parse(text) as Record<string, unknown>;
  for (const k of Object.keys(g)) if (!["effects", "hosts", "scopes"].includes(k)) throw new Error(`grant: unknown field "${k}"`);
  const list = (k: string): string[] => {
    const v = g[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`grant.${k} must be an array of strings`);
    return v as string[];
  };
  return { effects: list("effects") as Effect[], hosts: list("hosts"), scopes: list("scopes") };
}

export function dryRunManifest(manifest: unknown, grant: AdminGrant): DryRunReport {
  const validation = validateManifest(manifest);
  const tools = validation.ok
    ? effectivePermissions(manifest as ToolManifest, grant).map((e) => ({ tool: e.tool, granted: e.granted, excess: e.excess, hasExcess: hasExcess(e) }))
    : [];
  return { validation, tools, grant, dryRun: true };
}

export function renderDryRun(report: DryRunReport): string {
  const out: string[] = [];
  const v = report.validation;
  out.push(v.ok ? "manifest: valid (a valid manifest is a claim; it grants nothing)" : "manifest: INVALID");
  for (const e of v.errors) out.push(`  error: ${e}`);
  for (const w of v.warnings) out.push(`  warning: ${w}`);
  if (v.ok) {
    const j = (a: string[]): string => (a.length === 0 ? "-" : a.join(","));
    for (const t of report.tools) {
      out.push(`tool ${t.tool}`);
      out.push(`  granted: effects ${j(t.granted.effects)}  hosts ${j(t.granted.hosts)}  scopes ${j(t.granted.scopes)}`);
      out.push(t.hasExcess
        ? `  requested but NOT granted: effects ${j(t.excess.effects)}  hosts ${j(t.excess.hosts)}  scopes ${j(t.excess.scopes)}`
        : "  requested nothing beyond the grant");
    }
  }
  out.push("dry run: nothing was installed, stored or enforced");
  return out.join("\n");
}
