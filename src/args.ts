/**
 * CLI argument parsing, separated from cli.ts so it's importable in tests.
 *
 * The original parser accepted anything: an unknown `--flag` was stored, a
 * value flag swallowed whatever came next INCLUDING the next flag, a missing
 * value became `""`, there was no `--`, no `--name=value`, and no per-command
 * notion of which flags are even valid. A typo therefore did not fail — it
 * changed behaviour silently, which for `--max-concurrent` or `--daily-budget`
 * means running with a limit nobody chose.
 */

export interface FlagSpec {
  /** Flags that take no value. */
  boolean?: readonly string[];
  /** Flags that take a value. */
  value?: readonly string[];
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export class ArgError extends Error {}

/** Flags every command accepts. */
const COMMON: FlagSpec = {
  boolean: ["json", "help"],
  value: ["store", "nucleus-url"],
};

/**
 * Per-command schemas. A command absent from this table accepts only COMMON,
 * which is the fail-closed default: a new command with no entry rejects the
 * flags it does not yet handle instead of ignoring them.
 */
export const COMMAND_FLAGS: Record<string, FlagSpec> = {
  run: {
    boolean: ["durable", "yes", "headless", "plan", "critic", "settle"],
    value: ["model", "sandbox", "sandbox-token", "sandbox-image", "sandbox-network", "max-steps"],
  },
  runs: {},
  resume: { value: ["model", "sandbox", "sandbox-token", "sandbox-image", "sandbox-network", "max-steps"] },
  approve: { boolean: ["handoff"], value: ["model", "sandbox", "sandbox-token", "sandbox-image", "sandbox-network"] },
  deny: { boolean: ["handoff"], value: ["model", "sandbox", "sandbox-token", "sandbox-image", "sandbox-network"] },
  cancel: {},
  inbox: {},
  fix: {
    boolean: ["yes", "headless", "critic", "settle", "tests", "preview", "telemetry"],
    value: [
      "repo",
      "git-token",
      "base",
      "model",
      "sandbox",
      "sandbox-token",
      "sandbox-image",
      "sandbox-network",
      "max-steps",
    ],
  },
  worker: {
    value: ["model", "interval", "max-concurrent", "daily-budget", "git-token", "sandbox", "sandbox-token", "sandbox-image", "sandbox-network"],
  },
  web: { boolean: ["dev"], value: ["port", "token", "model"] },
  eval: { boolean: ["critic", "settle"], value: ["model", "suite", "repeats"] },
};

function merge(spec: FlagSpec): { boolean: Set<string>; value: Set<string> } {
  return {
    boolean: new Set([...(COMMON.boolean ?? []), ...(spec.boolean ?? [])]),
    value: new Set([...(COMMON.value ?? []), ...(spec.value ?? [])]),
  };
}

function suggest(name: string, known: Iterable<string>): string {
  // Cheap edit-distance-ish nudge: a shared prefix is the common typo shape.
  const candidates = [...known].filter((k) => k.startsWith(name.slice(0, 3)) || name.startsWith(k.slice(0, 3)));
  return candidates.length > 0 ? ` Did you mean --${candidates[0]}?` : "";
}

/**
 * Parse against a command's schema.
 *
 * Without a schema (`parseArgs(argv)`), any flag is accepted — kept for
 * callers that only want the shape. Commands pass their spec so a typo is an
 * error rather than a silently different run.
 */
export function parseArgs(argv: string[], spec?: FlagSpec): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const known = spec !== undefined ? merge(spec) : null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    // Everything after `--` is positional, so a task that starts with a dash
    // (or contains one) can be passed at all.
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;

    if (name === "") throw new ArgError(`"--" alone separates flags from arguments; "${token}" is not a flag`);

    if (known !== null && !known.boolean.has(name) && !known.value.has(name)) {
      throw new ArgError(`unknown flag --${name}.${suggest(name, [...known.boolean, ...known.value])}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      throw new ArgError(`--${name} was given more than once`);
    }

    const isBoolean = known !== null ? known.boolean.has(name) : inlineValue === undefined && !looksLikeValueFlag(argv, i);
    if (isBoolean) {
      if (inlineValue !== undefined) throw new ArgError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      if (inlineValue === "") throw new ArgError(`--${name} needs a value`);
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    // A value flag must not swallow the next FLAG: `--model --json` used to
    // set model to "--json" and drop the json flag entirely.
    if (next === undefined || next.startsWith("--")) {
      throw new ArgError(`--${name} needs a value`);
    }
    flags[name] = next;
    i += 1;
  }

  return { positional, flags };
}

/** Heuristic for the schema-less path: treat a flag as valued if a non-flag follows. */
function looksLikeValueFlag(argv: string[], index: number): boolean {
  const next = argv[index + 1];
  return next !== undefined && !next.startsWith("--");
}

export interface NumberRange {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Parse a numeric flag within a range.
 *
 * The old helper checked only `Number.isFinite`, so zero and negatives reached
 * the scheduler interval (Node clamps a negative timer to ~immediate, which
 * hammers the store), the step budget, the concurrency ceiling, and the daily
 * budget. "It is a number" is not the constraint that matters.
 */
export function numberFlag(
  value: string | boolean | undefined,
  name: string,
  fallback: number,
  range: NumberRange = {},
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new ArgError(`--${name} needs a numeric value`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ArgError(`--${name} must be a number, got ${JSON.stringify(value)}`);
  if (range.integer === true && !Number.isInteger(n)) throw new ArgError(`--${name} must be a whole number, got ${n}`);
  if (range.min !== undefined && n < range.min) throw new ArgError(`--${name} must be at least ${range.min}, got ${n}`);
  if (range.max !== undefined && n > range.max) throw new ArgError(`--${name} must be at most ${range.max}, got ${n}`);
  return n;
}

/** Parse a flag constrained to a fixed set, instead of casting a string to a union. */
export function enumFlag<T extends string>(
  value: string | boolean | undefined,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new ArgError(`--${name} needs a value (${allowed.join(" | ")})`);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ArgError(`--${name} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}
