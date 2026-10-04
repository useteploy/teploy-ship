import { createHash } from "node:crypto";

import { HARNESS_PACKAGES } from "./harness.js";
import type { HarnessRef } from "./harness.js";
import { externalHarnessConfig } from "./harness-external.js";

/**
 * Which model, harness, harness revision and configuration wrote a run (S13).
 *
 * Today the run input says `harness: {id, version}` where `version` is the
 * ADAPTER contract version ("1"), not the vendor binary, and nothing says what
 * configuration the harness ran under. Two runs that differ only in
 * SHIP_HARNESS_MODEL or the forwarded credential names look identical in the
 * log. This records the missing identity.
 *
 * Where it lives: a SIBLING of `input` on the run-started event, next to
 * `stepFingerprint` (step-fingerprint.ts), never a field inside `input`. The
 * recorded input is what gates step presence and what the fingerprint hashes;
 * a key added there would be a stored-shape change. The engine reads `workflow`
 * and `input` only, so a sibling key is inert to replay.
 *
 * Off by default (SHIP_HARNESS_RECORD=on): off writes nothing, so the event is
 * byte-identical to one written before this existed.
 *
 * What is NOT recorded here: the binary revision the sandbox ACTUALLY ran. That
 * is only knowable inside the sandbox, and the `harness-preflight` step already
 * records it (version, expected, pinned). The page reads it from there; this
 * record carries the revision Ship EXPECTED to run, so the two can be compared.
 * Credential VALUES are never recorded, only the names that were configured.
 */

export const HARNESS_RECORD_FLAG = "SHIP_HARNESS_RECORD";

/** On only for an explicit "on" (or 1/true). Anything else, including unset, is off. */
export function harnessRecordEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true)$/i.test((env[HARNESS_RECORD_FLAG] ?? "").trim());
}

export interface HarnessIdentity {
  v: 1;
  harness: { id: string; adapterVersion: string };
  /** Ship's own model (native loop) and the model passed to the harness, if any. */
  model: { ship: string; harness: string | null };
  /** The vendor package Ship expected the image to carry; null for native. */
  expectedRevision: { npm: string; version: string } | null;
  /** The configuration the harness runs under: names and numbers, never secret values. */
  configuration: { timeoutMs: number | null; claudeBare: boolean | null; forwardedEnvNames: string[]; digest: string };
  /** Other harnesses a multi-attempt run may execute under. */
  attempts?: { id: string; adapterVersion: string }[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function harnessIdentity(opts: {
  harness: HarnessRef;
  attempts?: readonly HarnessRef[];
  shipModel: string;
  env?: NodeJS.ProcessEnv;
}): HarnessIdentity {
  const env = opts.env ?? process.env;
  const pkg = HARNESS_PACKAGES[opts.harness.id];
  const external = pkg !== undefined;
  const config = external ? externalHarnessConfig(opts.harness.id, env) : undefined;
  const fields = {
    timeoutMs: config?.timeoutMs ?? null,
    claudeBare: config?.claudeBare ?? null,
    forwardedEnvNames: config?.forward ?? [],
  };
  return {
    v: 1,
    harness: { id: opts.harness.id, adapterVersion: opts.harness.version },
    model: { ship: opts.shipModel, harness: config?.model ?? null },
    expectedRevision: external ? { npm: pkg.npm, version: pkg.version } : null,
    configuration: { ...fields, digest: digest({ id: opts.harness.id, model: config?.model ?? null, ...fields }) },
    ...((opts.attempts?.length ?? 0) >= 2 ? { attempts: opts.attempts!.map((a) => ({ id: a.id, adapterVersion: a.version })) } : {}),
  };
}
