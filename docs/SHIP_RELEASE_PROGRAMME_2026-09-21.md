# Teploy Ship capability and improvement plan

Updated September 30, 2026. End state and execution backlog added October 16, 2026 (see "End state and execution backlog").

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

Input for the agent-perception half (2026-10-14 review round, verified claims,
text-first `look` design, rejected alternatives):
[PERCEPTION_INPUT_S12_S13_2026-10-14.md](PERCEPTION_INPUT_S12_S13_2026-10-14.md).

**Acceptance:** live acquire → human edit/test → handback → agent continuation retains edits and verified revision. Revoke, expiry, reconnect, worker restart and competing ownership fail safely. A full desktop or IDE claim requires an actual supported-target journey.

### S13 Harness capabilities and portability

**Owner:** Ship adapters, upstream SDK as appropriate. **Dependencies:** S02, S06, S11.

Publish capabilities for native, Claude Code and OpenCode: investigation, planning, steering, tools, browser, interruption, approvals, recovery and accounting. Run the same supported journeys across stable configurations and repair prompt/protocol assumptions revealed by differences.

Design the conformance boundary so additional harnesses can join without bypassing policy. Evaluate additional adapters when they add a capability or quality advantage and can be maintained; installation alone is not support.

The OpenCode adapter needs a v2 decision: v2.0.26 removed `--pure`/`--dir`
(current invocation fails flag parse) and added `--session`/`--continue`
(the session-resume hook for steering parity) — details and the 2026-10-14
contract check in
[PERCEPTION_INPUT_S12_S13_2026-10-14.md](PERCEPTION_INPUT_S12_S13_2026-10-14.md) §5.

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

## End state and execution backlog (2026-10-16)

This section turns S01–S28 into a ranked, dependency-ordered backlog with
concrete slices, flags, soaks and gates. It is part of this plan, not a second
one: every slice names the package it advances, and results are recorded in
the execution tables below and in `AUDIT_OPEN.md` as before. Slice IDs here
(A/D/B/C/Q/L/O/X/G) are backlog handles; the package (Sxx) remains the unit of
record. Each slice gets a full specification under "Slice specifications"
when it is picked up (slice discipline above), and that specification freezes
its numeric thresholds and rubric before any acceptance run. The rows here
are the scaffold for that, not a substitute.

Source state at writing: origin/main `dfc7920`, production web+worker
`03748ab` (postgres store), one sandbox host in `SHIP_SANDBOX_URL`,
`SHIP_MAX_RUN_COST_USD` unset (no per-run cap), harness unset (= native), live
flags `SHIP_LOOK=1` + `SHIP_LOOK_IMAGE_MODEL=zai/glm-5.3-flash`, shadows
(`SHIP_BUDGET_RESERVATION`, `SHIP_MODEL_ROUTING`, `SHIP_PLACEMENT`,
`SHIP_TOOL_MANIFEST`, `SHIP_KNOWLEDGE_PROVENANCE`, `SHIP_POLICY_SHADOW`)
recording since 2026-10-04. Slack and Linear signing secrets are set on
production; whether a Slack app or Linear webhook targets them is unverified.
Flag value grammar differs by flag (`SHIP_THREAD_VIEW` accepts only `on`;
`SHIP_DELEGATE` accepts only `1`/`true`/`yes`); every row below states the
value the parser accepts.

### E0 The end state, defined so it can be measured

Ship's end state is one product serving three modes from the same task,
authority and evidence records. Each mode has its own gate; "done" means the
gate passes, not that features exist.

| Mode | What it means | Gate |
| --- | --- | --- |
| Interactive daily driver | Tyler's repo-bound work moves from T3 Code to Ship: ask, steer mid-run, follow up, see the app, merge | G1 daily-driver parity gate (E4) |
| Unattended background agent | Tickets, events and schedules become merged changes without plumbing interventions | G2 overseer metrics. Provisional targets from the private umbrella note `../_internal/ORCHESTRATION_TARGET_STATE.md`: >70% of sent items closed with zero human edits (merged, not reverted in 7 days); <10 interventions per week; auto-merge revert rate <3%; cost per merged PR known per repo. A four-week baseline is measured first and the targets are re-frozen against it (evaluation rules above) |
| Delivery loop | Task → PR → preview → perception check → approved deploy → observation → rollback, with receipts | G3 flagship journey receipt (L4) plus S14/S15/S27 acceptance |

Non-goals for this backlog (amended by E7, 2026-10-17): non-repo desktop automation for its own sake
(computer use exists to verify software Ship builds), a sidebar/sans-serif
redesign (rejected 2026-09-19), and building a feature because a competitor
names it (slice discipline). Cross-provider fan-out and simulator/device work
stay in T3 Code for now: simulator/device targets (C6, C7) wait on Decision 8,
and wider agent coverage (D8) and per-child model routes (C4 after Q9) wait
on evidence.

### E1 Competitive position, verified 2026-10-16

Ship side verified against source at `dfc7920` and production; competitor
side from official docs and releases checked 2026-10-16 (Devin release notes
Jul 1 – Oct 14 2026 and docs; Vorflux landing page only, it publishes no docs
or changelog; T3 Code repo and v0.1.0 release of 2026-10-15). Competitor
documentation is a reference capability, not measured quality.

| Dimension | Ship today | Devin | Vorflux | T3 Code |
| --- | --- | --- | --- | --- |
| MCP client | None in the loop; S24 manifest is shadow-only | Yes, org config, one-click OAuth servers, admin allowlist | Unverified | Yes (client and server) |
| Mid-run steering | One-way notes into the native loop (`durable.ts:2066`); refused for claude-code/opencode | Side chats, Slack thread follow-ups, voice, terminal tab | Unverified | Steer-or-queue server queue |
| Delegation | `SHIP_DELEGATE` off; depth 1, cap 2 (ceiling 16), one box | Nested sub-sessions inheriting context | Parallel sub-agents, cross-lab planner/reviewer | `delegate_task` to any provider/model, fork/merge-back |
| Compute | Static Linux container pool, one host | Cloud VMs XS–XL, Windows (limited), macOS, Outposts | Dedicated cloud machines priced per hour | The user's own machines |
| Integrations | Slack/Linear/GitHub/Forgejo/Observe intake; Slack/webhook out | Slack, Teams, Linear, Jira, GitHub/GitLab/Bitbucket/Azure, PagerDuty | Slack, Linear, GitHub, Jira, Sentry, Datadog | GitHub PRs incl. stacked |
| Skills/knowledge | Per-repo playbook (`SHIP.md`/`AGENTS.md`/`CLAUDE.md`, 4k chars) + run notes; S21 provenance shadow | Skills, playbooks, memory with nightly consolidation | Harness practices + memory | The provider's own |
| Event triggers | CI failure on Ship PRs, PR comments/reviews, labelled issues, Observe alerts, interval/`at` schedules | Schedules, webhooks, GitLab/Jira/PagerDuty/Slack triggers, PR autoreview | Schedules, webhooks, Sentry | Schedules, webhooks, PR watch |
| Perception | Browser text + image `look` live; takeover console/editor/browser | Linux desktop + Windows desktop computer use, recordings | Browser QA with video on the PR | Browser preview tools, simulator/emulator control |
| Harnesses | native, claude-code, opencode 1.x (v2 refused); no Codex | Devin only | Own harness; Codex subscription accepted | Claude Code, Codex, Cursor, OpenCode 2, Grok, Pi, any ACP agent |
| Governance/evidence | Plan parks, merge gates, exact-revision evidence, graders, receipts, routing data gates | Admin controls, autoreview | Merge-risk score with block threshold | None of its own |
| Self-host | Full control plane | Enterprise VPC, Outposts (sales-gated) | Not found | Local, MIT |
| Cost | ~$0.012–0.127 per run priced on glm-5.3, compute excluded | ACU plans | Server per hour + per-token platform fee | Free; bring subscriptions |

Ship leads on governance/evidence and full self-hosted control, and is the
only one that owns a deploy path. It trails T3 Code on interactive control
and harness breadth (T3's v0.1.0 shipped steering, cross-provider delegation,
PR watch and webhooks on 2026-10-15), and trails Devin on compute targets,
trigger breadth and skills.

### E2 Activation ladder — turning on what is already built

A large part of the end state is merged code that is off. Each flip below
earns its own one-run soak on the 2026-10-16 pattern (`docs/SOAK_2026-10-16.md`
§7): verified backup, rebuilt `dist` and web build, coordinated redeploy (env
is baked at container create), waiting runs intact, a receipt under
`evals/receipts/`. Revert is always unsetting the flag and redeploying.

| ID | Flag or item | Package | Prerequisite | One-run soak | Pass criteria |
| --- | --- | --- | --- | --- | --- |
| A0 | `scripts/ship-backup.sh` postgres support | S19 | none | Back up and rehearse a restore of the live store | Archive + sha256 + rehearsal receipt; every later flip depends on it |
| A1 | `SHIP_THREAD_VIEW=on` (web only; `1` leaves it off) | S03 | A0 | One task, two steering notes mid-run | Thread API no longer 503; notes and agent turns in order; worker logs unchanged |
| A2 | Shadow review: policy, placement, tool manifest, knowledge provenance, budget reservation, model routing | S11, S21, S23–S26 | 12+ days of shadow logs | `policy shadow-report`, `placement shadow-report`, worker-log routing selections, provenance/manifest JSONL | A written disposition per shadow (stay shadow / build the missing piece / promote). Two are pre-decided: `SHIP_BUDGET_RESERVATION=on` is refused off the file runtime, so it stays shadow until C8; `SHIP_MODEL_ROUTING=on` would refuse every private-repo run under Decision 1, so it stays shadow until Q9 (Decision 1 here is the existing 2026-10-05 routing decision) |
| A3 | `SHIP_SAFE_FETCH=on` (default is shadow) | S01 | A2 log review | One run that fetches from a forge | No false refusals in the reviewed shadow log; real forge calls pass |
| A4 | `SHIP_MAX_RUN_COST_USD` set, `SHIP_MAX_CONCURRENT_RUNS` pinned, then `SHIP_DELEGATE=1` on web and worker (materialised at enqueue, and the web container enqueues UI tasks), `SHIP_DELEGATE_MAX=2` | S22, S11 | A0 | One task that splits into two independent parts | Two children run in turn (a delegate action spawns one child and the parent parks, releasing its slot, `docs/DEPLOY.md` `SHIP_DELEGATE`); each child is a browser-class run while `SHIP_LOOK=1` (~0.9 GB, `src/resource-class.ts:36,41`) and the parked parent's container can stay on the host until restore (`durable.ts:2681`) while admission counts only in-flight runs, so sandbox host free memory is sampled through the run and never falls below 300 MB; a forced grandchild attempt refused (`DELEGATE_CHILD_REFUSED`); child results arrive as context transfers; each run under the cap (the cap is per run, so a tree can spend 3× it until C8 adds child scopes); the parent's PR parks at approve-merge and any child PRs are listed in the receipt |
| A5 | `SHIP_PLAN_GROUNDING=on`, `SHIP_FINDING_CONTINUITY=on`, `SHIP_TEST_INTEGRITY_SURFACING=shadow`→`on` | S07–S09 | A0 | One plan-parked change run; two review runs on successive revisions of one PR (continuity only affects review runs); replay of a run parked at approve-merge from before the change | Advisory blocks render with correct content; continuity classifies the second review against the first; the pre-change parked run resumes and completes. Surfacing reads the environment at publish rather than from the run input (`durable.ts:3258`) and can add a `verification` step the fingerprint check admits unflagged, so that replay is the check that matters; integrity shadow log reviewed before `on` |
| A6 | `SHIP_SCHEDULE_OVERLAP=on` | S16 | A0 | One schedule whose interval is shorter than its run | Overlap `skip` observed; no duplicate run |
| A7 | `SHIP_MISSION_VIEW=on`, `SHIP_STACK_DETECT=on`, `SHIP_HARNESS_RECORD=on` | S22, S05, S13 | A0 | Open a coordination page, a setup page, one run page | Read-only views render on real data; no behaviour change |
| A8 | `SHIP_GIT_CREDENTIAL=env` live proof then default flip | S01 | teploy-sandbox daemon per-exec env forwarding and sandbox image git ≥ 2.31 (verify; fix in teploy-sandbox if absent — wave 7 ops) | Private-repo clone + push on Forgejo and GitHub | Token absent from argv, config, logs and snapshot (existing S01 spec) |
| A9 | `SHIP_DEPLOY_ADAPTER=teploy` live proof | S27 | scratch destination provisioned on compute-1 (wave 7 ops) | One approved deploy + readback + rollback | Approved bytes reach the target and read back (existing S27 row) |

Needing code before any flip: `SHIP_INTEGRATION_CHECK` (worker tree
provisioning, X5), `SHIP_TOOL_MANIFEST=on` (executor must report host/secret
effects; folds into D1), `SHIP_MODEL_ROUTING=on` (Q9). Preview is requested
by `SHIP_PREVIEW` (environment or published deployment asks) or by
`project.verification.preview` (`src/runtime.ts:1242`), and only runs with
`SHIP_PREVIEW_DIR` on the worker; until L3 lands, withhold all three.

### E3 Build backlog

Size is a rough guide (S under a day, M a few days, L a week or more of
agent-lane work); it is replaced by the slice specification's own estimate.
"Verify first" means part of it may exist and the slice starts by measuring
the gap. New flag names were checked against source on 2026-10-16 and do not
collide; where a near-neighbour exists the slice extends it.

**D — interactive daily driver (gate G1).** Production runs the native loop,
so interactive work lands there first; harness adapters follow.

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | MCP client in the native loop: servers declared per project through the S24 manifest (stdio inside the sandbox, remote HTTP through the egress allowlist), tools exposed with declared effects; read-only by default, write tools need a grant; secrets via the credential layer; remote servers inherit the routing data-class gate | S24, S13, S01 | A2; Decision 6 for remote servers | `SHIP_MCP` | A run calls a declared MCP tool; an undeclared tool and an injected instruction in tool output are refused; per-call latency/cost recorded; default-off equivalence | L |
| D2 | Two-way steering: the agent can reply into the thread; each operator message is steer-now or queue-for-next-turn; interrupt the current action | S03, S13 | A1 | `SHIP_STEER_REPLY` | A mid-run question is answered without restarting the run; a queued message is applied at the next turn and not before; an interrupt during a command leaves the run in a state whose external effects are read back and recorded as done, not done or unknown (S11) | M |
| D3 | Follow-up continuity (verify first: follow-ups exist and target the existing PR, `docs/WORKSPACE.md:46-50`): measure whether the follow-up carries enough prior context | S03 | none | none expected | A follow-up on a finished run edits the same PR from the recorded head without the requester restating context; gap list recorded if not | S–M |
| D4 | Interactive latency: extend `SHIP_WARM_CACHE`/`SHIP_WARM_PARKS` into a warm workspace per thread; record time-to-first-edit and wall time (S28). Plan review is unchanged for change tasks; only read-only modes may run without a plan park, under an explicit project policy, never by classifying the request | S06, S11, S28 | none | extends existing warm flags | Wall time to a correct result on the G1 set within the E4 threshold; plan floor unchanged for every change task (negative control: a "trivial" change request still parks) | M |
| D5 | Live view: read-only terminal stream and running diff on the run page | S12, S10 | A1 | none (read-only) | p95 delay from sandbox output to page ≤ 5 s on the soak run; diff matches the workspace tree at the same instant | M |
| D6 | OpenCode v2 adapter + `--session` resume steering (contract in `evals/receipts/2026-10-14-opencode-v2-events.txt`) | S13 | none | per-project harness | v2 passes the declared journeys; steering consumed via session resume; v1 path retained until parity | M |
| D7 | Claude Code steering through session resume | S13 | D2 | per-project harness | Steering notes reach a claude-code run; capability table updated from `refused` | S–M |
| D9 | Fork a run and stacked PRs | S03, S09 | D3 | none | A fork keeps its parent's history; a stacked PR rebases correctly when its base merges | M |
| D10 | Mobile-usable run/thread pages + push notifications for parks and finished runs | S04, S10 | A1 | none | 390px run/thread journey passes `ui-audit`; a park notification arrives and its deep link opens the decision | S–M |
| D11 | User-facing live preview of the app under change | S08, S04 | L3 | `SHIP_PREVIEW_VIEW` | Revision-bound preview reachable only by project members; stale preview refused | M |

**B — background autonomy and events (gate G2).**

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | PR watch (verify first: CI-failure and review intake exist): add conflicts and check status on Ship's own open PRs waking the owning task, with bounded polling for forges without webhooks | S16, S09 | none | `SHIP_PR_WATCH` | A merge conflict and a failing check each produce exactly one revision on the same PR; zero model calls while a watched PR is idle | M |
| B2 | Generic event rules: typed event → condition → task template, dedupe/debounce, dry run; signed intake reuses the `SHIP_EVENT_ENVELOPE` format | S16, S24 | B1 | `SHIP_EVENT_RULES` | Duplicate and out-of-order events produce one task; dry run shows the would-be task | M–L |
| B3 | `at` schedule UI and API (maths exists, `src/schedule-time.ts`) | S16 | A6 | none | Create/edit/pause an `at` schedule; DST case correct | S |
| B4 | Slack thread conversation: replies in the thread steer the bound run; results post back to the thread | S04, S25 | D2, B6, Slack-user to Ship-user mapping with revocation | none | A mapped user's thread reply reaches the run as steering; an unmapped or revoked user's reply is refused; result appears in thread | M |
| B5 | Standing tasks: reusable maintenance templates (dependency updates, flaky-test triage) | S16, S24 | B2 | none | A standing task runs on schedule, delivers, and can be paused/retired | M |
| B6 | Slack/Linear as user features (Decision 7, 2026-10-16: not wired for the owner): real-path proof of both intakes with signed payloads and the outbound Slack webhook, plus a user setup guide (app scopes, URLs, secrets) | S04 | none | none | A signed Slack mention and a signed labelled Linear issue each become exactly one task through the real routes; a bad signature is refused; the guide is followed verbatim on a fresh install | S |

**C — capacity and compute.**

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Second sandbox host (Proxmox VM) added to `SHIP_SANDBOX_URL` | S26 | Decision 4 | none | Least-loaded placement uses both; one host down still admits work | S |
| C2 | Host drain; liveness failure distinguished from TTL expiry | S26 | C1 | none | Draining host finishes runs and takes no new ones; dead host is reported as such | M |
| C4 | Delegation depth 2 and children across hosts; per-child model route once Q9 lands | S22, S23 | A4, C1, C8; Q9 for model routes | `SHIP_DELEGATE_DEPTH` | Measured against the serial baseline before any default change (S22 acceptance) | M |
| C5 | Linux desktop target (Xvfb + VNC) for computer use beyond the browser | S12, S26 | C1 | target capability | A desktop-app journey completes with perception evidence | L |
| C8 | Cross-process budget reservation on the postgres store (conditional write), with parent/child scopes and lease fencing | S11 | none | `SHIP_BUDGET_RESERVATION=on` | Two workers cannot double-reserve; a delegation tree is bounded by one reservation | M |

**Q — quality and verification depth.**

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | Cross-vendor critique: a second model from a different vendor reviews the plan at the park and the diff before the merge park (S07 "independent critiques when they improve measured outcomes") | S07, S09, S23 | Q9 for private repos | `SHIP_CROSS_REVIEW` | Measured on the S02 set against single-model; promoted only if first-attempt pass count rises with no added false holds | M |
| Q3 | Session recordings as revision-bound run artifacts the PR links to (S08 "tie previews, screenshots and recordings to the actual revision"). Never uploaded to the PR: the look-image class is refused by `uploadPrAsset` and an image on a PR is a soak defect | S08 | none | `SHIP_LOOK_RECORD` | Recording bound to the revision and visible only to project members; retention rule applies; PR body carries a link, no asset | S–M |
| Q4 | Skills registry across repositories: versioned instruction skills with provenance and per-project enablement; skills never grant authority | S24, S21 | D1 | none | A skill applies in two repos; a skill instructing a privileged action is refused | M |
| Q5 | Memory consolidation of run notes into verified/decided/tentative knowledge | S21 | A2 | `SHIP_KNOWLEDGE_PROVENANCE=on` | Per S21 acceptance, against a retrieval baseline measured before the change on a frozen question set | M |
| Q6 | Stored requirements write path, accept/waive (existing S03 spec) | S03 | none | none | Per the S03 slice specification | M |
| Q7 | Held-out evaluation set and the B leg of S02 | S02 | Decision 5 | none | Per S02 acceptance | M |
| Q9 | Routing `on`: the tool-call journal from `durable.ts` (mid-run switches) and a destination permitted for `private` data (a provider with explicit no-retention terms, or local inference) | S23 | Decision 9 | `SHIP_MODEL_ROUTING=on` | A private-repo run routes to a permitted destination; a disallowed destination is refused; fixed-vs-routed comparison per S23 | M |

**L — delivery loop (the lead no competitor has).**

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | = A8 (git credential) | S01 | | | | |
| L2 | = A9 (TeployAdapter live) | S27 | | | | |
| L3 | Preview isolation in teploy-cli (AUDIT_OPEN mitigation proposal) | S04, S01 | none | none | Preview egress and lateral probes pass under declared policy | M |
| L4 | Flagship journey: task → PR → preview → `look` check → approved deploy → observation → rollback, one receipt | S14, S15, S27 | L1–L3 | existing flags | One end-to-end receipt with exact revisions and readback, including an injected regression rolled back | M |

**O — organisation and distribution.**

| ID | Slice | Package | Depends | Flag | Acceptance | Size |
| --- | --- | --- | --- | --- | --- | --- |
| O1 | Forgejo OIDC SSO wiring (documented in `docs/DEPLOY.md`) | S25 | none | existing OIDC config | Login through Forgejo; role mapping applied; bootstrap stays break-glass | S |
| O2 | First-run setup wizard for self-hosters | S05, S19 | none | none | Fresh install reaches a first useful task through the UI (S05 acceptance) | M |
| O3 | Streaming lifecycle API: subscribe with cursor/reconnect (today `docs/HTTP_CLIENT.md` is a recorded view, not a stream) | S24 | none | none | An independent client follows a run live and resumes after disconnect | M |
| O4 | Generated flag reference: a flag is an environment key the code reads (~163 such names on 2026-10-16, against 93 mentioned in `docs/DEPLOY.md`) | S19 | none | none | CI fails when a read environment key has no reference entry | S |

**X — remaining package acceptance with no slice yet.** These are required
by the package text above and were unscheduled; each needs its own slice
specification when picked up.

| ID | Slice | Package | Depends | Size |
| --- | --- | --- | --- | --- |
| X1 | Two-user project isolation, hostile imported context (repo, web page, issue, tool response, memory) and secret-exfiltration probes | S01 | D1 (MCP adds a context source) | M |
| X2 | Offline/error states, other roles, screen readers; five real-user observations including three less-technical users | S10 | D10 | M |
| X3 | The outstanding extended deployment observation | S15 | L4 | S |
| X4 | Incident loop wiring: `recovery-compat.ts` and `incident-evidence.ts` into the Observe intake path, one seeded incident to verified recovery | S17 | L4 | M |
| X5 | Worker tree provisioning for `SHIP_INTEGRATION_CHECK`, then one recorded producer/consumer run | S18 | none | M |
| X6 | Fresh-machine install to first verified work, and an off-host restore | S19 | A0, O2 | M |
| X7 | Claim ledger check in CI (`scripts/claim-ledger.mjs --check`) and the seeded claims verified or withdrawn | S20 | none | S |
| X8 | One multi-repository mission with integration evidence | S22 | C4, X5 | L |
| X9 | Policy inheritance enforcement at the decision points the shadow covers | S25 | A2 | M |
| X10 | Recipe acceptance: fresh and cached setup, startup, tests, preview, cleanup per advertised recipe | S05, S06 | A7 | M |
| X11 | Postgres-move leftovers: correct the stale 2026-10-14 AUDIT_OPEN line (production now runs postgres), `doctor` store probes keyed on `NUCLEUS_URL`, the templates catalog default flip | S19 | none | S |
| X12 | G2 telemetry: intervention log with a frozen plumbing/non-plumbing rubric, seven-day revert tracking per merged PR, and enabling auto-merge/governance auto windows on one repo so a revert rate exists | S28, S09 | A0, Decision 10 | M |

**Deferred** — in scope for the product, not scheduled; each is picked up
only after its E6 decision or the named evidence: C3 elastic Proxmox
provisioning (Decision 4, after C2); C6 Windows then macOS targets and C7
mobile simulator/emulator (Decision 8); D8 ACP adapter covering further
agents (after D6 shows adapter cost); L5 an external delivery adapter (after
L4); Q2 merge-risk score (only if Q1 data shows reviewers need a summary
score — no missing responsibility is demonstrated today); Q8 controlled
self-improvement on teploy-ship (after Q7 provides a held-out set).

**G — gates.**

| ID | Gate | Depends | Acceptance |
| --- | --- | --- | --- |
| G1 | Daily-driver parity gate (E4) | D1–D5 on; D7 on for the diagnostic arm's steering task | Frozen spec, receipts for every arm |
| G2 | Overseer metrics on the Projects page | X12, four-week baseline | Values trace to recorded attempts; missing telemetry shown as unknown; targets re-frozen after baseline, then met four consecutive weeks |
| G3 | Flagship receipt | L4 | As L4 |
| G4 | Competitive refresh each quarter into E1 | none | E1 re-dated with sources |

### E4 Daily-driver parity gate (G1)

Freeze before running, per the evaluation rules above.

- **Task capture (now, before D-track work can tune to it):** 12 tasks from
  Tyler's last 30 days of T3 Code threads across at least four repositories
  (teploy-ship, akiroo, Neutron, one site): two questions, three bug fixes,
  three features, one refactor, two UI changes with a visual check, one
  multi-file change that needed mid-run steering. Capture per task: the
  starting commit, the opening prompt, every later operator message from the
  T3 thread as a numbered steering script, and acceptance checks written
  from the resolving commit before any arm runs.
- **Arms:** T3 Code re-run fresh on the starting commit with the agent Tyler
  used (not historical results). **Primary Ship arm:** native on `glm-5.3`
  (the production configuration Tyler would use daily). **Diagnostic arm:**
  Ship with the claude-code harness on the T3 model, to separate product
  from model; it applies only when that model has a Ship harness, and its
  steering task waits for D7.
- **Steering rule:** an arm may receive only messages from the task's
  steering script, at most once each. "Steering need resolved" means the arm
  reached a correct result using script messages only; any other operator
  input is an intervention.
- **Grading:** acceptance checks run where they exist. For the rest, a model
  from a vendor not used by any arm grades diffs normalised to remove arm
  identity (Verification sections, branch names, commit trailers stripped)
  against the frozen checks; Tyler reviews the same normalised diffs. Both
  verdicts are recorded; disagreement is kept.
- **Measures:** correctness per task; wall time to a correct result
  (primary time measure); time-to-first-edit (diagnostic); steering messages
  used; interventions; priced and unpriced cost.
- **Pass (primary arm against T3):** correct on at least 10/12; paired
  outcome counts reported (both correct / Ship only / T3 only / neither) with
  "Ship only" ≥ "T3 only"; median wall time to a correct result ≤ 1.5× T3;
  zero interventions on tasks graded correct. Raw counts only at n=12; no
  significance claims.
- **Spend:** the T3 re-run and the diagnostic arm use real subscription or
  API quota and are owner-gated like the S02 B leg (Decision 5).

### E5 Waves

Each wave runs as parallel worktree lanes under the working rules in
`NEXT_SESSION.md` (one branch and PR per slice, merge on green CI, default-off
equivalence, real-path test, negative control). A slice's flip is a separate
one-run soak after its merge.

| Wave | Activation and ops | Code lanes | Exit |
| --- | --- | --- | --- |
| 6 | A0, A1, A2, B6, C1, X11; capture the G1 task set | D1, D2, D3, X7 | A1 receipt; A2 dispositions; D1/D2 merged off |
| 7 | A3, A4, A5, A6, A7; flip D1, D2; ops for A8/A9 prerequisites | D4, D5, B1, C8, X5, X12 | A4 receipt; D1/D2 soak receipts |
| 8 | A8, A9; flip D3 (if any code), D4, D5, B1, C8 (`SHIP_BUDGET_RESERVATION=on`) | D6, D7, B2, B3, Q1 (public repos until Q9), Q3, L3, Q9 | D-track flips' receipts; G2 baseline starts |
| 9 | flip D6, D7, B2, Q9 | L4, B4, C2, C4, Q6, O1, O3, X1, X9, X10 | D7 flip receipt before the **G1 run**; **G3 flagship receipt** |
| 10+ | as earned, including measured flips of Q1 and Q3 | C5, D9, D10, D11, Q4, Q5, Q7, B5, O2, O4, X2, X3, X4, X6, X8; deferred items once unblocked | G2 targets met over four consecutive weeks |

### E6 Owner decisions this backlog needs

Numbered to continue `docs/DECISIONS_OPEN_2026-10-04.md` (Decisions 1–3 are
already taken there) and recorded in that file when made.

4. **Decided 2026-10-16: compute-2.** Which Proxmox node hosts the second sandbox (C1), and whether elastic VMs
   (C3, deferred) may consume cluster capacity unattended.
5. Spend for the G1 T3 re-run and diagnostic arm, and the S02 B leg (Q7).
6. Whether remote MCP servers (D1) may receive `private` repository data, or
   inherit the routing data-class gate as proposed.
7. **Decided 2026-10-16: not wired for the owner; user feature only.** Slack workspace and Linear team to wire (B6).
8. Windows/macOS/mobile targets (C6, C7): schedule this year or keep deferred.
9. **Decided 2026-10-16: the z.ai coding plan** (routing policy updated on infra-home). A destination permitted for `private` data (Q9): a provider whose terms
   state no retention, local inference on the cluster, or keep routing
   shadow-only. Decision 1 (2026-10-05) stands until this is made; it blocks
   Q1 on private repositories and routing `on`.
10. Which repository gets auto-merge/governance auto windows first (X12), so
   the G2 revert-rate measure has data.

### E7 Design round 2026-10-17: harness breadth, cross-provider delegation, triggers, perception, latency, skills

Owner direction 2026-10-17: Ship should serve other people's agents and
workflows, not only the owner's. Harness breadth (Cursor, Grok Build, Pi,
Gemini CLI, any ACP agent) and cross-provider delegation are in scope now; the
Observe incident loop leads the trigger work; T3 Code (MIT) is the reference
architecture, ported with attribution where it fits a remote, sandboxed
server. Five design notes were written against source (Ship at `4b13601`,
T3 Code nightly `v0.1.1-nightly.20261016.3218`, teploy-observe main) and
spot-checked by the coordinator; their slice tables are condensed here. The
full notes are private (`_internal/ship-design-2026-10-17/`).

This section amends E0, E3 and E5 where it says so. The end-state non-goal
"cross-provider fan-out stays in T3 Code" is withdrawn.

#### E7.1 Corrections to earlier sections

- **E0/E3 D4:** plan parks are not the latency floor. A change run parks only
  when the project or task asks (`requirePlanReview`), and scans never park
  (`src/runtime.ts:1397`). Latency is setup: worker poll, sandbox create,
  clone, index, baseline tests. No phase timing exists yet, so D4 starts by
  measuring.
- **Follow-ups are always cold.** Every follow-up boots a fresh sandbox and
  the warm cache is off for runs on an existing PR (`src/runtime.ts:1425`),
  which is what a follow-up is. This is the largest single daily-driver gap.
- **Per-child model choice does not need Q9.** Choosing a child's model is a
  fresh selection; the destination and retention gate (`whyNot`) already
  exists and can run per child with routing off. Q9's journal is only for
  mid-run switches. The real prerequisite: a native worker runs every run on
  one model built at start (`src/cli.ts:2195`); the run's model is used only
  for pricing. DT1 fixes that.
- **T3's merge-back merges conversation context, not code.** Ship's context
  transfer already does that; merging child diffs into one PR is Ship's own
  design (DT6).
- **The workspace snapshot is host-local** (`docker commit` on one sandbox
  host); `src/snapshot.ts` is the store backup tool. Fork inherits through git.
- **The delegation ledger claim locks within one process** (`withFileLock`);
  it moves to the store's `setNX` before depth 2 (DT5).
- **Observe intake does not match the live sender.** Observe's outbox sends
  `NotificationPayload` (`kind`, `incident_id`, `rule_id`, no `alert_id`;
  `teploy-observe/internal/platform/notify_outbox.go:720`) with an
  `X-Observe-Delivery` id. `/hooks/observe` skips payloads without
  `alert_id` (`web/src/routes/hooks/observe.tsx:78`), and the incident
  receiver ignores `kind`, so a recovery notice reads as a re-fire. EV0.
- **Artifacts and recordings.** The flow rung already records WebM against the
  exact preview revision (`src/ladder-steps.ts:380`). Artifacts carry no run
  or revision binding, and when the artifact store fails, untagged assets fall
  back to forge PR attachments (`src/durable.ts:4146`). Q3a.
- **External harness credentials** travel through a workspace file sourced and
  removed in one command (`src/harness-external.ts:1218-1220`), and output
  scrubbing is pattern-based (`src/redact.ts`), so a bare provider key in a
  shape no rule knows is not scrubbed. H1.
- **E1 harness row is stale:** codex and opencode v2 adapters are merged
  (#100, #101); steering is live for native, claude-code and opencode v2.

#### E7.2 Slices

Sizes and acceptance are the design notes'; each slice still gets a frozen
specification when picked up. Flag names were grepped clean across `src`,
`web/src`, `scripts` and `docs`. "Neg" lists the negative controls that must
pass.

**W0 — fixes and measurement, no new behaviour flag**

| ID | Slice | Depends | Acceptance (Neg) | Size |
| --- | --- | --- | --- | --- |
| EV0 | Both Observe receivers correct against the live outbox: key `observe:rule:<rule_id>:<incident_id>`, dedupe on `X-Observe-Delivery`, honour `kind` | none | A real `incident_opened` creates one task; five retries of one delivery create one. Neg: `incident_recovered` creates no task and never reopens; wrong secret 401; outside the 300 s window 401 | S |
| Q3a | Bind artifacts to run and revision, a `recording` data class `uploadPrAsset` refuses, no forge fallback for media, one run-access check on the download route, `no-store` | none | A new recording carries runId and revision and is linked, not attached. Neg: a user without access to the run gets 404; a store failure fails the upload instead of attaching; pre-binding artifacts are admin-only | S–M |
| H1 | Harness credentials by exec env (daemon already accepts `env`; the `@neutron-build/agents` executor must send it), exact-value scrub of harness stdout/stderr before parse, record and live view | none | Token absent from workspace files, argv, event log, live view and snapshot on a run that prints `env`. Neg: a planted bare key in output is scrubbed | M |
| D4-a | Phase timing, time to first token (TTFT) and first edit (TTFE), worker claim time | none | Fixture logs give exact phase gaps; a missing timestamp yields null with a reason, never 0; then a cold vs warm-template baseline receipt on the G1 repos | S |
| D4-b | Plan-floor pins (tests only) | none | With `requirePlanReview`, "fix a typo" still parks, including with thread warmth present; a scan never parks | S |
| DT1 | Per-run model for the native harness, materialised at enqueue like `lookImage` | none | A run with `input.model` executes and is priced on it. Neg: a run without it is byte-identical (fingerprint pinned) | S |

**W1 — daily driver**

| ID | Slice | Flag | Depends | Acceptance (Neg) | Size |
| --- | --- | --- | --- | --- | --- |
| D4-c | Thread snapshot at end of turn; follow-up boots from it, fetches instead of cloning; cold fallback on any mismatch | `SHIP_WARM_THREAD`, `SHIP_WARM_THREAD_TTL_SEC` | D4-a, D4-b | TTFT improves against the baseline. Neg: a credential file in the workspace means no snapshot; removed host, expired record or egress digest mismatch each give a cold run that completes; flag off byte-identical. First test: snapshot retains `.git` and an uncommitted file under gVisor (the sandbox README and commit `2a89f72` disagree on warm volumes) | M |
| DT2 | Delegate targets: `target=` from `SHIP_DELEGATE_TARGETS` ∩ project list, per-child destination/retention gate run whatever the routing mode, host check for external harnesses | `SHIP_DELEGATE_TARGETS` | DT1 | Allowed target spawns with a routing segment. Neg: unlisted target, disallowed destination, unknown retention for private data, no policy file, harness host mismatch: each refused by name | M |
| DT3 | Child cap = min(per-run cap, parent remaining), narrow only | under `SHIP_DELEGATE` | DT2 | Neg: an input cap above config never widens; a parent with nothing left gets `budget-insufficient` | S |
| DT4 | Child `needs-input` relayed to the parent as an observation | under `SHIP_DELEGATE` | none | Neg: child `ask` still refused; no child park recorded | S |
| DF1 | Fork a run: source history via follow-up context, new branch from the source's pushed SHA, own PR | `SHIP_FORK` | D3 | Neg: forking an in-flight run refused; source PR untouched | M |
| DS1 | Stacked PRs: open against `ship/<base>`; when the base squash-merges, retarget and `rebase --onto` the recorded old base head | `SHIP_STACKED_PRS` | B1 | Diff holds only its own commits. Neg: conflict aborts and parks with files; base closed unmerged proposes nothing; duplicate sweep one task | M |
| Q3b | Look-session CDP screencast as a run-page recording (context, not PR proof: `look` cannot click and runs before commit) | `SHIP_LOOK_RECORD` | Q3a | Recording bound to the snapshot it observed, ≤ 4 MiB, 7-day retention. Neg: never linked from the PR as verification | M |
| Q3c | Withhold any recording whose page text contains a configured secret value | rides Q3a/Q3b | Q3a | Neg: a page printing a seeded secret yields no stored recording and a recorded refusal | S |
| Q4-a | Skills registry: SKILL.md format, version-pinned, per-project enablement, permission-granting frontmatter stripped and recorded, materialised at enqueue | `SHIP_SKILLS` | A2 S21 disposition | One skill in two projects at the pinned version; not in a third. Neg: editing a skill does not change an in-flight run; flag off byte-identical | M |
| Q4-b | Native progressive loading: index in context, body via a `skill` action inside the turn step | `SHIP_SKILLS` | Q4-a | Neg: a skill saying "push to main" fails for want of a credential; a skill asking to print keys finds nothing; logs without skills parse as before | M |
| Q4-c | claude-code pass-through via `--plugin-dir` (probe-gated); record repo `.claude/skills` loading, which happens unmanaged today | `SHIP_SKILLS` | Q4-a | A registry skill invocable in a live claude-code run. Neg: `repoSkills: "deny"` with claude-code refused at enqueue | S |

**W2 — triggers and the Observe loop**

| ID | Slice | Flag | Depends | Acceptance (Neg) | Size |
| --- | --- | --- | --- | --- | --- |
| EV1 | teploy-observe: `issue_new`, `issue_regression`, `issue_spike` notices on the signed outbox with fingerprint, release, environment, counts, first/last seen, scrubbed stack ≤ 2 KB; an issue read endpoint for recovery checks | Observe webhook `kinds` | none | One seeded error, one `issue_new`; resolve and re-error, one regression; a burst, at most one spike per hour. Neg: a webhook without `issue_*` kinds gets none; Slack never gets a stack; full emitter drops and counts, ingest latency unchanged | M |
| EV5 | Wire `incident-evidence.ts` into diagnosis; deploy correlation as hypothesis only | `SHIP_INCIDENT_EVIDENCE` | EV0 | Facts, hypotheses, unknowns framed. Neg: another service's numbers set aside; an uncited causal claim downgraded; two-project attribution parks | M |
| EV6 | Reproducing-test gate on remediation: test fails on base, passes on head | `SHIP_INCIDENT_FIX` | EV5 | Neg: no test change held; passes on base held; no test command held as unavailable; pre-flag runs replay byte-identically | M |
| EV2 | Event-rule engine in front of existing intake: typed event, condition, task template; dedupe at delivery id, episode key and task claim; stale ordering recorded not acted on; dry run; per-source HMAC and replay window; rate limits | `SHIP_EVENT_RULES=off\|shadow\|on` | B1 | One task per duplicate or re-delivered event; resolved-before-triggered gives zero. Neg: bad signature or stale timestamp 401, nothing stored; over-rate parks; shared-secret source with an `auto` rule refused at save | M–L |
| EV3 | Built-in sources (Slack, Linear, CI, review, Observe, schedules) as rule sources in shadow | `SHIP_EVENT_RULES=shadow` | EV2 | One week with zero diffs against today's path. Neg: an injected divergence is logged and the old path wins | M |
| EV4 | Vendor adapters as payload mappers: Sentry, Datadog, PagerDuty v3, Jira, GitLab | under `SHIP_EVENT_RULES` | EV2 | Each vendor's documented example verifies and maps. Neg: mutated body 401; payload without a dedupe id 400; stale secondary delivery ignored | M |
| EV9 | Standing tasks (B5): templates on schedules, pause, retire | none | EV2 | Fires, plan-parks, digest lists the PR. Neg: paused slot creates nothing; two failures of one test fire flaky triage once | M |

**W3 — harness breadth**

| ID | Slice | Flag | Depends | Acceptance (Neg) | Size |
| --- | --- | --- | --- | --- | --- |
| H0 | Contract receipts per agent at pinned versions (`initialize` and a full session), egress measured from an empty allowlist; records D6 adapter cost (opens D8) | none | D6 | Receipts under `evals/receipts/` | S |
| H2 | Sealed credential store per project and profile, refused at enqueue when missing or when encryption is unset; data-destination gate at enqueue for every external harness, existing ones included | `SHIP_HARNESS_CRED` | H1 | Neg: missing credential refused at enqueue; destination outside policy refused | M |
| H3 | `ship-acp` in-sandbox driver plus `src/harness-acp.ts`: the whole ACP session runs inside one exec (exec has no stdin), permission requests answered by a ported policy (workspace writes only, symlink-safe, never allow-always), non-root agent user | `SHIP_ACP_HARNESS` | H0, H1 | Declared journey on a mock peer and one real agent. Neg: a write outside the workspace denied; allow-always never granted | L |
| H4 | Gemini CLI and Grok profiles, API keys | under `SHIP_ACP_HARNESS` | H2, H3 | Declared journey per agent on real binaries | M |
| H5 | Steering via ACP `session/load`, interrupt via control file | `SHIP_ACP_CONTROL` | H3, D2 | Steer reaches the agent at the next boundary; interrupt leaves effects recorded | M |
| H6 | Cursor (ACP if H0 confirms, else stream-json) with dashboard login minting a Cursor API key; Pi over RPC in the same driver | under `SHIP_ACP_HARNESS` | H4 | Declared journeys | M |
| H8 | ACP plan phase under a read-only policy, satisfying `requirePlanReview` | `SHIP_ACP_PLAN` | H3 | Plan parks before any write | M |
| H9 | ACP registry agents at image build time; Antigravity image if Decision 20 says so | none | H3 | Build test lists the pinned agents | S–M |
| H7 | Subscription credentials: Ship-owned login in a throwaway sandbox, sealed, leased per run, digest-gated write-back, swept before snapshot | `SHIP_HARNESS_CRED` + profile opt-in | H2, H5, Decision 11 | Neg: two runs never share a lease; credential file absent from every snapshot | M |

**W4 — gated on other work**

| ID | Slice | Waits on |
| --- | --- | --- |
| EV7 | Delivery to recovery verdict: verified-recovered only when Observe shows the fix release with no events of the fingerprint for the window; otherwise reopen | EV1, EV6, A9 |
| EV8 | Policy-driven remediation authorisation (high confidence, ≤ 3 files, exact attribution; still plan-parks) | EV7, Decision 13 |
| X4′ | Live receipt: seeded incident to verified recovery, then a seeded regression reopens | EV1–EV7 |
| DT6 | Write children on `ship/<child>` branches merged into the parent's single PR by a recorded merge step; conflict parks, never force-resolves | DT2, DT3 soaked |
| DT5 | Delegation depth 2 with a store-backed ledger claim | C8, DT2 |
| D11 | Preview on its own domain behind `forward_auth`, cookie bound to run and revision; superseded revision 410 | L3 |
| D4-d, D4-e | Hot hold (new daemon TTL route) and per-project pool | D4-a measurement after D4-c |
| Q5-a..c | Frozen 40-question retrieval set and baseline, consolidator in shadow, consolidated retrieval on | A2 S21 disposition |
| Q4-d | opencode 2 and codex skill pass-through | Q4-c, codex live proof |
| C5 | Desktop target: headless Sway + wayvnc + grim (Tebian runs Sway), Xvfb fallback, `desktop` resource class, VNC never published | C5 spike under gVisor, C1 |

#### E7.3 Order

1. W0 first. EV0, Q3a and H1 are fixes to live paths; D4-a, D4-b and DT1 are
   prerequisites with no behaviour change.
2. W1 and W2 in parallel lanes (daily driver; triggers). EV1 is a
   teploy-observe release and can start immediately.
3. W3 after H1 lands; H0 can run alongside W1.
4. The existing E5 items continue: A8 git credential proof, D1 MCP soak,
   A2/A3 shadow review, G1 once D4-c and DF1 are on.

Lane routing: GLM lanes implement; Claude reviews EV0, Q3a, H1, H2, H3, H7,
DT2 and EV6 before merge (credentials, authority and access boundaries).

#### E7.4 Owner decisions added (continuing E6)

Decided 2026-10-17; the reasoning and the user-facing settings are in `docs/DECISIONS_OPEN_2026-10-04.md`. Decisions 5, 6, 8 and 10 (E6) were decided the same day.

11. **Subscription credentials on a server (H7).** Whether Ship may run a
    user's personal subscription login (Gemini, Grok, Pi, Antigravity) on a
    self-hosted server. Vendor terms were not checked. API keys need no
    decision. Blocks H7 only.
12. Unsigned or shared-secret sources (Datadog, legacy Sentry, plain-token
    GitLab) may not use `auto` rules. Default: refused.
13. Remediation authorisation in v1 is explicit approval only; EV8's project
    policy ships later. Default: explicit only.
14. Retire `/hooks/observe` once EV0 lands so Observe has one receiver
    (`/api/incidents/intake`). Default: retire.
15. TTFT target: follow-up median ≤ 20 s and at least 3× faster than cold,
    re-frozen after the D4-a baseline.
16. Warm-thread TTL 2 h and a per-project snapshot cap of 5 per host, revised
    from measured disk use.
17. `repoSkills: "deny"` refuses claude-code runs (it loads repo skills
    unmanaged). Default: refuse.
18. External-harness provider keys move behind a credential proxy before
    skills ship to external harnesses. Default: H1 first, proxy considered
    with H2.
19. An operator-interrupted external run ends `cancelled` with its effects
    recorded. Default: cancelled.
20. Antigravity's separate image waits for user demand. Default: wait.

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
| S03 | `taskRecord()` projects execution / acceptance / delivery from existing records; `src/task-requirements.ts` is a drafted, unwired store for accepted and waived requirements (migration 008 added and rehearsed on a restored production copy, 2026-10-04) | Yes, a read-only projection; not wired into a route or UI; no write path enabled | 8 unit tests: finished ≠ accepted, revision supersedes approval, denied ≠ absent, delivery never inferred; migration unit tests + rehearsal receipt (`evals/receipts/2026-10-04-s03-requirements-migration.json`) | No | Wiring the projection; authorisation for accept/waive; versioned plans; lost-response / two-tab / steer scenarios on a real run |
| S13 | Steering is refused (route) and not offered (UI) for runs whose harness cannot consume it, from one capability table | Yes, steering only | 4 unit tests on the table; web tests and build pass; the route refusal itself has no automated test | No | Full capability declaration (tools, browser, interruption, recovery, accounting); conformance journeys per harness; comparative results |
| S05, S06, S08, S09 | Not started this session | Existing foundations only | | | Greenfield and unfamiliar-repo journeys (first-batch item 5) |
| S18 | Not started this session | Existing API/client path only | | | Recorded two-repository integration-check kind (first-batch item 6) |
| S18 | `integrationStatus()` in `src/integration-evidence.ts`: the contract an executed two-repository test's evidence must satisfy (exact producer/consumer revisions, static never satisfies executed, stale on upstream move, failed/not-run/unknown all block) | Yes, a pure contract; no executor and not wired into coordination | 8 unit tests | No | The executed integration-check kind itself (a non-scan journey with authority over a two-repo workspace and the real fixture run), wiring the contract into the coordination completion gate behind an opt-in, live producer/consumer run |
| All others | Not started | Per plan table | | | As in the plan |

First-executable-batch items: **(1)** mostly done — origin/main identity matches the plan, the baseline is reproduced and the [capability inventory](CAPABILITY_INVENTORY_2026-10-03.md) is written (subagent sweep, partly spot-checked); the S28 fields are only the derivation above. **(2)** partly done — hold classification fixed; deterministic preflight run (manifest valid, 12/12 dry-runs exit 0, grader negative controls 8/8, unauthorised spend refused with exit 2); the paid canary and batch proposal are not done (no spend authorised or attempted). **(3)** partly done — records mapped and projected (S03 row); migration 008 written and rehearsed on a restored production copy (2026-10-04); no live lost-response/restart/steer rehearsal. **(4)** partly done — credential placement above; preview isolation is a teploy-cli change plus a live proof on the preview target, neither possible from here. **(5)** and **(6)** not started.

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
| S08 | #18, #31 | `src/test-integrity.ts` detector; advisory read-time panel in the run Verification view (`SHIP_ORACLE_PATHS` read in the web layer only) | 47 detector tests + 14 mutation controls; 9 projection tests + negative control (a missing diff never renders clean); web 153; build | Not a gate; PR-body/webhook surfacing approved 2026-10-04 and landed in wave 5 (#58) behind `SHIP_TEST_INTEGRITY_SURFACING`; still not in the delivery record; precision unmeasured; component not browser-rendered |
| S22 | #19 | `src/mission.ts` mission graph validation, readiness by accepted deliverable at an exact revision, acceptance aggregation | 24 tests + 8 mutation controls | Not wired or persisted; no launching, replanning or cancel; write-grant conflicts checked as strings only |
| S20 | #20 | `docs/claims/ledger.json` -> `docs/CLAIM_LEDGER.md`, `scripts/claim-ledger.mjs --check` | 14 tests; 7 guards disabled to confirm | In CI since X7 (2026-10-16, GitHub `claims` job + Forgejo step); every cited test re-run green at 477529a; 18 claims (supported 9, provisional 5, disclaimed 2, open 2), 3 verified on production evidence; tests are still cited by name only, and `--stale` misreads system evidence whose receipt was written after the observed revision |
| S23 | #21 | `src/model-routing.ts` versioned routing and fallback policy with gates | 16 tests + 6 negative controls | Not wired; failure classification, policy store and the fixed-vs-routed comparison not built |
| S21 | #22 | `src/knowledge-record.ts` provenance, verification, freshness, correction, redaction closure, visibility | 11 tests + 10 negative controls | Not wired; needs provenance fields and a project concept; decision acceptance, cross-project sharing, retrieval baseline not built |
| S24 | #23 | `src/tool-manifest.ts` validation, intersection-only permissions, conformance audit, signed and deduped event envelope | 25 tests + 8 negative controls | Not wired; enforcement stays with the credential and executor layer; manifest schema is strict (newer-minor manifests are rejected) |
| S16 | #24 | `src/schedule-time.ts` timezone and DST-aware daily/weekly slots, missed-run policy, overlap, debounce | 34 tests, naive-implementation control, 7 mutations | Overlap is inert in production (the worker does not pass `isRunning`); no UI or API to create `at` schedules; no event triggers |
| S25 | #25 | `src/policy-inheritance.ts` org/project/user/service-account resolution, intersection only, fail-closed | 21 tests + union-merge control + 3 mutations | Not wired; no layer store, model/tool/retention enforcement or lifecycle; **service-account role: owner confirmed 2026-10-04 — keep id-only matches** |
| S26 | #26 | `src/execution-target.ts` placement with reasons, host-loss recovery, conformance | 23 tests, 10 mutations, two fake backends | Not wired into `SandboxPool` or `durable.ts`; no real Windows/macOS/mobile/GPU adapter |
| S27 | #27 | `src/deployment-adapter.ts` adapter contract, delivery and recovery and provisioning journeys, 27-check conformance suite | 48 tests, 2 faithful + 9 faulty fakes, 8 mutations | No real Teploy/CI/Kubernetes adapter, so S27 acceptance is not met; Teploy has no destination-level fence |
| S13 | #28 | Full capability declaration for native, claude-code and opencode; shared plan-review refusal; pure `conformanceCheck` | 8 new tests + negative control | Per-harness journeys on live runs; `conformanceCheck` not wired to adapter probes; steer-route refusal has no automated test |
| S06 | #29 | `src/environment-recipe.ts` recipe, planning, teardown, lifecycle validation | 18 tests, 6 mutation-verified controls, fake runner only | Not wired; no real runner or cache store; large/binary transport, browser tooling, snapshot secret scan open |
| S02 graders | #34 | `scripts/grader-sensitivity.mjs` plus 73 hand-written variants (60 wrong, 12 correct references, 1 known limit) across all 12 scenarios, committed matrix; **eight grader tightenings after 11 wrong variants passed against the previous graders** (deploy-recovery health gate satisfied by a comment and by a lying server, permissions accepted 403 where the manifest says 401, API catch-all 409, migration edited in place, "30-minute" wording, scheduled-job store bypass, applied diff in a plan) | 79 tests; 60/60 wrong variants rejected for their targeted reason, 12/12 references accepted; negative controls (stub grader passes everything, sabotaged reference, reverted fix) | Variants are finite; the review grader stays lexical; the tightened graders have not run on a live baseline; **retained results were not re-graded, so earlier pass counts were scored under the looser graders**; `pj-s-feature` accepts a marked-placeholder contact page by design (known limit); deploy-recovery grading boots ephemeral ports (fixed port 8901 removed 2026-10-18) and runs in parallel |
| S10 | #33 | `scripts/ui-audit.mjs` (47 routes x 5 viewports, optional axe-core, JSON and markdown report) and five defect-class fixes (input labels, empty table headers, underlined in-text links, keyboard-reachable scrolling regions, narrow-viewport overflow); report in `docs/UI_AUDIT_2026-10-03.md` | 14 helper tests with negative controls, 3 web source guards, one full audit run (230 page loads; no error-level finding or axe violation on audited pages apart from the framework 404) | No human observation of target users; 79 targets under 24px kept as compact controls (**owner-confirmed 2026-10-04**); framework plain-text 404 (filed upstream as [Tyler/neutron#6](http://100.108.123.49:49152/Tyler/neutron/issues/6)); keyboard activation, offline and error states, other roles, screen readers, `/connect*`, `/oidc/*`, `/hooks/*`, `/api/*` not audited |
| S28 | #30 | `timing` in `audit --format json` (not CSV), `timingSummary` with an n>=20 gate | 8 tests, CSV byte-pinned, mutation control; CLI wiring type-checked only | No real-store run; **the n>=20 threshold was confirmed by the owner 2026-10-04**; capacity table not recomputed |

#### Wave 3 (2026-10-04): wiring behind flags

Wave 3 wires wave-2 modules into the product. **Every change below is off by default or observe-only**, proven by tests that compare default behaviour with and without the change. "Checked" still means automated tests only; no row has a verified outcome and nothing was run against a live system or spent. Turning any flag on is an operator decision.

| Package | PR | Flag (default) | Implemented | Checked | Still open (specific) |
| --- | --- | --- | --- | --- | --- |
| S18 | #36 | `SHIP_INTEGRATION_CHECK=on` plus a per-coordination declaration (off) | Executed two-repository check (`src/integration-check.ts`): runs a declared command against the exact producer and consumer revisions, refuses to run on a wrong or dirty tree; completion gate in `coordination.ts`; static compatibility never satisfies it; an upstream move makes evidence stale | 10 tests running the real `verify-pair.mjs` through `LocalExecutor` on real git checkouts, 3 negative controls | Nothing in the worker provisions the trees or runs it; no route or UI; no sandbox run; merge ordering and version windows; evidence uncapped |
| S11 | #37 | `SHIP_BUDGET_RESERVATION=off|shadow|on` (off) | Ledger wired at intake, daily-budget check and completion settle; unpriced spend stays unknown | 11 tests on the real paths, negative controls | Single-process file ledger (`on` refused off the file runtime; two processes on one host undetectable); settle step untested; child and retry scopes and lease fencing unwired; no counters endpoint |
| Hygiene | #38 | none | Kernel cancel now sends a real interrupt (the old call did not wake a blocked cell, so every timeout killed the kernel); `@grpc/grpc-js` 1.14.5 (clears GHSA-m9gg-hp2v-232j, dev-only); steer-route refusal tests | Negative controls for the kernel and the steer route | Original `TS-019` flake not reproduced under load, so the cause is unproven; kernel interrupt is POSIX-only |
| S16 | #39 | `SHIP_SCHEDULE_OVERLAP=on` (off) | Worker sweep passes `isRunning`: overlap `skip` and `queue` enforced; unreadable run log blocks every schedule (fail closed) | 8 tests on the real sweep path, negative controls | Only the 200 most recent runs are scanned; a task proposed but not launched is not counted; the worker interval loop has no harness |
| S05, S06 | #40 | `SHIP_STACK_DETECT=on` (off) | Read-only stack proposals through a bounded executor read; `project detect` CLI; setup-page suggestions with no apply button; proposals-to-recipe adapter; additive digest recorded beside the config id | 35 tests over six synthetic repo trees through a real executor, 8 negative controls (two needed new tests) | Digest recorded but not compared, so staleness is unchanged; no real-repo corpus; private repos CLI only; setup page not rendered; recipe not executed anywhere |
| S23 | #41 | `SHIP_MODEL_ROUTING=shadow|on` (off) | Policy loader, failure classifier, fallback outside retry, insert-only `ship_model_segments` table; shadow records and never changes the model | 29 tests, 8 negative controls | Tool-call journal not fed by `durable.ts`, so `on` refuses every mid-run switch; records per process; no real outage or gateway; fixed-versus-routed comparison not built |
| S09 | #42 | `SHIP_FINDING_CONTINUITY=on` (off) | Advisory continuity classification in the existing scan step (additive fields), run-page block; opt-in forge inline comments | 12 root and 3 web tests, real three-revision git path, off-equivalence | Thresholds unvalidated; forge resolution read but not used; diff from a shallow checkout; no merge gate by design |
| S25 | #43 | `SHIP_POLICY_SHADOW=on` (off) | Policy resolved beside nine existing decision points; disagreements recorded to JSONL; `policy shadow-report` | 20 tests, union-merge control, 3 mutations, default-off byte-identical | No enforcement; agreements not counted (no rate); worker intake budget not hooked; models, tools, retention have no decision point; **service-account role undecided** |
| S01, S04 | #44 | `SHIP_SAFE_FETCH` unset = **shadow**, `on`, `off`; `SHIP_SAFE_FETCH_ALLOW` | Pinned fetch is the default for forge API calls in `git.ts` and `forge-state.ts`; shadow warns once per host without changing the request | 17 tests including a real loopback server and a rebinding resolver | Setup route, ladder-steps, worker and deploy entry points; `git clone` and `git fetch` subprocesses unguarded; shadow log must be reviewed on a real deployment before `on`; shadow adds one address lookup per forge call (unmeasured) |

#### Wave 4 (2026-10-04): more wiring, and first parts of the untouched packages

Same rules as wave 3: every change is off by default or observe-only, with tests comparing default behaviour with and without it. **Implemented and checked only; no verified outcomes, nothing run live, nothing spent.**

| Package | PR | Flag (default) | Implemented | Checked | Still open (specific) |
| --- | --- | --- | --- | --- | --- |
| S15, S17 | #46 | none (inert modules) | `src/recovery-compat.ts` (migration-aware recovery check: unread or unclassified state holds; a newer contract or irreversible migration is incompatible; a recovery plan never counts as a pass) and `src/incident-evidence.ts` (facts, hypotheses and unknowns kept apart; other-service evidence set aside; fewer than five samples is unknown; confidence capped at medium) | 19 tests, 8 negative controls | Unwired; no migration-state reader; no page timeline; log excerpts clamped not redacted (callers must redact); no live incident |
| S22 | #47 | `SHIP_MISSION_VIEW=on` (off) | Read-only mission view on the coordination page; accepted only when the task record says accepted; waivers shown as waived | 23 tests, 4 negative controls | No launching, persistence or replanning; planned-on revision not recorded on the client child, so a moved upstream with no delivery record is invisible |
| S26 | #48 | `SHIP_PLACEMENT=shadow` (off) | Placement decision recorded beside the sandbox pool's host choice and the host-loss path; `placement shadow-report` | 19 tests through the real pool and durable path, 3 mutations | No enforcement; per-run architecture or browser needs not recorded; no drain concept in the pool; a failed liveness probe looks like a TTL expiry |
| S19 | #49 | none (new command) | `teploy-ship doctor`: install prerequisites with pass, fail or unknown (unknown is never pass), secrets reported by presence only, redacted output; restore-readiness comparison module. **S19 tail:** doctor answers store liveness (`SELECT 1`) and clock skew (against the store's own clock, `SELECT now()`) read-only when `NUCLEUS_URL` is set, unknown otherwise; `teploy-ship snapshot` produces the script's archive shape (tar + sha256 sidecar + manifest) and refuses running writers without `--i-stopped-writers`, never overwrites, never deletes; `teploy-ship restore-check` verifies an archive (sidecar + gzip integrity + content listing, no unpacking; integrity-only verdict names the rehearsal as the restore proof); the support bundle carries `doctor.json` + the latest backup manifest (never the archive) | 20 doctor tests + 4 live-probe tests (fake store client), 8 negative controls, planted-secret control; 11 snapshot/restore-check tests incl. negative controls (running-writer refusal with exact stop line, overwrite refusal, tampered sidecar, truncated archive with re-computed checksum caught by gzip, path-escape listing, failed-production cleanup); 2 bundle tests (doctor+receipt included, degrade to notes); CLI wiring type-checked only | S04 not started; doctor's clock stays unknown with no configured store or when the engine does not answer a time query (honest by design); the unpack and rehearsal remain script-only (`scripts/ship-backup.sh restore/rehearse`) — the CLI verifies without unpacking by design; restore-readiness comparison still has no command; nothing in the tail has run against a live store or live docker |
| S13 | #50 | `SHIP_HARNESS_RECORD=on` (off) | Probes for plan-review, steer and investigate across native, claude-code and opencode (fake binaries); harness identity recorded as a sibling key on run-started (step fingerprint unchanged); "Ran on" block on the run page; credential-lifecycle tests | 15 root and 4 web tests, negative controls | Real vendor binaries; five operations unprobed; probes not run at startup or in CI |
| S21 | #51 | `SHIP_KNOWLEDGE_PROVENANCE=off|shadow|on` (off) | Sidecar provenance store (new table, no migration); notes screened and labelled fresh, stale or unknown in `on`; redaction cascades on delete; summaries recorded as agent claims | 25 tests, 6 negative controls, durable step sequence identical across modes | No live Nucleus; freshness coarse; replay-exact derivation not available; cli.ts and agent.ts paths unwired; project scope is repo-only |
| S24 | #52 | `SHIP_TOOL_MANIFEST=shadow|on`, `SHIP_EVENT_ENVELOPE=on` (both off) | `tool validate` dry-run CLI; manifest conformance findings recorded per tool call (never block); signed event envelope as extra webhook headers; client verification example | 14 tests, 4 negative controls, default-off header and body byte identity | The loop sees only the action kind, so host and secret findings cannot fire until the executor reports them; no tool registry or web view |
| S07 | #53 | `SHIP_PLAN_GROUNDING=on` (off) | `src/plan-grounding.ts`: whether files, symbols, scripts and make targets a plan names exist in the committed tree at a stated revision. Wired at the plan park (2026-10-04): the report rides additively on the `plan-think` step result (no new durable step) and renders as an advisory block on the run page's plan review | 15 tests on real git repos, 7 mutation controls; wiring: default-off byte identity, real-path park test on a real git workspace, negative control, no-repo omission | "Grounded" means the name exists, not that the plan is right; only the park point is wired (not denial paths or other consumers); most of S07 not started |
| S27 | #54 | `SHIP_DEPLOY_ADAPTER=teploy` (off) | `TeployAdapter` and an optional adapter path in `delivery.ts` and `worker.ts`; capabilities declare what it cannot do | 28 tests against a fake CLI as a real process, conformance 22 pass, 5 skipped for declared gaps, 10 mutations | No real teploy run; a manual deploy landing inside Ship's deploy is overwritten and still reads back confirmed (pinned by a test); stricter than legacy (unreadable status holds); S27 acceptance not met |

Upstream feature requests for the Teploy CLI, **not yet filed**: a deploy dry-run; a deploy generation in `status --json` with a compare-and-set or lock that manual deploys honour; documented `logs` flags and a status that separates "no deployment yet" from "unreachable".


Also merged this wave: #9 plan and inventory, #10 devalue 5.9.3 override. S10 and S02 grader sensitivity landed after this table was first written and are the first two rows after S13/S06.

#### Wave 5 (2026-10-04): S08 surfacing

Same rules as waves 3 and 4: off by default, default-off equivalence proven by tests. This row exists because the owner approved the direction on 2026-10-04 (see the wave-5 notes at the top of `AUDIT_OPEN.md`).

| Package | PR | Flag (default) | Implemented | Checked | Still open (specific) |
| --- | --- | --- | --- | --- | --- |
| S08 | #58 | `SHIP_TEST_INTEGRITY_SURFACING=off\|shadow\|on` (off) | The detector's findings on the pull request body (a "Test integrity" part inside the existing Verification section, marker-spliced and idempotent like the rest) and as an additive `test_integrity` field on the run-completion webhook payload. No new step, no recorded step result changes, delivery record untouched; clean adds nothing anywhere. Shadow logs what `on` would surface, per the standing worker-path rule | 13 wiring tests: default-off byte-equivalence (section and payload), real-path flag-on tests through `verificationSection`/`spliceVerification`/`runWebhookPayload` and the worker's own terminal composition, negative controls (clean diff, no/`empty`/non-string diff, garbage diff, invalid flag value), cap and middle-cut honesty | Not one live run (no forge, worker or receiver reachable); shadow not soaked on a worker; detector precision still unmeasured (wave-2 open item); the `fix` command's own PR path (`fix-evidence.ts`) does not surface findings — worker paths only |

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
- **Migration / recovery:** additive migration `008-ship-task-requirements` (src/migrations.ts, the 006/007 new-table convention: ledger-recorded, write-shaped shape probe, DDL-parity guard; rename-aside limb unreachable because no other shape was ever released). Rehearsed 2026-10-04 on a restored copy of the production store (backup `pre-80c9187-shadow-deploy-2026-10-04`): additive-only on 45 tables / 4223 rows (only ship_migrations moved, 7→8), replay a no-op, and the store's primary-key and conditional-update behaviour verified on the real engine. Receipt: `evals/receipts/2026-10-04-s03-requirements-migration.json`, driver `scripts/check-task-requirements-migration.mjs`. Revert is not wiring it; the table is inert and can stay.
- **Independent acceptance (done):** 7 tests across all three stores: idempotent add, conflict refusal, concurrent-writer race on the primary key, waiver rules and exactly-once, per-task ordering, input limits, additive-only SQL. The Nucleus tests use a fake of my own writing, **plus the real-engine rehearsal above**.
- **Not done, and needed before any rollout:** wiring into enqueue (record the initial request and each follow-up as requirements) and the run page; authorisation for accept/waive on the existing approval grants; feeding waived/active requirements into `taskRecord()` acceptance; scenarios for two tabs, lost response and steering on a real run.
- **Evidence location:** `src/task-requirements.test.ts`.

#### S01 — environment-supplied Git credential (implemented, off by default)

Spec, evidence and the open prerequisites are in `AUDIT_OPEN.md` (2026-10-02/03 entry). Rollout order: confirm the Sandbox daemon forwards per-exec `env` and the image's git is 2.31+; prove a private-repo clone and push on Forgejo and GitHub through the real sandbox with `SHIP_GIT_CREDENTIAL=env` on a canary worker; observe; only then change the default. Revert is unsetting the variable.

#### S02 — batch EXECUTED 2026-10-04, configuration A only (owner decision)

The owner approved **A only**: the gateway's `ZAI_API_KEY` was rotated to a
z.ai coding-plan (subscription) credential, so configuration A
(`zai/glm-5.3`) ran with **$0 real spend**; configuration B
(`anthropic/claude-sonnet-5`) was not run and no API dollars were spent.
Canary `eval-20261003-2` (pass) then the 11-scenario × 3 batch
(`eval-20261003-3/-4`, `eval-20261004-1/-2/-3/-4`): **24/33 first-attempt
passes, $1.81 priced total** (accounting rate table, not dollars).
Summary and honest reads: [../evals/product-journeys/BATCH_2026-10-04.md](../evals/product-journeys/BATCH_2026-10-04.md).
Not done: the B leg of the comparison (needs real API spend, owner-gated);
re-grading retained pre-tightened-grader results.

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
