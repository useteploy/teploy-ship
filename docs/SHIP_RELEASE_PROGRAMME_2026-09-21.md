# Teploy Ship capability and improvement plan

Updated September 30, 2026.

Build Ship into the most capable agnostic software engineering system we can reasonably design and maintain. It should understand software, answer questions, plan, create and improve applications, review changes, coordinate work, operate tools and computers, deliver releases and investigate failures. These are all first-class capabilities. The product direction is broad; the implementation sequence follows dependencies and evidence.

This is the single forward plan for Ship. It replaces the earlier strategy, next-batch and status sections in this programme. The original filename is retained so existing links and S01–S20 references continue to work. New packages S21–S28 extend that programme. [NEXT_SESSION.md](../NEXT_SESSION.md) is the continuation pointer; dated execution documents remain evidence records. Akiroo has its own programme and is an optional client of Ship.

## Product scope and design decisions

Agnostic means that Ship's core does not assume a particular model, coding harness, language, framework, repository host, compute provider, deployment system, telemetry vendor or request channel. Supported combinations must be explicit and tested. An extensible contract is how we broaden support; calling an untested endpoint is not proof that a combination works.

The intended scope includes greenfield projects and unfamiliar existing systems; individual repositories, monorepos and coordinated repositories; web, backend, command-line, library, infrastructure and native/mobile work; short requests and long-running missions; interactive collaboration and unattended authorised workflows. Initial fixtures and staged support commitments do not limit that ambition.

Ship should support engineers who want detailed control and other teammates who want to describe an outcome. Use progressive disclosure within the same task system. Preserve Teploy's existing navigation, dark palette, monospace typography and compact controls while improving readability, accessibility and interaction quality.

Those visual constraints apply to Ship itself. Applications Ship creates or edits follow their own requirements, design systems and platform conventions. Product creation includes discovering the intended behaviour, comparing design approaches, producing working interfaces and assessing visual/interaction quality, not just assembling a scaffold.

General capability requires planning, execution, verification and continuity to work together. Every change gets an appropriate plan and checks; depth adapts to the work. Request length, file count or a model's assessment of simplicity never grants additional authority. Investigation, implementation, merge, deployment and provisioning remain distinct actions under explicit policy.

Teploy CLI, Cloud, Sandbox and Observe should be excellent native integrations. Equivalent third-party systems must be able to participate through supported contracts. Ship operates independently of Akiroo. Extend the existing runtime and authoritative records rather than replacing them with another agent framework, task database or approval queue.

The aim is to improve capability, successful completion, user control, speed and total cost together. Where those objectives conflict, expose an understandable policy choice and measure the trade-off. No single benchmark, feature count or market niche defines the product.

## Current position and the gaps to close

This assessment uses source at local 42af7fb, origin/main 796066d, the September completion receipts and official competitor documentation checked September 30. The last recorded live application deployment is dd5b13e; it was not freshly probed for this planning revision. “Existing” below means source or prior proof, with scope specified. None of the new packages is declared complete by this document.

| Capability | Existing foundation | Gap and consequence | Work |
| --- | --- | --- | --- |
| General task quality | Questions, plans, changes, reviews and independent journey graders | Incorrect answers, incomplete changes and revision failures appear in retained attempts; no clean current held-out result | S02, S07, S09, S13, S20 |
| Implementation and debugging | Coding tools, test execution and verified-finish foundations | Safe editing, causal diagnosis, alternative solutions and actual completion need explicit acceptance across unfamiliar stacks | S06–S09, S13 |
| Model and harness portability | Native, Claude Code and OpenCode adapters; compatible model gateways | Evidence is concentrated in GLM/native configurations; transport compatibility exceeds demonstrated quality; no established measured role router | S13, S23 |
| Durable collaborative work | Launch/follow-up identity, approvals, recovery and task/workspace surfaces | Complete requirements, acceptance, steering, participants and external events need one consistent long-lived contract | S03, S04, S11, S16 |
| Planning and orchestration | Adaptive workflow foundations and real API/client coordination | Narrow producer/consumer flow is proven; general task graphs, dynamic delegation and recorded pair integration tests are not established | S07, S18, S22 |
| Repository understanding | Semantic index with coverage reporting, playbooks and scoped history | Rich revision-aware knowledge, dependency/ownership maps and measured retrieval quality need development | S07, S21 |
| Environments and computer use | Preparation, warm workspaces, previews and governed terminal/editor/browser takeover | Repeatable fresh/cached recipes, service lifecycle, persistent state policy and heterogeneous execution need broader acceptance | S05, S06, S08, S12, S26 |
| Review and verification | Revision-bound evidence, test gates, same-PR work and merge reconciliation | Review attribution/noise, finding continuity, behavioural coverage and external-head changes remain quality targets | S07–S09 |
| Automation and integrations | Schedules, Slack/Linear/forge/Observe intake and independent HTTP lifecycle client | Rich event rules, standing tasks, workflow reuse, connector contracts and lifecycle controls need expansion | S16, S24 |
| Team and enterprise controls | OIDC, role mapping and approval policy | Project isolation, service-account lifecycle, hierarchical policy and credential mediation require scoped implementation and proof | S01, S25 |
| Delivery and operations | Bound delivery records, trusted deploy paths, observation and rollback receipts | Broader target adapters, migration-aware recovery and complete incident workflows need validation | S14, S15, S17, S27 |
| Operational scale | Bounded concurrency, spend caps and recovery work | Mixed workloads, fairness, quotas, history growth, host failures and fleet operations need measured support limits | S11, S19, S26, S28 |
| Product quality | Working UI and narrow-layout fixes, independent install and restored-history receipts | Comprehensive interaction/accessibility, clean-machine setup, human observations and sustained-quality measures remain open | S04, S05, S10, S19, S20 |

Factory is a reference for missions, model routing, knowledge, readiness and enterprise control. Capy is a reference for persistent threads, task placement, reusable environments, review continuity and event automation. Devin contributes computer/testing workflows; OpenHands contributes extensibility; Sparkles contributes accessible collaboration; Vorflux contributes full-stack environment and coordination ideas. These are documented design references, not measured superiority claims.

The plan's frozen product baseline was 21 passes, 13 failures and two human-gated harness errors over 36 attempts. **Recounted 2026-10-03, that figure is not reproducible from retained records:** `scripts/eval-report.mjs` counts 28 attempts in `evals/product-journeys/results` as 15 pass, 5 fail, 6 unknown, 2 harness-error and 0 authority-hold in the original classification (one harness-error is the approval hold that a supplementary file reclassifies); see `evals/product-journeys/BASELINE_RECOUNT_2026-10-03.md`. Infrastructure distress and grader problems confound interpretation. Preserve the original results and classify those factors in a new comparable evaluation. The documented GLM result is 35/50 on a seeded SWE-bench Lite subset with a different configuration from the product. Neither result establishes market rank.

## Shared architecture

Use the following contracts across UI, API, CLI, connectors and agents. Establish these boundaries incrementally in the current system.

| Record or boundary | Required responsibility |
| --- | --- |
| Organisation and project | Canonical forge/repository identity, membership, effective policy, configuration inheritance, environment, scoped connections and deployment/service mapping |
| Task | Intent, accepted requirements, participants, conversation, attachments, plan versions, child work, attention state and cumulative evidence/cost |
| Attempt and execution segment | Immutable history of actual model/harness/configuration, tools, environment, costs, cancellation and recovery; any later routing change is recorded rather than hidden |
| Workspace | Owner/lease, capabilities, network policy, files, services, lifetime, snapshot and restore identity; durable task identity is independent of a running machine |
| Context and knowledge | Source/revision/access provenance, freshness, retrieval coverage, retention, correction and deletion; repository text is untrusted input |
| Evidence | Requirement, repository, exact tested tree, environment, command/scenario, artifact, result and time; passed, failed, not run and unknown remain distinct |
| External operation | Actor, scope, durable intent, idempotency/retry policy, applicable approval and reconciliation of ambiguous outcomes |
| Delivery | Tested and merged revision, artifact digest, trusted config, target, migration/recovery plan, observation and rollback result |
| Adapter and reusable workflow | Versioned capabilities, schemas, authority, budgets, secret handling, cancellation and conformance tests; no implicit privileged path |

Execution completion, requirement acceptance and delivery completion are separate outcomes. Finishing a model turn, producing a patch or passing a subset of tests does not close the task. Track each requirement against its applicable evidence, unresolved work and authorised acceptance decision. An unmet requirement can be explicitly waived by an authorised user; its evidence does not become a pass.

Keep existing runs, parked workflow fingerprints and evidence addressable. Rehearse additive storage changes on restored production copies. Canonical identity includes forge origin; do not infer missing legacy origins or reinterpret accepted run inputs.

Ship owns intent, workflow, authority and presentation. Sandbox owns execution isolation and lifetime; CLI owns its deployment operations; Observe owns its telemetry. Neutron/Nucleus faults are fixed upstream, with reports and handover. Do not patch vendor tarballs or cut upstream releases from a Teploy session.

## Autonomy and long running work

Support both interactive work and policy-authorised unattended execution. An authorised operator can grant a bounded task or automation permission to implement, publish a PR, merge, deploy or provision, with separate action scopes, targets, required checks, budget, expiry and escalation rules. Within that grant, Ship should proceed without asking the same question again. Existing defaults remain until a proposed policy passes its acceptance checks.

Child agents, connectors and model switches inherit no more authority than the parent grant. New scope or an irreversible action outside that grant requires a concrete decision. Changes in actor access, revision, configuration or target trigger revalidation. Define project and fleet pause controls, and distinguish stopping future actions from interrupting a command whose external effects need reconciliation.

Long tasks need durable milestones, resumable requirements and decisions, meaningful progress/stall signals and bounded wake-ups. Waiting for a user, CI or an external dependency must not create a paid polling loop. Test multi-session work with forced context compaction, worker loss, user steering and long waits; preserve accepted requirements, exact revisions and completed work across all of them.

## Foundation and everyday engineering

### S01 Security and authority boundaries

**Owner:** Ship, with Sandbox/CLI/upstream changes where the boundary belongs. **Dependencies:** none; repeat after material extensions.

Audit current routes, project access, attachments, previews, tools, secrets, snapshots, external operations and actual built dependencies. Re-triage current alerts rather than carrying forward a stale count. Command regexes remain advisory; filesystem, network, credentials and typed external operations enforce policy.

Exercise prompt injection through repositories, web pages, issues, tool responses and retrieved memory. Their instructions cannot alter authority, expose secrets or cause a privileged fetch. Validate redirects/resolved destinations and outgoing data scope at the boundary. A tool's declared effect is descriptive; credentials and executor controls enforce the actual permitted effects. Include dependency/setup scripts and restored snapshots in this threat model.

Resolve the documented preview network reach before offering stronger isolation claims. An unreviewed preview must not inherit access to unrelated applications, private networks or metadata services unless expressly allowed. Audit authenticated Git commands and remote scrubbing against a scoped credential proxy or equivalent short-lived mediation; inspect logs, errors, process visibility and snapshots before deciding the design.

**Acceptance:** two users with different project access cannot retrieve each other's data or cause actions; revoked/expired authority and equivalent command/API forms are refused at the actual boundary. Preview egress, lateral-isolation, hostile-context and secret-exfiltration probes pass under declared policy. No unresolved exploitable release-blocking finding in the intended scope; remaining findings have owners, dispositions and reproductions.

### S02 Independent quality and regression evaluation

**Owner:** Ship evaluation. **Dependencies:** none; supplies evidence to every package.

Retain and correct the existing external graders. Build a current baseline and held-out tasks covering questions, planning, creation, visual work, features, API and permission defects, migration, dependencies, review, same-PR/conflict revision, automation and deployment recovery. Extend to unfamiliar repositories, long missions, computer use and multiple configurations as support broadens.

Separate product defects, infrastructure faults, deliberate authority holds, grader errors and human intervention without hiding any original attempt. Grade requirement completeness, unsupported claims, unwanted changes and actual behaviour, not just the existence of a PR or tests.

Keep regression fixtures separate from held-out evaluation. Repeated tuning on a held-out set makes it a development set; replace it for subsequent claims. Use shuffled/unfamiliar tasks and mutation or failing controls to detect shallow graders. Where subjective judgement is needed, use a declared rubric and blinded human assessment when available, with disagreement retained.

**Acceptance:** exact revisions/configurations, failing negative controls, out-of-workspace graders and reproducible receipts. Record first-attempt and eventual completion separately, intervention, elapsed time and known/unknown cost. Preflight and a canary precede paid batches; existing caps apply.

### S03 Durable tasks and adaptive workflows

**Owner:** Ship runtime and UI. **Dependencies:** S01.

Unify question → plan → implementation → review → revision in one durable task while preserving distinct authority and attempt history. Version requirements and plans. Support queued steering, interruption, resumable blocked work and explicit scope changes. Make execution, acceptance and delivery states separately visible.

Persist checkpoints containing accepted requirements, plan/dependency state, actual revisions, outstanding operations and next actions. Reconstruct from authoritative records after context loss; summaries remain fallible views. Multiple participants' edits and steering need explicit order/conflict handling, not silent last-write-wins replacement.

Enforce required plan review at shared enqueue across UI, CLI, API and automation. Pause when work exceeds authorised scope; do not rely on a prompt alone. Recover double submission, lost response, conflicting accepted intent and cancellation without dropping user history.

**Acceptance:** refresh, two tabs, restart and delayed events preserve the intended operation and requirements. Read-only requests stay read-only; changed scope does not silently reuse old approval. Existing parked runs survive the additive migration.

### S04 Requesting work and team collaboration

**Owner:** Ship UI and intake. **Dependencies:** S03.

Support ordinary language, code-oriented requests, screenshots, files, URLs and shared task participation. Ask useful clarifying questions; preserve drafts and context through retries. Provide clear handoff, actionable results and authenticated notifications. Add voice input as an optional input adapter after attachment and intent contracts work.

Treat imported context as untrusted and authorise its retrieval without privileged arbitrary URL fetching. Support requester, reviewer, implementer and operator responsibilities through policy rather than separate incompatible products.

**Acceptance:** an engineer and a less-technical requester can submit, clarify, inspect evidence, revise and decide without losing context. Failed setup and unavailable connections have repair routes; revoked participants lose access and notifications. Automated checks and real human observations are reported separately.

### S05 Project setup and effective configuration

**Owner:** Ship, with CLI/Cloud adapters. **Dependencies:** S01, S03.

Connect existing repositories and applications, and support greenfield creation with explicit ownership and cleanup. Detect stack/services, propose versioned preparation and test/start commands, and validate deterministically before paid diagnosis. Expose configuration source, overrides/reset, next-run effects and responsible administrator.

Dry-run repository-to-service imports. Explain provisioning targets and known/unknown recurring costs before creating infrastructure. Readiness records relevant image, recipe and configuration identity and expires when those inputs change.

**Acceptance:** a fresh project reaches its first useful task through supported UI/API flows. Expired credentials, missing tools/services and unavailable workers yield specific repairs. Imports preserve existing configuration/data, and same-name repositories on different forges remain distinct.

### S06 Reusable environments and services

**Owner:** Ship environment/images and Sandbox. **Dependencies:** S05.

Separate initialise, refresh, startup and teardown. Support versioned images/recipes, caches, databases, queues, browser/encoder tooling, port discovery and bounded service health checks. Start with the existing static/site, TypeScript/service/database and Python fixtures; broaden the language and service matrix through reusable contracts.

Offer explicit clean execution when cached state could mask failure. Scope secrets and distinguish persisted filesystem state from live process/browser state. Reuse proven browser tooling rather than asking every model to recreate it.

Record dependency resolution and build inputs, not only source commits. Validate binary/large-file transport, long-running commands, paginated or truncated output and background process cleanup. Privileged image preparation is separate from untrusted repository setup; reusable snapshots/caches must not carry one project's secrets or data into another.

**Acceptance:** each advertised recipe passes fresh and cached setup, startup, tests, preview and cleanup, including missing services and corrupt cache. Preparation is reproducible from the recorded inputs and does not require hidden per-request operator fixes.

### S07 Grounded reasoning planning and implementation

**Owner:** Ship reasoning/context. **Dependencies:** S02, S03; uses S21 as it grows.

Ground answers and plans in inspected code, requirements and environment facts. Decompose work, identify dependency/migration risks, select relevant checks and update plans when evidence changes. Cite material claims with revision provenance and distinguish inference from reproduction.

Make the coding loop explicit: inspect the relevant system, reproduce the failure where feasible, form a testable hypothesis, make a bounded edit, build/run the affected behaviour, inspect the actual result and revise. Provide structured tool calls, reliable patch/file operations and diagnostics for malformed actions, stale edits, missing dependencies and truncated output. Preserve unrelated and human edits, including binary/generated files where relevant.

For difficult work, support budgeted alternative hypotheses or candidate implementations in isolated branches/workspaces. Compare them with declared acceptance checks, promote the chosen result with provenance and retain failure evidence. Use debugging, profiling, targeted instrumentation and bisection where they provide useful information. Large refactors need compatibility and regression checks; visual/product work needs design and interaction acceptance as well as code checks.

Measure answer correctness and review attribution. Plan depth adapts to the problem; permission/price/data edits may need substantial analysis despite a small diff. Use independent critiques when they improve measured outcomes, without assuming a second model guarantees correctness.

**Acceptance:** known wrong-answer and attribution regressions pass external checks. Plans cover acceptance criteria without implementing investigation-only requests. Unfamiliar implementation, debugging and refactoring tasks produce complete working changes without discarding unrelated edits. A claimed fix with no required change, a malformed tool call or an incomplete implementation cannot be labelled accepted. Unsupported material claims and unnecessary scope are graded; unresolved uncertainty remains visible.

### S08 Behavioural verification and previews

**Owner:** Ship verification, Sandbox and preview adapters. **Dependencies:** S06, S07, S01.

Choose and execute checks appropriate to the requirements: tests, real API/database assertions, browser interactions, authenticated flows, visual comparison, accessibility and performance. Preserve baseline and final results. Tie previews, screenshots and recordings to the actual revision and environment.

Support stateful fixtures and later native/mobile checks through S26. Project access, expiry, cancellation, supersession and broken-preview recovery apply to previews as well as task pages. Models cannot edit the independent acceptance oracle.

Map requirements to checks and expose uncovered requirements. Use property, fuzz, mutation, compatibility or load checks where they add relevant coverage. Newly generated tests are part of the proposed change, not automatically independent proof; detect skipped/disabled tests, altered assertions, baseline flakiness and fixtures that make failures disappear. Run final acceptance against the actual final tree/build, with separate oracle inputs where available.

**Acceptance:** planted behavioural, permission and persistence failures remain failures despite a success narrative. Changing the test to hide a defect, passing only a convenient subset or testing a different artifact cannot establish acceptance. A demonstrated UI change has interaction and persisted-state evidence where applicable. Stale or unauthorised previews are refused and can be recovered safely.

### S09 Review revision and merge

**Owner:** Ship forge, governance and UI. **Dependencies:** S03, S07, S08.

Review exact diffs with severity, confidence, evidence and introduced-versus-existing attribution. Carry findings, comments and resolutions across revisions; distinguish confirmed defects from investigation questions. Support existing PRs, same-PR changes, conflicts, stacked changes and external commits.

Reconcile forge events with bounded polling. Revalidate head/tree, branch protection, checks, permissions and required reviewers at action time. Changed bytes need applicable verification; preserve both user edits and valid earlier work.

**Acceptance:** revision → retest → approved merge works for new and existing PRs. Seeded defects are detected without excessive baseline false positives. Stale approval, a racing commit and missing review requirements cannot merge; externally completed work is represented accurately.

### S10 Interface quality and accessibility

**Owner:** Ship web. **Dependencies:** applied throughout S03–S09 and advanced surfaces.

Preserve the existing Teploy design. Improve outcome/progress/blocker/next-action hierarchy, readable diffs, settings, empty/error/offline states, keyboard focus, contrast, screen-reader semantics and responsive layouts. Keep detailed logs and expert controls reachable.

**Acceptance:** keyboard and 390/768/1440 layouts plus 200% zoom work across core and advanced journeys. Observe at least five real target users, including three less-technical users, without coaching. Retain the formative targets of finding the next action within ten seconds and four of five completing the request/revision scenario without rescue. These observations happen during the pilot and do not block implementation or the first invitations.

## Reliable execution and complete operations

### S11 Recovery resource control and cost

**Owner:** Ship and Sandbox. **Dependencies:** S01, S03.

Exercise warm/cold recovery, uncommitted files, services, browser-state policy, leases/TTL, network loss and worker death. Add queue fairness, bounded tool/model latency, retry budgets, stall detection, cancellation and resource limits across projects.

External push, comment, preview, merge and notification outcomes need durable intent and readback after ambiguous failure. Unknown is a valid state; universal exactly-once effects are not promised. Show aggregate priced and unpriced usage; local inference still has hardware/operator costs.

Reserve budgets atomically across parent/child tasks, retries and concurrent actors before work begins; reconcile late usage and unknown pricing conservatively. Bound compute, storage, egress and tool duration as well as tokens. Lease expiry must fence an old worker's writes/actions when a new worker takes over; a second control-plane worker cannot become a duplicate writer. Define behaviour during store/provider outage and clock skew.

**Acceptance:** boundary fault injection and real restarts preserve accepted work and reconcile intended effects. Concurrent workers, stale leases and shared-budget races do not duplicate authorised work or exceed declared limits. Cancellation/budget races cannot resume spending without authority; cache restoration never pretends a lost tree was preserved. Mixed users/projects cannot starve each other indefinitely.

### S12 Collaborative workspace and computer use

**Owner:** Sandbox primitives, Ship UI/authority. **Dependencies:** S01, S03, S06, S11.

Extend the existing lease-based terminal, editor and browser takeover into an effective professional workspace. Support inspect, pause, acquire, edit/test, hand back and reverify. Provide useful file navigation, diffs, live services, browser/desktop access and external IDE attachment where supported.

Define browser-login persistence and file-transfer access. Agent and human writes use explicit ownership; observer sessions remain read-only. Execution capabilities vary by target and are surfaced honestly.

**Acceptance:** live acquire → human edit/test → handback → agent continuation retains edits and verified revision. Revoke, expiry, reconnect, worker restart and competing ownership fail safely. A full desktop or IDE claim requires an actual supported-target journey.

### S13 Harness capabilities and portability

**Owner:** Ship adapters, upstream SDK as appropriate. **Dependencies:** S02, S06, S11.

Publish capabilities for native, Claude Code and OpenCode: investigation, planning, steering, tools, browser, interruption, approvals, recovery and accounting. Run the same supported journeys across stable configurations and repair prompt/protocol assumptions revealed by differences.

Design the conformance boundary so additional harnesses can join without bypassing policy. Evaluate additional adapters when they add a capability or quality advantage and can be maintained; installation alone is not support.

**Acceptance:** advertised configurations pass their declared journeys and correctly refuse unsupported operations. Model/harness/configuration is recorded, credential lifecycle is tested and unknown pricing stays unknown. Default selection is justified by comparative Ship results.

### S14 Approved releases and deployments

**Owner:** Ship delivery and CLI, with external adapters under S27. **Dependencies:** S08, S09, S11.

Build on existing delivery records and trusted execution. Bind canonical repository, tested tree, merged SHA, artifact digest, trusted configuration, destination, recovery version, actor and policy. Distinguish build, preview, staging and production.

Support appropriate release preparation, migration checks, signing/provenance, rollout checks and deployment-system handoff. Code authority alone does not grant deployment authority.

Bind dependency/image manifests and build provenance to the tested artifact; inventory components where needed. Signing/deployment credentials remain outside untrusted agent execution. Serialise or fence competing releases to the same destination and detect out-of-band target changes before executing an obsolete recovery plan.

**Acceptance:** the approved bytes reach the approved environment and external readback confirms the identity. Wrong target, changed configuration, stale head, failed build and partial deploy cannot become false success. Retry reconciles the actual target.

### S15 Deployment verification and recovery

**Owner:** Ship, Observe and deployment adapters. **Dependencies:** S14.

Associate health, logs, metrics and meaningful observation windows with the correct service and release. Define rollback/hold/retry policy, available versions and compatibility. Insufficient traffic or unavailable telemetry produces unknown rather than healthy.

Separate artifact rollback from database/data recovery. Support backup, forward fix and expand/contract migration strategies as appropriate; irreversible changes require a specific recovery plan.

**Acceptance:** healthy rollout, injected regression, telemetry absence and retained-version recovery are demonstrated. Read back deployed revision and data compatibility after recovery. Complete the outstanding extended observation and preserve measured outcomes.

### S16 Event driven automation and standing tasks

**Owner:** Ship schedules, intake, outbox and UI. **Dependencies:** S03, S07, S09, S11.

Extend intervals into timezone-aware schedules and typed events from forge/CI, issues, messages and incidents. Support reusable standing tasks or new tasks per trigger, explicit run identity, conditions, dry runs, overlap policy, debounce/deduplication and missed-trigger recovery.

Owners can pause, edit and retire automations. Offboarding and revoked access stop future actions. Produce an attention queue and useful authenticated digests, not just an activity stream.

**Acceptance:** real due work completes, delivers its result and survives restart without unintended duplication. Timezone/DST, repeated/out-of-order events, revoked identity, pause and exhausted budget have explicit outcomes.

### S17 Incident diagnosis and maintenance

**Owner:** Ship with Observe or external telemetry. **Dependencies:** S07, S11, S15.

Map incident → service/repository → evidence → diagnosis → bounded proposal → authorised remediation → observed recovery. Use read-only investigation before changes. Support dependency maintenance, security findings, performance investigation and repeated-problem follow-ups through the same task system.

**Acceptance:** seeded incidents choose the correct service/repository, identify the supported cause and verify recovery. Unrelated metrics, absent traffic and low-confidence diagnosis cannot justify a confident fix. Failed or uncertain investigation offers an actionable escalation.

### S18 Coordinated repository integration

**Owner:** Ship coordination. **Dependencies:** S03, S09, S11; S14 when delivery is requested.

Keep the proven API/client path. Add an explicit integration-check execution kind with exact producer/consumer revisions, authorised access to both trees/services and recorded pair-level tests. Static compatibility and a real integration test remain separate evidence classes.

Support safe merge/release ordering, compatible version windows, aggregate cost, failed-child holds and retry without recreating completed work. Feed the broader mission graph in S22 rather than creating another coordinator.

**Acceptance:** producer/consumer changes pass real integration checks; deliberately incompatible versions fail. A failed child blocks unsafe completion, retries preserve good work and racing upstream changes invalidate applicable integration evidence.

### S19 Installation support and product recovery

**Owner:** Ship, CLI/Cloud/Sandbox. **Dependencies:** S01, S05, S11; ongoing.

Provide clean-machine and cached installation, independent operation, supported architectures, actionable diagnostics and a redacted support bundle. Test unavailable registry/model/forge, disk pressure, configuration errors, upgrades and backup/restore.

Document support limits, retention, export, release notes and migrations. Preserve parked work and history through upgrades. Product rollback is distinct from application rollback; retention never silently deletes existing user data.

**Acceptance:** follow the docs from a genuinely fresh supported machine through first verified work and off-host restore without hidden fixes. Warm-cache installation timing is reported separately. Restored counts, full histories, waiting decisions and fingerprints are independently checked.

### S20 Capability acceptance and sustained quality

**Owner:** Ship product/evaluation. **Dependencies:** acceptance evidence for the declared capability set.

Maintain a claim-to-evidence ledger with implementation, automated check, system proof, human observation and optional comparative measurement distinguished. Evaluate unfamiliar work, seven-day rework, human rescue, setup/review effort, quality, time and cost.

Each capability closes with code, meaningful checks, negative/failure coverage, real system/UI evidence and maintained documentation. Later changes invalidate relevant evidence and trigger targeted reverification.

**Acceptance:** release claims match the tested configuration/scope; failures and limitations remain visible. Human participants and competitor accounts are not prerequisites for implementation. Actual comparative superiority requires matched direct evidence; publication/tag/visibility decisions remain Tyler's.

## Advanced capabilities

These packages extend general capability. Their order is governed by the foundations they use; they are part of the intended programme, not a separate product pivot.

### S21 Revision aware knowledge and code intelligence

**Owner:** Ship context/index/memory. **Dependencies:** S01, S03, S07.

Extend current indexing and playbooks into versioned repository maps, architecture/API documentation, symbols and dependency relationships, ownership, decisions and past task evidence. Use lexical, symbol and semantic retrieval with explicit coverage and freshness. Share across repositories only with authorised scope.

Refresh on relevant changes, invalidate stale conclusions and let users correct or delete memory. Compress long history while retaining requirements, sources and decisions. Treat generated knowledge as fallible context, never authority.

Distinguish verified facts, accepted decisions and tentative hypotheses. Retrieved notes must retain source and correction history; an agent repeating its own earlier claim does not verify it. Allocate context between requirements, current code, evidence and history, and test retrieval plus compaction under actual model limits. Changes in access/retention apply to derived summaries, embeddings and exported knowledge too.

**Acceptance:** unfamiliar-repository questions and change-impact tasks improve over the current retrieval baseline at measured context/time cost. Renames, branch changes, revoked access, partial indexing and poisoned documentation do not yield stale confident answers or cross-project disclosure.

### S22 General missions and coordinated agents

**Owner:** Ship orchestration. **Dependencies:** S03, S07, S11, S13 contracts; S09 for forge mutation and S18 for coordinated repository integration.

Represent a mission as explicit goals, dependencies, acceptance and bounded child work. Support parallel independent tasks, serial dependent tasks, specialist investigation/implementation/review/testing and nested delegation. Dynamically replan when evidence or requirements change, under the existing task's authority.

Choose isolated writer workspaces or shared read-only access explicitly. Coordinate branch/file ownership, exact input revisions, questions to parent/user, cancellation and aggregate budgets. Use validators with separate evidence access. Bound graph size and depth; adding agents must earn quality or elapsed-time improvement.

Give each child a typed deliverable and explicit input revision, authority and acceptance contract. Resolve competing candidates, dependency cycles, blocked children and disagreement through bounded escalation. Parent acceptance checks the aggregate requirements and integration result, not the number of finished children. Begin with useful single-repository delegation without waiting for every multi-repository feature.

**Acceptance:** a mission spanning multiple components and repositories completes with independent integration evidence. Failed children, conflicts, revised plans, lost workers and cancellation preserve completed work and block invalid completion. Compare against the serial baseline before promoting a default orchestration policy.

### S23 Model selection routing and fallback

**Owner:** Ship model/harness policy. **Dependencies:** S02, S07, S13.

Support explicit per-role model/effort selection and, later, measured routing by task stage, required capability, context, quality, latency and cost. Support BYOK, compatible gateways and local models according to conformance evidence. Keep user-selected deterministic configurations available.

Version routing policy. Record actual provider/model/configuration per segment, reserved spend and reasons for fallback. Permit switches only under an explicit policy; never silently change an immutable recorded attempt or replay uncertain tool side effects.

Provider compatibility includes tool semantics, structured output, context limits, streaming/cancellation and multimodal input where claimed. Changing providers also changes where project data travels: enforce permitted destinations, retention requirements and connection scope. Fallback must not route private work to a disallowed provider or expand the task's authority.

**Acceptance:** compare fixed and routed configurations on the same Ship tasks. Demonstrate outages, rate limits, exhausted budgets, unsupported tools and refusal behaviour. Routing is promoted only where it improves a declared outcome without weakening authority or disguising regression.

### S24 Tools integrations and reusable workflows

**Owner:** Ship API/connectors/extensions. **Dependencies:** S01, S03 contracts; S13 for harness integration and S16 for trigger-driven workflows.

Publish a stable external lifecycle API and streaming/event semantics. Add a versioned tool/connector boundary, including MCP where appropriate, for forges, CI, issue trackers, messaging, docs, cloud and internal services. Each tool declares input/output, read/write effects, scope, secret transport, timeout, cancellation and approval requirements.

Support reusable task templates, repository skills, test recipes and organisation workflows with versioning, dry runs and conformance fixtures. Installation requires the administrator's intended permissions; imported instructions cannot grant them.

Ship a documented extension SDK and conformance kit, with compatibility/deprecation policy, effective permissions and disable/uninstall behaviour. Exercise executable plugins under declared isolation; instructions-only skills still have provenance and cannot become authority. Stable API clients need request correlation, cursor/reconnect semantics, signed or equivalently authenticated events and schema-version handling.

**Acceptance:** an independent client and a separately authored connector/workflow complete a declared lifecycle without internal imports or direct store access. Duplicate events, schema mismatch, tool failure, malicious output, revoked credentials and unknown external outcome are handled predictably.

### S25 Organisation policy and administration

**Owner:** Ship identity/policy/UI. **Dependencies:** S01, S03 contracts; S24 for connector-specific administration.

Build on OIDC with explicit organisation/project membership, scoped service accounts, invitations, offboarding and effective policy inheritance. Cover models, tools, network, data retention, run/delivery/provisioning authority, spend and workspace access. Add SAML/SCIM or equivalent identity lifecycle support where the supported deployment requires it.

Provide audit/export, data-handling settings and administrator diagnostics. Organisation policies establish mandatory limits; project/user customisation operates within them. Air-gapped operation needs supported local identities/models, offline updates and an explicit unavailable-feature list.

Separate durable execution/audit facts from deletable sensitive payloads so append-only history does not accidentally imply permanent storage of secrets or attachments. Specify encryption/key recovery, provider egress, access revocation and retention across artifacts, logs, caches, snapshots, memory and backups. Readiness for a deployment includes its applicable licence/distribution permissions and supported offline dependencies; do not infer open-source status or redistributability from technical self-hosting.

**Acceptance:** join/revoke/expiry/offboarding, restricted projects, automation identities and conflicting inherited policies work across all entry points and active sessions. Cross-project search, events, artifacts, workspaces and external mutations enforce the same rules. Certifications are separate assurance work, not inferred from these controls.

### S26 Execution targets and fleet management

**Owner:** Sandbox and Ship environment/fleet. **Dependencies:** S01, S06, S11 contracts; S12 for interactive surfaces and S19 for supported installation/recovery.

Introduce or extend execution-provider capabilities for local and remote containers/VMs, private networks and customer workers. Schedule by required OS, architecture, CPU/memory, browser/desktop, services and hardware. Add Windows/macOS, mobile simulator/emulator or GPU targets through adapters and conformance coverage rather than pretending a Linux container supports them.

Manage warm pools, snapshots, host draining, quotas, placement and disposable credentials. Separate full control-plane self-hosting from customer-hosted workers. Define support for private registries/services and deliberate offline operation.

**Acceptance:** at least two genuinely different execution backends run shared supported journeys with declared differences. Host loss, unavailable capacity, target mismatch and snapshot incompatibility fail or recover correctly. Publish mixed-workload capacity and operator effort before making broad scale claims.

### S27 Deployment telemetry and infrastructure adapters

**Owner:** Ship adapters, CLI/Cloud/Observe integrations. **Dependencies:** S14, S15, S24 contracts; S25 for organisation policies. S17 consumes these adapters for external incident workflows.

Define deployment and telemetry contracts independent of Teploy-specific types: inspect, plan, authorised build/deploy, artifact/target readback, observation, logs and supported recovery. Teploy remains a native implementation; support existing CI/CD, container/Kubernetes or other deployment systems through adapters.

Provisioning has dry-run, account/region/resource/cost identity and separate authority. Track infrastructure-as-code changes and application migration risk. Unsupported recovery modes remain explicit rather than being approximated as success.

**Acceptance:** Teploy and one external delivery/telemetry combination complete the same applicable release journey. Wrong-service attribution, racing deploys, partial provider failure and invalid recovery are refused or reconciled. Customers can use Ship for coding/review without adopting a deployment stack.

### S28 Engineering insight and controlled improvement

**Owner:** Ship telemetry/product/evaluation. **Dependencies:** S01–S03 event/access contracts; S16 for recurring work and S21 for knowledge-driven suggestions. Candidate adoption uses the S20 evidence gate.

Show task success, interventions, review precision, requirements coverage, queue/setup/runtime bottlenecks, spend and recurrent failures by authorised project/configuration. Extend readiness receipts into actionable capability coverage and repair paths. Use OpenTelemetry-compatible export where feasible.

Instrument these records in the first batch, before choosing improvements; insight must not wait until the rest of the product is complete. Trace model/tool/queue/preparation behaviour without exposing secrets or recording unrestricted sensitive content. Distinguish missing telemetry from zero activity.

Turn repeated failures into reproducible regression tasks and versioned prompt/recipe/routing proposals. Test candidates against fixed and held-out suites before rollout; retain rollback and configuration provenance. Avoid self-reinforcing memory or uncontrolled self-modification.

**Acceptance:** reported metrics trace to recorded attempts and disclose exclusions/unknowns. A candidate improvement demonstrates its benefit on applicable tasks and passes boundary regressions before adoption. Organisation summaries do not leak restricted project detail.

## Implementation sequence

The sequence is a technical dependency order. All capabilities remain in scope. Existing implementation is reused, and useful independent work can proceed when its required contracts exist.

Dependencies mean the specific contract needed for a slice, not completion of every acceptance scenario in an entire package. A core tool API can precede rich schedules; organisation membership can precede an integration catalogue; a single-repository mission can precede general cross-repository delivery. Advanced packages feed back into core quality as soon as their contracts are ready.

| Stage | Focus | Dependencies and exit evidence |
| --- | --- | --- |
| 1 Current state and common contracts | S01–S03, S11, S13, S19; initial S28 instrumentation | Reconcile current receipts, audit open boundaries, fix grader defects, prove task/authority/recovery compatibility and establish a trustworthy comparison point |
| 2 Complete everyday engineering | S04–S10, S12, S21; strengthen S09 throughout | Fresh project → grounded question/plan → implemented change → real preview/checks → revision → approved merge; include unfamiliar existing and greenfield fixtures |
| 3 General coordination and automation | S16, S18, S22–S24; extend S25 | Recorded pair integration, a multi-component mission, reusable workflow and event-driven task demonstrate continuity, bounded delegation and external-client compatibility |
| 4 Complete lifecycle and organisation support | S14, S15, S17, S25–S28 | Multiple execution/delivery paths, policy inheritance, attributed incident recovery and fleet evidence; core journey regressions continue |
| Continuous evaluation | S02, S10, S20, S28 | Compare candidates, retain failures, collect human observations and sustained rework; publish only supported claims |

Existing delivery and takeover are already implemented in meaningful slices; stages do not imply rebuilding or withholding them. Advanced contracts can be developed alongside core corrections where independent. Do not wait for every advanced feature before inviting users or shipping an authorised bounded release.

### Implementation slice discipline

Turn each next slice into a small specification in this document: current reproduction/evidence, intended behaviour, owning layer and touched contracts, minimum prerequisites, migration/recovery effects, independent acceptance, rollout/revert method and evidence location. Record the decision and result against its existing package; do not create another competing plan or status queue.

Prototype risky claims before expanding them: validate a new tool/provider contract, model context strategy or execution target in an isolated supported fixture, then integrate it. Reuse proven implementations. A new subsystem needs a demonstrated missing responsibility; a competitor feature name is not a reason to build one.

### First executable batch

1. Reconcile origin/main with current receipts in an isolated review checkout; inventory supported models/harnesses, environments, entry points, authority and known failures. Verify source/deployment identity read-only before testing production-facing work. Add missing S28 event/timing fields needed to judge changes.
2. Correct and validate the independent graders, including approval-hold classification, and run a deterministic preflight/canary. Propose the bounded current-versus-candidate model-dependent batch with exact configuration and cost under existing authorisation.
3. Complete the shared task/requirements/acceptance contract and map existing records to it. Rehearse migration and lost-response/restart/steer behaviour without disturbing original waiting decisions.
4. Audit preview isolation and Git credential placement; implement fixes in the owning layer with real boundary probes. Re-triage the remaining audit items rather than relying on old “closed” summaries.
5. Deliver one unfamiliar existing-repository and one greenfield journey through setup, grounded plan, implementation, verification, review and same-task revision. Include a genuine debugging case and force a context/worker interruption. Use their failures to prioritise the next core corrections.
6. Specify and exercise the recorded two-repository integration-check kind for multi-repository missions. Single-repository delegation can progress independently under its required contracts. Extend context/routing/integration contracts incrementally.

These are concrete starting tasks, not a declaration that earlier code is absent. Size each implementation slice after its contract/reproduction is established; do not invent a completion date for the whole programme.

## Evaluation and capability gates

Use a coverage matrix across task families, existing/greenfield/mono/multi-repository projects, models/harnesses, environments/targets, forges, request channels and delivery/telemetry backends. Run boundary conformance for every advertised adapter and representative complete combinations; exhaustive Cartesian coverage is impractical. Record untested combinations explicitly.

Include long-horizon work, ambiguous requirements, design/visual judgement, large refactors, baseline flakiness and hostile imported context, alongside deterministic defect tasks. Evaluate single-repository and cross-repository missions separately. Compare orchestration, retrieval and routing improvements against simple fixed/serial baselines to identify which mechanism actually helps.

Maintain these measures for each meaningful configuration:

- Requirement completeness, correct implementation/answers and unwanted changes.
- First-attempt and eventual completion, rescue count and seven-day rework.
- Review defect detection, false positives and introduced/pre-existing attribution.
- Setup/review/decision effort, elapsed and active time, queued/preparation time.
- Token/provider spend, unpriced quota, compute and operational effort.
- Recovery success, cancellation time and reconciled external outcomes.

Use raw counts at low sample sizes, and distributions only when sample sizes support them. Preserve original failures, infrastructure exclusions and grader amendments. Exact-revision evidence and independent negative controls are mandatory for claims of verified behaviour.

Before running an acceptance batch, freeze its primary outcomes, allowed intervention, resource limits and acceptable regression margins. Terms such as “useful”, “improves” and “excessive false positives” need a declared rubric or threshold for the specific slice; do not choose a favourable threshold after seeing results. Where a baseline is missing, establish it and mark the capability provisional. Compare quality/time/cost trade-offs explicitly rather than collapsing them into an unexplained score.

Use capability flags and staged rollout for material runtime, model and policy changes. Rehearse affected storage/parked-run compatibility and product rollback; observe the canary before widening. Preserve failing attempts and promote only the tested configuration. Infrastructure fixes are accounted for separately from claimed reasoning improvements.

**Core capability gate:** representative question, plan, creation, change, review, revision and interactive workspace journeys pass current checks, installation/recovery is repeatable and declared security boundaries hold.

**Advanced capability gate:** coordinated missions, recorded integration tests, event automation, reusable tools/workflows and supported model/harness routing meet their specific evidence contracts.

**Lifecycle and organisation gate:** supported delivery/telemetry paths, incident recovery, organisation authority and heterogeneous execution are demonstrated under normal and failure conditions.

These gates define supported capabilities, not product scope cuts. A public “most capable” claim requires evidence against the relevant alternatives on named dimensions. The design ambition itself needs no competitor accounts, and optional head-to-head trials do not block implementation.

## Evidence and source references

The September 30 competitive review (`SHIP_COMPETITIVE_REVIEW_2026-09-30.md`, private, not in this repository) is a research reference. Its narrower positioning recommendation is superseded by the broad product scope in this plan. Earlier planning/status snapshots are historical; current operational facts come from receipts.

Local evidence and requirements:

- Completion execution receipts and reconciled baseline (`COMPLETION_2026-09-25/`, private, **not in this repository**).
- Claim ledger (`SHIP_CLAIM_LEDGER.md`, private, **not in this repository**), [open audit items](../AUDIT_OPEN.md), [model evidence](MODELS.md) and [adaptive workflow](ADAPTIVE_WORKFLOW.md).
- Existing code in task/runtime/worker, coordination, environment, harness, index/memory, takeover, delivery, schedules/intake, project identity and web identity/policy surfaces. Code existence and receipts have different evidentiary strength.

Official design references checked September 30:

- Factory: [missions](https://docs.factory.com/missions/running-app), [Router](https://docs.factory.com/model-independence/factory-router), [AutoWiki](https://docs.factory.com/software-factory/wiki/overview), [enterprise](https://docs.factory.com/enterprise), [air-gapped deployment](https://docs.factory.com/enterprise/airgapped-deployment), [Release](https://docs.factory.com/software-factory/release).
- Capy: [tasks](https://docs.capy.ai/tasks), [threads](https://docs.capy.ai/threads), [environments](https://docs.capy.ai/environment), [review](https://docs.capy.ai/review), [automations](https://docs.capy.ai/automations), [security](https://docs.capy.ai/admin/security).
- Others: [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview), [Devin testing](https://docs.devin.ai/work-with-devin/testing-and-recordings), [OpenHands Canvas](https://www.openhands.dev/product/canvas), [Sparkles](https://sparkles.dev/), [Vorflux docs](https://vorflux.com/docs).

Competitor documentation establishes a reference capability, not its measured quality. Factory's Software Factory/Release surfaces are private preview; Capy's on-prem/BYO-cloud option is an enterprise marketing claim not validated here. Self-hosting, model choice and approvals are not assumed exclusive to Ship.

This planning revision makes no production changes, runs no paid batch and cuts no release. Existing session authorisations continue to apply to subsequent implementation; the plan does not add blanket authority for spending, destructive actions or public release.

## Execution status

Progress against package IDs. Updated 2026-10-02 from a cloud session at origin/main `796066d` (the plan's stated snapshot). Columns keep three claims apart: **implemented** (code merged or on a branch), **checked** (automated test or probe, negative control noted) and **verified outcome** (observed in a real system or against held-out tasks). Nothing below is a verified outcome unless it says so.

Baseline reproduced in this session: `pnpm run lint` clean; root suite 1,412/1,412; scripts suite 104 with 1 existing skip (one failure at first, caused by missing `web/node_modules`, cleared by installing web dependencies, not a code defect); `web` 136/136 and production build succeeds. After this session's changes: lint clean; root 1,450/1,450; scripts 106 tests, 105 pass, 1 existing skip, 0 fail; `web` 136/136 and build succeeds.

| Package | This session | Implemented | Checked | Verified outcome | Still open (specific) |
| --- | --- | --- | --- | --- | --- |
| S01 | Git credential placement audited; scrub now runs in the same shell as the credentialed clone/warm fetch | Yes | Sequencing test fails on previous code; failed-fetch probe is a regression pin only; env-mode real-git probe fails in argv mode (negative control) | No | `SHIP_GIT_CREDENTIAL=env` (off by default) keeps the token out of argv and config; proven on `LocalExecutor` with a real git and a local HTTP server, not through the Sandbox daemon. Needs: daemon `env` forwarding, sandbox git ≥ 2.31, a live private-repo proof on Forgejo and GitHub, then flipping the default (see `AUDIT_OPEN.md`). Preview egress is owned by teploy-cli, not this repo; no change made. Command-regex item `teploy-ship-04` unchanged |
| S02 | Approval stops classified `authority-hold`, separate from `harness-error`; hash-linked reclassification of the migration run | Yes | Executor test fails on the old classification; manifest validation passes | No new model runs | Held-out set, clean current baseline, review-grader lexical limit, authorised-approval path for the migration scenario, n=3 repeats |
| S28 | `runTiming(events)` derives first-step, human-wait, timer and active time with explicit unknowns | Yes, not yet wired into any export or UI | 7 unit tests including open waits and missing timestamps; not exercised against live logs | No | Wire into audit/JSON and UI; queue-claim event; OpenTelemetry export; review precision and rework measures |
| S03 | `taskRecord()` projects execution / acceptance / delivery from existing records; `src/task-requirements.ts` is a drafted, unwired store for accepted and waived requirements (new table, no migration) | Yes, a read-only projection; not wired into a route or UI | 8 unit tests: finished ≠ accepted, revision supersedes approval, denied ≠ absent, delivery never inferred | No | Persisting requirements, acceptance criteria and waivers (needs an additive migration rehearsed on a restored copy); wiring the projection; versioned plans; lost-response / two-tab / steer scenarios on a real run |
| S13 | Steering is refused (route) and not offered (UI) for runs whose harness cannot consume it, from one capability table | Yes, steering only | 4 unit tests on the table; web tests and build pass; the route refusal itself has no automated test | No | Full capability declaration (tools, browser, interruption, recovery, accounting); conformance journeys per harness; comparative results |
| S05, S06, S08, S09 | Not started this session | Existing foundations only | | | Greenfield and unfamiliar-repo journeys (first-batch item 5) |
| S18 | Not started this session | Existing API/client path only | | | Recorded two-repository integration-check kind (first-batch item 6) |
| S18 | `integrationStatus()` in `src/integration-evidence.ts`: the contract an executed two-repository test's evidence must satisfy (exact producer/consumer revisions, static never satisfies executed, stale on upstream move, failed/not-run/unknown all block) | Yes, a pure contract; no executor and not wired into coordination | 8 unit tests | No | The executed integration-check kind itself (a non-scan journey with authority over a two-repo workspace and the real fixture run), wiring the contract into the coordination completion gate behind an opt-in, live producer/consumer run |
| All others | Not started | Per plan table | | | As in the plan |

First-executable-batch items: **(1)** mostly done — origin/main identity matches the plan, the baseline is reproduced and the [capability inventory](CAPABILITY_INVENTORY_2026-10-03.md) is written (subagent sweep, partly spot-checked); the S28 fields are only the derivation above. **(2)** partly done — hold classification fixed; deterministic preflight run (manifest valid, 12/12 dry-runs exit 0, grader negative controls 8/8, unauthorised spend refused with exit 2); the paid canary and batch proposal are not done (no spend authorised or attempted). **(3)** partly done — records mapped and projected (S03 row); no migration, no live lost-response/restart/steer rehearsal. **(4)** partly done — credential placement above; preview isolation is a teploy-cli change plus a live proof on the preview target, neither possible from here. **(5)** and **(6)** not started.

### Execution status, wave 2 (2026-10-03, origin/main after PR #31)

This section supersedes the earlier table where rows overlap (S13, S28, S05, S06, S08, S09, S18, S02 reporting). Every row below is **implemented and checked only**: no row has a verified outcome, because no live Ship, Nucleus, sandbox, forge, model gateway or customer environment was reachable, and nothing was spent. "Not wired" means the module exists with tests but no route, worker or UI calls it, so it changes no behaviour yet. Each PR's description carries its own wiring list.

| Package | PR | Implemented | Checked | Still open (specific) |
| --- | --- | --- | --- | --- |
| S02 reporting | #11 | `scripts/eval-report.mjs` recount of retained results | 10 tests + negative controls; ran on the real retained records | Origin of 36/21/13 (private receipts); seven per-run `summary.json` files predate `unknown` and count it as fail; `pj-b-db-migration` still reads harness-error with the reclassification in a separate file; no new model runs |
| S14/S15 | #12 | Delivery config-identity digest (of `<SHIP_DELIVERY_DIR>/teploy.yml`, not the merged-tree file), stale rollback reconciliation (`claimedAt`), unbounded `due()`/`dueRollbacks()`, unknown-state escalation with run-page notice | 5 tests + 4 negative controls | `destination` enforcement (needs a grammar; design note in `AUDIT_OPEN.md`); worker sweep wiring has no unit harness; legacy executing rollbacks without `claimedAt` are not reaped |
| S11 | #13 | `src/budget-reservation.ts` scope-tree reservation ledger with integer micro-USD and an epoch fence (memory and file backends) | 26 tests, 3 negative controls, 5 mutation checks (file-lock removal not mutation-checked) | Not wired; single-process only (cross-process atomicity needs a Nucleus conditional write); unpriced-settle path; cancel/lease-loss release |
| S01/S04 | #14 | `src/safe-fetch.ts` per-hop validated, address-pinned retrieval | 16 tests, hostname-only negative control, 7 of 8 source mutations caught | Not wired; production pinned fetch untested on a real socket; user-supplied repo URLs still reach forge fetches without destination validation |
| S09 | #15 | `src/finding-continuity.ts` classifier (still-open, resolved, regressed, new, moved, superseded, unconfirmed-disappearance) | 38 tests, line-only negative controls, 4 mutations; synthetic fixtures | Not wired; thresholds unvalidated on real PRs; forge reads carry no inline comments or thread state |
| S03 | #16 | Read-only "Task state" panel on the run page from `taskRecord()` | 8 view-model tests + negative controls; web 144; build; Chromium render at 390 and 1440 on seeded data | No real run observed; no storage or write path for criteria, evidence or waivers; runs list unchanged |
| S05 | #17 | `src/stack-detect.ts` cited stack and service proposals, readiness digest | 32 tests + negative controls (two attempted controls did not fail; redundant by design) | Not wired; no real-repo corpus; regex TOML/YAML parsing; nothing proposed was executed |
| S08 | #18, #31 | `src/test-integrity.ts` detector; advisory read-time panel in the run Verification view (`SHIP_ORACLE_PATHS` read in the web layer only) | 47 detector tests + 14 mutation controls; 9 projection tests + negative control (a missing diff never renders clean); web 153; build | Not a gate; not in the PR body, webhook or delivery record (would change the worker path, needs a decision); precision unmeasured; component not browser-rendered |
| S22 | #19 | `src/mission.ts` mission graph validation, readiness by accepted deliverable at an exact revision, acceptance aggregation | 24 tests + 8 mutation controls | Not wired or persisted; no launching, replanning or cancel; write-grant conflicts checked as strings only |
| S20 | #20 | `docs/claims/ledger.json` -> `docs/CLAIM_LEDGER.md`, `scripts/claim-ledger.mjs --check` | 14 tests; 7 guards disabled to confirm | Not in CI; 12 seeded claims, none verified; tests are cited by name only |
| S23 | #21 | `src/model-routing.ts` versioned routing and fallback policy with gates | 16 tests + 6 negative controls | Not wired; failure classification, policy store and the fixed-vs-routed comparison not built |
| S21 | #22 | `src/knowledge-record.ts` provenance, verification, freshness, correction, redaction closure, visibility | 11 tests + 10 negative controls | Not wired; needs provenance fields and a project concept; decision acceptance, cross-project sharing, retrieval baseline not built |
| S24 | #23 | `src/tool-manifest.ts` validation, intersection-only permissions, conformance audit, signed and deduped event envelope | 25 tests + 8 negative controls | Not wired; enforcement stays with the credential and executor layer; manifest schema is strict (newer-minor manifests are rejected) |
| S16 | #24 | `src/schedule-time.ts` timezone and DST-aware daily/weekly slots, missed-run policy, overlap, debounce | 34 tests, naive-implementation control, 7 mutations | Overlap is inert in production (the worker does not pass `isRunning`); no UI or API to create `at` schedules; no event triggers |
| S25 | #25 | `src/policy-inheritance.ts` org/project/user/service-account resolution, intersection only, fail-closed | 21 tests + union-merge control + 3 mutations | Not wired; no layer store, model/tool/retention enforcement or lifecycle; **service-account role needs product confirmation** |
| S26 | #26 | `src/execution-target.ts` placement with reasons, host-loss recovery, conformance | 23 tests, 10 mutations, two fake backends | Not wired into `SandboxPool` or `durable.ts`; no real Windows/macOS/mobile/GPU adapter |
| S27 | #27 | `src/deployment-adapter.ts` adapter contract, delivery and recovery and provisioning journeys, 27-check conformance suite | 48 tests, 2 faithful + 9 faulty fakes, 8 mutations | No real Teploy/CI/Kubernetes adapter, so S27 acceptance is not met; Teploy has no destination-level fence |
| S13 | #28 | Full capability declaration for native, claude-code and opencode; shared plan-review refusal; pure `conformanceCheck` | 8 new tests + negative control | Per-harness journeys on live runs; `conformanceCheck` not wired to adapter probes; steer-route refusal has no automated test |
| S06 | #29 | `src/environment-recipe.ts` recipe, planning, teardown, lifecycle validation | 18 tests, 6 mutation-verified controls, fake runner only | Not wired; no real runner or cache store; large/binary transport, browser tooling, snapshot secret scan open |
| S28 | #30 | `timing` in `audit --format json` (not CSV), `timingSummary` with an n>=20 gate | 8 tests, CSV byte-pinned, mutation control; CLI wiring type-checked only | No real-store run; **the n>=20 threshold was an agent's choice and needs confirmation**; capacity table not recomputed |

Also merged this wave: #9 plan and inventory, #10 devalue 5.9.3 override. Reporting S10 (UI audit) and S02 (grader mutation) were still in flight when this was written and are not listed.

### Evidence that was not available

- Private execution receipts (`COMPLETION_2026-09-25/`), the claim ledger and the competitive review are not in this repository or this environment, so the plan's statements that rest on them (local `42af7fb`, last live deployment `dd5b13e`, the 21/13/2 product baseline) were **not re-verified** here. The 21/13/2 figure was later recounted against the retained records under `evals/product-journeys/results/` (2026-10-03): it is not reproducible (28 attempts, not 36); the origin of 36/21/13 is in the private receipts, which remain unavailable.
- No live Ship, Nucleus, sandbox, forge, preview target or model gateway was reachable, so no live probe, canary, paid evaluation or deployment read-back was run.
- The repository has no `CLAUDE.md`; `AGENTS.md` refers to one. Build/test conventions above come from `package.json` and `AGENTS.md`.
- Competitor material was not re-read this session; the plan's references remain documented design references, not measured claims.

### Slice specifications

Small specifications per the slice discipline above, recorded against their existing packages. Decisions recorded 2026-10-03 by the maintainer: spend is **propose-only**; S03 storage is **spec + draft, no rollout**; S01 mediation direction is **per-exec environment config**.

#### S03 — stored requirements (draft implemented, not wired)

- **Evidence today:** `taskRecord()` can only show what each run's input said; nothing records which statements were accepted as requirements, or that one was waived and by whom (inventory, "Stored records").
- **Intended behaviour:** a per-task requirement record. Adding is idempotent for identical content and a refused conflict for different content under the same id (no silent last-write-wins). A waiver needs an actor and a reason, applies once, keeps the requirement visible, and never becomes evidence that it was met. Who may accept or waive is the caller's policy, not the store's.
- **Owning layer / contracts:** Ship (`src/task-requirements.ts`: interface plus memory, file and Nucleus stores). No Neutron or Nucleus change.
- **Migration / recovery:** none required. The store creates its own new table (`ship_task_requirements`, primary key `req_key`) with `CREATE TABLE IF NOT EXISTS`, the same additive pattern as the other stores, so no existing run, parked fingerprint or populated table is altered. Revert is not wiring it; the table is inert and can stay.
- **Independent acceptance (done):** 7 tests across all three stores: idempotent add, conflict refusal, concurrent-writer race on the primary key, waiver rules and exactly-once, per-task ordering, input limits, additive-only SQL. The Nucleus tests use a fake of my own writing, **not a real Nucleus**.
- **Not done, and needed before any rollout:** rehearse on a restored production copy (`docs/UPGRADING.md`); a real-Nucleus run of the primary-key and conditional-update behaviour; wiring into enqueue (record the initial request and each follow-up as requirements) and the run page; authorisation for accept/waive on the existing approval grants; feeding waived/active requirements into `taskRecord()` acceptance; scenarios for two tabs, lost response and steering on a real run.
- **Evidence location:** `src/task-requirements.test.ts`.

#### S01 — environment-supplied Git credential (implemented, off by default)

Spec, evidence and the open prerequisites are in `AUDIT_OPEN.md` (2026-10-02/03 entry). Rollout order: confirm the Sandbox daemon forwards per-exec `env` and the image's git is 2.31+; prove a private-repo clone and push on Forgejo and GitHub through the real sandbox with `SHIP_GIT_CREDENTIAL=env` on a canary worker; observe; only then change the default. Revert is unsetting the variable.

#### S02 — proposed current-versus-candidate batch (**awaiting your approval; nothing run, nothing spent**)

- **Purpose:** a regression comparison on the existing 12-scenario product-journey set. It is **not** a held-out result: these scenarios have been seen, graders amended, and the review grader tuned, so they are a development/regression set. Do not quote it as general quality or market rank.
- **Configurations (exact):** A, current default: native harness, `zai/glm-5.3`, existing project settings. B, candidate: native harness, `anthropic/claude-sonnet-5`, same project settings and prompts. Everything else identical; harness revision and fixture hashes are recorded by the runner. The prompts were tuned against GLM only (docs/MODELS.md), so B is disadvantaged by construction; a loss for B is not evidence about the model.
- **Scope:** 11 scenarios × 3 repeats × 2 configurations = 66 runs. `pj-b-db-migration` is excluded: it stops at an approval the harness will never take (now classified `authority-hold`), so it cannot be graded without an authorised approval path.
- **Preconditions:** your explicit authorisation and cap; a reachable Ship instance, token and `ship-eval-*` scratch repositories (not reachable from this cloud session, so it must run from your side or a session that can reach them); graders copied out of tree; the existing waiting runs untouched; a deterministic preflight and a single-scenario canary per configuration first (`pj-s-question`, n=1).
- **Cost estimate (from retained records, not a guarantee):** at the deployment's `glm-5.3` rate ($1.00 in / $3.20 out per 1M tokens) the ten non-zero priced records average about $0.056 per scenario (min $0.012, max $0.127); A ≈ 33 runs ≈ $1.9 expected, ≈ $4.2 if every run hit the maximum. `claude-sonnet-5` is $3 / $15 per 1M (3× input, 4.7× output), so B is roughly 3–4.7× per run: ≈ $5.5–$8.7 expected, ≈ $19.7 worst case at the maximum. Tokens per run for B are unknown, so this could be off. Proposed hard cap **$25** for the whole batch with an automatic stop when cumulative priced spend reaches it. Unpriced runs count as unknown, never zero; sandbox and host compute are not included.
- **Frozen before running:** primary outcome is first-attempt independent-grader pass count per configuration (raw counts, no significance claims at n=3); secondary are eventual pass, interventions, `authority-hold` count (reported separately), elapsed time, priced and unpriced cost. B may be called "not worse" only if its first-attempt pass count is within one scenario of A's out of 11; otherwise it is reported as worse. A `harness-error` is rerun once with both records kept; a second one is reported as an infrastructure exclusion, not dropped. Time and cost are shown beside quality, not folded into one score.
- **Revert / safety:** the runner denies merges and never approves; scratch repositories only; original results are never overwritten.
- **Evidence location:** `evals/product-journeys/results/` under a new run id, with a dated summary beside it.

#### S18 — executed pair-level integration evidence (contract implemented, executor not built)

- **Evidence today:** `src/coordination.ts` verifies a pair statically with a read-only scan and records `integrationTest: "not-executed (scan is read-only)"`; its header says real pair testing needs a new non-scan kind. The fixture's independent `verify-pair.mjs` exists but is run by hand.
- **Intended behaviour:** a coordination can declare an executed integration test required. It completes only when evidence of class `executed-pair` passed against exactly the current producer and consumer revisions. Static compatibility never satisfies it; an upstream move makes the evidence stale (and says which side moved); failed, not-run and unknown all block and are distinct states. Not declared means nothing changes.
- **Owning layer:** Ship (`src/integration-evidence.ts`, later `src/coordination.ts`). Execution isolation belongs to Sandbox; no Neutron/Nucleus change.
- **Migration / recovery:** none for the contract (pure). Wiring will add an optional field to the coordination record, the same additive pattern its earlier completion work used; an existing record replays unchanged.
- **Independent acceptance (done for the contract):** 8 tests covering each rule above, including newest-wins and failure-wins-ties. **Still to do:** a real producer/consumer run through the executor using `evals/coordination-fixtures/verify-pair.mjs` with its sensitivity controls (original passes `/add` and fails `/sum`; API-only change fails; both changed passes), a racing upstream commit invalidating a passed result, and a deliberately incompatible pair failing.
- **Rollout / revert:** opt-in per coordination, default off; revert is not declaring the requirement.
- **Evidence location:** `src/integration-evidence.test.ts`; live receipts to go under `evals/receipts/`.
