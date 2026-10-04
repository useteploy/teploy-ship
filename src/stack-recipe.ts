import { canonicalRecipe, validateRecipe } from "./environment-recipe.js";
import type { EnvironmentRecipe, RecipeService } from "./environment-recipe.js";
import type { DetectedService, Proposal, StackDetection } from "./stack-detect.js";

/**
 * Adapter from stack-detect proposals (S05) to an EnvironmentRecipe (S06).
 *
 * PURE, and a PROPOSAL: the result is something a person may read and accept,
 * never something Ship applies or runs. Three rules shape the mapping:
 *  - Only a command the detector justified (cited, no conflict) becomes a phase
 *    command. A missing preparation means NO recipe, not a recipe with a
 *    guessed install step.
 *  - A `start` proposal is a long-running server (the detector's validation
 *    plan judges it `alive-at-timeout`), but a recipe's startup phase is an
 *    exit-0 command. Mapping one onto the other would hang the lifecycle, so
 *    the start proposal is reported in `gaps` instead and startup is a no-op.
 *  - Everything repo-authored is `untrusted-repo`. Even `npm install` runs
 *    lifecycle scripts; "privileged" stays reserved for image preparation by a
 *    human, which detection never proposes.
 * Every no-op, reuse and skipped item is listed in `gaps` so nothing here
 * reads as more evidence than the repository gave.
 */
export interface RecipeProposal {
  /** null when the detector did not justify a preparation command. */
  recipe: EnvironmentRecipe | null;
  /** validateRecipe() over the built recipe; non-empty means do not offer it. */
  issues: string[];
  /** What the recipe does NOT cover, or fills with a no-op, and why. */
  gaps: string[];
  /** Commands that run repo-authored text flagged by the detector (field + reasons). */
  needsReview: { field: string; command: string; flags: string[] }[];
  /** Canonical JSON of `recipe`, the exact text the digest covers. */
  canonical: string | null;
}

export const RECIPE_VERSION = "detected-1";
const NOOP = "true";
const NOOP_TIMEOUT_MS = 10_000;
/** Same shape as the tcp health check the recipe tests use: ~22 s budget, well under the 120 s cap. */
const HEALTH = { kind: "tcp", target: "", timeoutMs: 2000, retries: 10 } as const;

function serviceFor(s: DetectedService, gaps: string[]): RecipeService | null {
  if (!s.declared) { gaps.push(`service ${s.name} (${s.kind}) is only hinted at (${s.source.file}); not declared, so not started`); return null; }
  if (!s.image) { gaps.push(`service ${s.name} is built locally with no image; the recipe cannot start it`); return null; }
  return { name: s.name, image: s.image, healthCheck: { ...HEALTH }, port: { kind: "discover" } };
}

export function recipeFromDetection(d: StackDetection, lockfilePaths: readonly string[] = []): RecipeProposal {
  const gaps: string[] = [];
  const needsReview: RecipeProposal["needsReview"] = [];
  const prep: Proposal | undefined = d.proposals.preparation;
  const test: Proposal | undefined = d.proposals.test;
  for (const c of d.conflicts) gaps.push(`${c.field}: conflict (${c.reason}); nothing chosen`);
  for (const u of d.unknown) gaps.push(`${u.field}: unknown (${u.reason})`);
  if (!prep) {
    gaps.push("no justified preparation command; no recipe proposed");
    return { recipe: null, issues: [], gaps, needsReview, canonical: null };
  }
  for (const p of [prep, test, d.proposals.start]) if (p?.safety === "review") needsReview.push({ field: p.field, command: p.command, flags: p.flags });
  gaps.push("refresh reuses the preparation command; the repository gives no evidence of a cheaper refresh");
  if (d.proposals.start) gaps.push(`start proposal not mapped (a server never exits, the startup phase must): ${JSON.stringify(d.proposals.start.command)}`);
  gaps.push("startup and teardown are no-ops; services are stopped by the lifecycle itself");
  const services = d.services.map((s) => serviceFor(s, gaps)).filter((s): s is RecipeService => s !== null);
  const recipe: EnvironmentRecipe = {
    version: RECIPE_VERSION,
    phases: {
      initialise: { command: prep.command, timeoutMs: prep.timeoutMs, trust: "untrusted-repo" },
      refresh: { command: prep.command, timeoutMs: prep.timeoutMs, trust: "untrusted-repo" },
      startup: { command: NOOP, timeoutMs: NOOP_TIMEOUT_MS, trust: "untrusted-repo" },
      teardown: { command: NOOP, timeoutMs: NOOP_TIMEOUT_MS, trust: "untrusted-repo" },
    },
    ...(test ? { test: { command: test.command, timeoutMs: test.timeoutMs } } : {}),
    services,
    cachePolicy: { keys: [...lockfilePaths].sort(), scope: "project-only" },
    secrets: { names: [], scope: {} },
  };
  return { recipe, issues: validateRecipe(recipe), gaps, needsReview, canonical: canonicalRecipe(recipe) };
}
