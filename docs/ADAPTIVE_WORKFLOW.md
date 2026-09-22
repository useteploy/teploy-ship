# One task, proportionate workflow

Ship keeps one project and conversation across questions, plans, changes and
reviews. These are explicit intentions with different authority, not separate
products. The interface can emphasize the relevant result without silently
changing what the user authorized. Preserve the shared Teploy navigation,
typography, palette and compact controls.

## Planning and checkpoints are different

Every change needs an understood outcome, scope, approach and verification.
For a clear wording correction this can be a brief explanation. A migration
needs dependencies, compatibility, recovery and more detailed acceptance checks.
Small wording or a small diff does not establish low risk: one changed price,
permission check, shared style or database default can have broad consequences.

A human plan checkpoint answers whether the proposed approach is acceptable.
It is distinct from clarification, authorization to execute, review of the
actual diff, merge approval and production deployment. Passing one must not
silently satisfy another. Existing project permissions and evidence rules
continue to apply when a separate plan checkpoint is not requested.

Project settings include **Require plan approval before code changes**. It
applies to new change runs from all enqueue surfaces, including follow-ups and
automations. A per-run false cannot override it. The native harness is currently
required; unsupported harnesses are refused rather than silently bypassing the
checkpoint. An explicit read-only question, plan or review does not enter an
implementation checkpoint. Existing runs retain their recorded workflow inputs.
Changing this setting does not retroactively reauthorize or rewrite them.

This checkpoint is the existing native plan stage. It does not imply that no
sandbox setup command ran before the plan, nor that the generated plan was
independently verified. Code-grounded plan quality remains an evaluation target.
The new change-journey instructions ask for a concise approach before editing;
those instructions are guidance, not an executor security boundary.

## Adaptation rules

| Situation | Expected behavior |
|---|---|
| Clear bounded change on a prepared project | Inspect context, explain a proportionate approach, execute within granted scope, verify and present the result under existing delivery policy. |
| Ambiguous requirement with materially different outcomes | Investigate what the code can answer; ask the requester about the unresolved choice. Do not silently choose a larger scope. |
| Read-only question or plan | Return the requested evidence or plan. Implementation requires an explicitly authorized follow-up. |
| Required plan review | Present the plan and wait at the existing approval checkpoint, regardless of apparent simplicity. |
| New sensitive area or expanded scope discovered | Explain the change in scope and obtain the necessary decision before proceeding beyond authority. Prompt guidance alone is not proof this is enforced. |
| Failed or missing checks | Preserve failed/not-run/unknown status; do not relabel completion as verified success. |
| Lost connection or interrupted run | Reconcile durable state before retrying effects; distinguish reconnecting from failed execution. |
| Merge or deployment requested | Validate that operation's permissions, target and current revision separately. |

The first implementation does not introduce a model-controlled “simple task”
bypass or automatically remove any checkpoint. A future adaptive policy must
record its version, reasons, supported executor and decision at acceptance.
It may recommend more review; it cannot grant itself more authority. Users must
be able to request a plan and inspect why work is waiting.

## Quality risks to test

- **Misclassification:** short prompts, cosmetic labels and few changed lines
  must not weaken policy. Sensitive-path rules are useful signals, not proof
  that everything else is safe.
- **Approval fatigue:** prompts should name a concrete decision and its effects.
  Avoid asking the same question twice, but keep distinct authorities separate.
- **Plan drift:** record accepted requirements and invalidate affected approvals
  when scope, revision or target changes. An old plan is not blanket consent.
- **Harness differences:** unsupported pause/plan/steer capabilities need explicit
  refusal or a separately authorized alternative; never pretend parity.
- **UI/backend divergence:** hidden options and disabled buttons do not enforce
  policy. CLI, automation, API and follow-up paths use the same admission floor.
- **Replay compatibility:** materialize new behavior at enqueue and preserve old
  histories; do not infer workflow steps from mutable policy during replay.
- **Context contamination:** inherited conversation and repository instructions
  are evidence, not new authority. Preserve origin, revision and access scope.
- **Unnecessary work:** success includes scope compliance, not just passing tests.
  A wording change must not become a broad redesign or dependency upgrade.
- **False reassurance:** generated plans, checklists, screenshots and model
  critique are not independent correctness evidence.
- **Requester burden:** advanced tooling stays available without becoming a
  prerequisite for asking a question, viewing a preview or requesting revision.

## Rollout and evidence

Keep existing defaults. Validate the policy floor with bypass attempts,
unsupported executors, non-change intentions, settings round trips and old-run
compatibility. Then evaluate ordinary and misleadingly small tasks on the real
product path, measuring scope compliance, user interventions, time, cost and
verification accuracy. Compare against Ship's recorded baseline before changing
any automatic default. Roll out changes separately from storage migrations.

The wider adaptive task lifecycle, independent evidence and human-usability
programme remain open. This document and unit tests do not certify the complete
product or comparative superiority.
