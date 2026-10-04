/**
 * S15 part: migration-aware recovery check. PURE and UNWIRED.
 *
 * WHY. delivery.ts rolls an ARTIFACT back to the retained version and reads
 * the target back. That proves the old code is serving; it says nothing about
 * whether the old code can still work against the database the newer release
 * has already migrated. Rolling back across a dropped column turns an
 * incident into a data incident, and the read-back still says "retained
 * version serving". Artifact rollback and data recovery are separate questions
 * (S15), so this module answers only the second one and never claims the first.
 *
 * THE RULE. Compatible only when we KNOW both sides: the migrations the
 * retained release understands, and the migrations actually applied to the
 * target. Anything unread, unclassified or unrecorded is `hold` — unknown is
 * never compatible. A migration the retained release does not know about is
 * safe only when it is classified additive ("expand"); a "contract" or
 * "irreversible" one makes the rollback `incompatible` unless the operator has
 * recorded a specific recovery plan, and even then the verdict stays blocked:
 * a plan is a precondition to a human decision, not a pass.
 *
 * This module decides nothing about authority and executes nothing. Callers
 * (a future delivery gate, behind a flag, default off) feed it observations.
 */

export type MigrationClass = "expand" | "contract" | "irreversible" | "unknown";

export interface AppliedMigration {
  id: string;
  /** How the migration was classified when authored. Missing = unknown, not expand. */
  class?: MigrationClass;
}

export type RecoveryStrategy = "backup-restore" | "forward-fix" | "expand-contract";

export interface RecoveryPlan {
  strategy: RecoveryStrategy;
  /** Where the plan lives (runbook, ticket, backup id). A plan with no reference is not specific. */
  reference: string;
}

export interface RecoveryCompatInput {
  /** The retained release rollback would restore. Empty = nothing to check against. */
  retainedRevision: string;
  /** Migration ids the retained release ships/understands. undefined = not read. */
  retainedKnownMigrations?: readonly string[];
  /** Migrations applied to the target database, in order. undefined = not read. */
  appliedMigrations?: readonly AppliedMigration[];
  /** Operator-recorded plan for data that artifact rollback cannot restore. */
  recoveryPlan?: RecoveryPlan;
}

export type RecoveryCompatVerdict = "compatible" | "incompatible" | "hold";

export interface RecoveryCompatResult {
  verdict: RecoveryCompatVerdict;
  /** One sentence for the operator. */
  reason: string;
  /** Applied migrations the retained release does not know. */
  newerMigrations: string[];
  /** The subset that blocks rollback (contract/irreversible). */
  blocking: string[];
  /** The subset whose class is missing or unrecognised. */
  unclassified: string[];
  /** What is not known, for `hold`. */
  unknowns: string[];
  /** Only meaningful when blocking is non-empty. */
  recoveryPlan: "present" | "missing" | "not-needed";
  /** Always false: this check never proves the artifact rollback itself. */
  provesArtifactRollback: false;
}

const CLASSES: ReadonlySet<string> = new Set(["expand", "contract", "irreversible"]);

function result(
  verdict: RecoveryCompatVerdict,
  reason: string,
  parts: Partial<Omit<RecoveryCompatResult, "verdict" | "reason" | "provesArtifactRollback">> = {},
): RecoveryCompatResult {
  return {
    verdict,
    reason,
    newerMigrations: [],
    blocking: [],
    unclassified: [],
    unknowns: [],
    recoveryPlan: "not-needed",
    ...parts,
    provesArtifactRollback: false,
  };
}

export function planIsSpecific(plan: RecoveryPlan | undefined): boolean {
  if (plan === undefined) return false;
  const ok: RecoveryStrategy[] = ["backup-restore", "forward-fix", "expand-contract"];
  return ok.includes(plan.strategy) && typeof plan.reference === "string" && plan.reference.trim() !== "";
}

export function checkRecoveryCompat(input: RecoveryCompatInput): RecoveryCompatResult {
  const unknowns: string[] = [];
  if (input.retainedRevision.trim() === "") unknowns.push("no retained revision recorded");
  if (input.retainedKnownMigrations === undefined) unknowns.push("the migrations the retained release understands were not read");
  if (input.appliedMigrations === undefined) unknowns.push("the migrations applied to the target were not read");
  if (unknowns.length > 0) {
    return result("hold", `held: ${unknowns.join("; ")} — unknown is not compatible`, { unknowns });
  }

  const known = new Set(input.retainedKnownMigrations);
  const applied = input.appliedMigrations ?? [];
  const seen = new Set<string>();
  const newer: AppliedMigration[] = [];
  for (const m of applied) {
    if (seen.has(m.id)) continue; // a repeated id is one migration
    seen.add(m.id);
    if (!known.has(m.id)) newer.push(m);
  }
  const newerMigrations = newer.map((m) => m.id);
  const unclassified = newer.filter((m) => m.class === undefined || !CLASSES.has(m.class)).map((m) => m.id);
  const blocking = newer.filter((m) => m.class === "contract" || m.class === "irreversible").map((m) => m.id);

  // Blocking beats unclassified: a known-destructive migration is a definite
  // answer, and holding would hide it behind "unknown".
  if (blocking.length > 0) {
    const plan = planIsSpecific(input.recoveryPlan) ? "present" : "missing";
    return result(
      "incompatible",
      `rollback to ${input.retainedRevision} crosses ${blocking.length} contract/irreversible migration(s) it does not know (${blocking.join(", ")}); ` +
        (plan === "present"
          ? `a ${input.recoveryPlan?.strategy} plan is recorded (${input.recoveryPlan?.reference}) but a plan is a precondition for a human decision, not a pass`
          : "no specific recovery plan is recorded"),
      { newerMigrations, blocking, unclassified, recoveryPlan: plan },
    );
  }
  if (unclassified.length > 0) {
    return result(
      "hold",
      `held: ${unclassified.length} migration(s) newer than ${input.retainedRevision} have no recognised class (${unclassified.join(", ")}) — unclassified is not additive`,
      { newerMigrations, unclassified, unknowns: unclassified.map((id) => `class of migration ${id}`) },
    );
  }
  if (newerMigrations.length === 0) {
    return result("compatible", `no applied migration is newer than ${input.retainedRevision}; data compatibility holds (artifact rollback is separately unproven)`);
  }
  return result(
    "compatible",
    `${newerMigrations.length} newer migration(s) are all additive (expand); ${input.retainedRevision} can run against them (artifact rollback is separately unproven)`,
    { newerMigrations },
  );
}
