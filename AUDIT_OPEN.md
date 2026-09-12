# Open audit items

## Akiroo remediation — 2026-09-12

The [delivery contract](docs/AKIROO_DELIVERY.md) records the paired receiver/sender
change and recovery limits. Failed actions now retain explicit receipts instead
of being treated as success; notification sends use the durable outbox, retries
retain owed events, and chronology is carried on the wire. First project sync
protects existing settings; allowlist checks precede storage; managed test
commands update/clear their legacy alias too. No workflow steps changed.

SKIPPED (separate design/operational proof): automatic reconciliation of unknown
forge/run outcomes; crash recovery before a notification intent is enqueued;
one-shot project/revert notifier recovery; commit-bound verification and
independent forge merge synchronization; warm-volume approval restoration;
settled multi-attempt cost propagation (upstream event support); historical
repair. Acceptance: fault-inject each boundary, restart the actual worker,
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
