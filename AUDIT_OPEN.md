# Open audit items

## Akiroo remediation — 2026-09-12

The [delivery contract](docs/AKIROO_DELIVERY.md) records the paired receiver/sender
change and recovery limits. Failed actions now retain explicit receipts instead
of being treated as success; notification sends use the durable outbox, retries
retain owed events, and chronology is carried on the wire. First project sync
protects existing settings; allowlist checks precede storage; managed test
commands update/clear their legacy alias too. No workflow steps changed.

`e7f889a` is committed, pushed and deployed on both Ship processes, after
Akiroo's receiver upgrade (`5038c7f`, then compatibility follow-up `88ab576`).
Verified lint/build, 1,137 main + 40 script tests, 67 web tests/build, and the
isolated Nucleus receipt probe. Live preflight reports one waiting run, zero
incompatible/unrecorded runs; deployed worker/outbox/connector hashes match the
tested build, login is reachable and collection resumed. No run was approved.
A coordinated Nucleus snapshot (LSN 1650451) is retained privately and restored
successfully into a disposable container. This is not the full end-to-end proof.

SKIPPED (separate design/operational proof): automatic reconciliation of unknown
forge/run outcomes; crash recovery before a notification intent is enqueued;
one-shot project/revert notifier recovery; commit-bound verification and
independent forge merge synchronization; warm-volume approval restoration;
settled multi-attempt cost propagation (upstream event support); historical
repair; retention/capacity policy for durable receipts and overdue retries.
Acceptance: fault-inject each boundary, restart the actual worker,
prove one approved standalone and milestone loop, and reconcile the same tested,
merged and deployed revision without duplicate external effects. These are not
cosmetic tasks to delegate without the integration context.

SKIPPED (upstream): Nucleus v1.0.2 arm64 image still fails at startup with a
GLIBC_2.38 mismatch. The matching production amd64 image passed the isolated
receipt probe. Reported in the private upstream register; no vendor patch or
upstream release was made.

Unresolved findings for this repository from the ChatGPT-led audit series (2026-09-09 through 2026-09-11, passes 1-5; register: teploy-neutron-lullmail expanded audit). Every P0/P1 finding has been fixed and verified; the items below are the remaining P2/P3 tail plus one item needing validation. Fields are quoted from the audit register; line references point at the review commits listed per item where recorded.

Open items: 1 P2 improvement (1 total)

## useteploy__teploy-ship-04 - P2 - Open improvement

**Treat command regexes as advisory classification, not an enforcement boundary**

- Kind: Improvement
- Evidence: defaultApprovalPolicy and sandboxApprovalPolicy classify raw Bash/Python source with lists of regular expressions. Equivalent operations expressed through other commands, APIs, indirection, or argument forms are not necessarily recognized.
- Impact: A textual classifier cannot guarantee that every destructive or durable external action receives approval. This matters most for the trusted-local executor; it is not evidence of an escape from the separate sandbox implementation.
- Proposed fix: Keep mandatory filesystem/network/credential restrictions in the executor boundary and use explicit capability-scoped tools for durable external actions. Document the limits of heuristic classification and expand tests with semantically equivalent benign command forms.
- Acceptance test: Build a policy test corpus for equivalent argument spellings and API-based operations; verify enforcement through the executor does not depend solely on matching a particular source-code string.
- Review commit: `daa8a63ba808c7d1adb218a679e38d76fccac378` (last reviewed 2026-09-10)


## Resolution log (2026-09-12)

- teploy-ship-01, -02, -06, -07: FIXED - see audit commits (safe-csv is opt-in via --safe-csv; raw output unchanged).
- teploy-ship-05: PARTIALLY FIXED - the export now prefers a settled costUSD recorded at completion and labels recomputed rows costEstimated. UPSTREAM HANDOFF: writing the settled cost onto the run-completed event belongs to the vendored @neutron-build/agents run loop - report upstream (Neutron), then this export picks it up with no further change.
- teploy-ship-04: DEFERRED (design) - moving from heuristic command classification to capability-scoped executor boundaries is an architecture project; until then the regexes stay advisory (documented).

## 2026-09-19 — dashboard usability pass

- Fixed Settings' Team/System switcher rendering identical content. Settings
  now has overview, execution, connections, team, and advanced views; deployment
  values are explicitly read-only, secrets stay masked, and editable project,
  approval, and account controls are linked from the overview.
- Reworked the shared shell, typography, spacing, accessible navigation, form
  controls, and mobile layouts. Tables scroll inside their own containers.
- Added a multiline task composer with configured-repository suggestions,
  server-rendered run search combined with status filters, readable run dates,
  and task-first run headings. Project options are grouped under execution,
  verification, and automation disclosures. No worker steps or policy changed.
- Validation: lint, 1,151 runtime + 40 script tests, 76 web tests, web typecheck
  and production build. Isolated Chromium checks cover settings separation,
  team creation, search/filter/clear, task submission, and desktop/tablet/mobile
  layouts. Production preflight before rollout: five waiting runs, all safe,
  no executing runs and no incompatible or unrecorded workflow fingerprints.

### Visual correction — preserve the Teploy identity

Restored the original top navigation, monospace typography, palette, title
sizes and controls after user feedback. Settings navigation uses horizontal
pills; counts and overview links are compact. The functional settings split,
search, multiline composer and clearer project forms remain.

## 2026-09-19 — task workspace and team workflows

Added run conversation/changes/verification/activity views, governed linked
follow-ups, shared workflow templates, guided project registration and
configuration checks, and bounded service diagnostics. Published runs retain
a diff snapshot; browser-flow recordings have bounded attachment support.
Existing workflow step sequences are unchanged. Settings no longer evaluates
worker-only environment metadata in the browser. The shared Teploy shell and
visual tokens are preserved. Scope and remaining competitor distinctions:
[Working in Ship](docs/WORKSPACE.md).

## 2026-09-19 — environment and review integration

Added recorded project preparation, real environment verification, worker-side
PR/CI/review reads, fresh-PR validation for follow-ups, bounded conversation
lineage, tracked-file inspection, interval workflow schedules through existing
intake policies, and authenticated content-addressed PNG/WebM artifacts.
Run pages now update in place, preserve drafts, render formatted conversation,
and support a side-by-side review while retaining the Teploy shell.

New workflow steps are gated only on recorded preparation/environment-check
inputs; preflight reports all five existing waiting runs compatible. Live
Nucleus testing established its inline-row size constraint: artifacts use 8 KiB
base64 chunks with manifest-last writes and integrity checks. Workspace replies
are bounded to fit the same store. The Neutron dev returned-Response defect is
reported upstream; resource loaders throw Responses as a compatibility path.

Remaining distinct work: writable IDE/terminal/browser takeover, sandbox
continuation across terminal runs, arbitrary-stack auto-provisioning, wider
connector coverage and measured competitor coding-quality comparisons. This
change adds interval schedules and forge reads, not automatic merge
reconciliation or a general workflow graph. See docs/WORKSPACE.md.

## 2026-09-21 — journey foundations and simple team requests

Project-based change/question/plan/review requests, approval-only team intake,
requester-visible history, draft retention and clearer task status. Non-change
journeys materialize scan inputs before execution; older workflow-plan semantics
remain unchanged. Visible PR reads refresh automatically, without granting merge
authority. Project readiness receipts detect configuration drift. New snapshot
restores refuse invalid checkouts before agent execution. Intake claims now carry
the intended run ID in both launch paths so reconciliation can recover interrupted
launches. Full persistent interactive workspaces, automatic merge reconciliation,
coordinated multi-repository work and release-loop proof remain open.


Verification: 1,167 runtime, 40 script and 94 web tests; production web build;
18 live responsive page checks. A real private fixture completed a question,
standalone plan, UI-approved wording change, baseline/final tests, independently
checked browser/API/SQLite behavior and a merge approved through Ship. The
wording diff contained only the requested label. Real preparation/test receipts
became stale after configuration changed and valid after restoring the exact
tested configuration. A worker timer produced one proposal across repeated ticks
and stopped when paused (the scratch schedule timestamp was advanced for the
test, rather than waiting an hour). The scratch schedule remains paused.

Evaluation found an unsupported claim in an investigation answer and wasted
inline-edit retries: tightened question instructions and explained the editor's
trailing-newline matching requirement. These are mitigations, not proof that
model answers are always correct. `evals/product-journeys` now contains an
independent browser/SQLite grader. Snapshot identity validation has unit coverage;
the latest live plan used a warm retained sandbox, so its successful worker
upgrade/resume is not new proof of snapshot restoration. The wider journey catalogue remains open.


The UI/API search fixture also passed independent name/email, case, whitespace,
literal-wildcard, empty/no-match, stale-response, browser and data-preservation
checks. Its baseline fails the same search grade (negative control). The agent’s
14 tests passed, the PR changed only UI/API/tests, and existing styling was
preserved. An active worker replacement paused publication until the five-minute
repository lock expired, then recovered automatically without manual unlock.
A repeated question corrected the size-limit claim but incorrectly described a
relative database path as relative to the app file rather than the working
directory. Keep factual answer grading open. Empty machine findings are hidden
from the readable response; Activity retains the original output.


Follow-up evaluation found the conversation displayed unconsumed model text after
the first action, including imagined tool output. The UI now uses the executor’s
`transcriptTurn` projection; plan-only prose is exempt because it is not an
execution turn. Regression coverage includes both cases. Independent PR review
found the seeded search regression but mixed in pre-existing issues; prompt scope
attribution was tightened. An expanded browser grade exposed active-filter/save
behavior missing from the first search grade; same-PR correction passed the expanded independent browser grade, including matching and nonmatching saves under an active filter.

Read-only reviews now carry the checked-out SHA into the evidence view, so a
later PR update warns that the recorded results apply to the earlier revision.
The display says “recorded revision” for both reviews and published changes;
a review is never described as having pushed a commit.

## 2026-09-21 — release programme audit started

[Incremental findings](docs/AUDIT_2026-09-21.md): production manifests differed
from tested framework/driver versions and omitted security overrides. Aligned
pins, frozen production lockfiles, deployment seam checks and expanded CI audits
address that dependency drift. Eight web advisory entries are patched; local and
production dependency scans report zero at the time of review. This is not a
completed security audit. Project boundaries, submission idempotency, merge races,
preview authorization and recovery targets remain explicitly open in the report.


## 2026-09-21 — durable launch recovery and project plan floor

Added additive primary-key intake storage and a durable accepted-launch journal,
transactional Nucleus scheduling publication, bounded worker recovery and stable
direct-request submission IDs. Removed the live missing-events claim-release
race; interrupted intake launches have an authorized same-ID Inbox retry. Project
plan-review requirements are enforced at shared enqueue and cannot be overridden
per task. Details and remaining boundaries: [F06](docs/AUDIT_2026-09-21.md),
[upgrade procedure](docs/UPGRADING.md), [adaptive workflow](docs/ADAPTIVE_WORKFLOW.md).

Open: durable follow-up/parent-decision coordination, complete reservation
reconciliation, full canonical multi-forge identity, broader audit/evaluations
and the remaining release programme. Tests and isolated-engine/browser proofs
do not establish whole-product completion or competitor superiority.
