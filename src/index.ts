export { executeAction, runAgent } from "./agent.js";
export type { AgentEvent, AgentResult, AgentStep, RunAgentOptions } from "./agent.js";

export { describeAction, parseAction } from "./actions.js";
export type { Action } from "./actions.js";

export { ensureKernel, installKernel, runCell, stopKernel } from "./kernel.js";

export { autoApprove, defaultApprovalPolicy, resolveApprovalPolicy, sandboxApprovalPolicy } from "./approval.js";
export { isQuotaModel, quotaModelPrefixes } from "./pricing.js";
export type { ApprovalDecision, ApprovalPolicy } from "./approval.js";

export { RecoveryTracker, SETTLE_NUDGE, SETTLE_STOP, defaultRecoveryConfig } from "./recovery.js";
export type { RecoveryConfig, RecoverySignal } from "./recovery.js";

export { condenseIfNeeded, defaultCondenseConfig, historySize } from "./memory.js";
export type { CondenseConfig, Summarizer } from "./memory.js";

export { approvalEvent, durableAgent, sandboxProvider } from "./durable.js";
export { deployPreview, destroyPreview, hostRunner, previewComment, previewTargetFromEnv, rollbackDeploy } from "./deploy.js";
// D5/D4: merging a trivial change, and judging whether a deploy made things
// worse. Exported here for the same reason deployPreview/compareHealth are —
// they are part of what a caller embedding Ship can drive.
export { mergePullRequest } from "./git.js";
export type { MergeOutcome } from "./git.js";
export { defaultRegressionThresholds, telemetryRegression } from "./observe.js";
export type { RegressionThresholds } from "./observe.js";
export { runTests, testComment, testTargetFromEnv } from "./tests.js";
export type { TestOutcome, TestTarget } from "./tests.js";
export type { CommandResult, CommandRunner, PreviewOutcome, PreviewTarget, RollbackOutcome } from "./deploy.js";
export type {
  ApprovalDecisionPayload,
  DurableAgentConfig,
  DurableAgentInput,
  DurableAgentOutput,
  ExecutorProvider,
} from "./durable.js";

export { formatObservation, systemPrompt } from "./prompt.js";
export {
  DEFAULT_NETWORK_TIER,
  NETWORK_DOWNGRADE_NOTE,
  NETWORK_TIERS,
  NETWORK_TIER_HELP,
  detectEgressRefusal,
  egressEntryError,
  egressRefusalHint,
  egressRefusalNote,
  networkForTrust,
  normalizeEgressAllow,
  parseNetworkTier,
  resolveNetworkTier,
  splitEgressAllow,
  wireNetwork,
} from "./egress.js";
export type { EgressRefusal, NetworkTier } from "./egress.js";

export { checkCommand, formatReport, localEvalExecutor, runEval } from "./eval.js";
export type {
  EvalExecutor,
  EvalReport,
  EvalRunResult,
  EvalTask,
  RunEvalOptions,
  Verification,
} from "./eval.js";

export { builtinSuite } from "./tasks.js";
export { hardSuite } from "./hard-tasks.js";
export { extremeSuite } from "./extreme-tasks.js";

/**
 * P1-5 — the Observe incident receiver's two pure pieces.
 *
 * THESE BELONG ON `teploy-ship/runtime`, in the `./intake-sources.js` and
 * `./evidence.js` export blocks alongside ciFixTaskFromWorkflowRun and
 * FileEvidenceStore (src/runtime.ts:62 and :136-145) — that is where every
 * other intake builder the web routes use is exported from, and where
 * web/src/lib/webhook.server.ts should import them from. They are on the
 * package root instead only because runtime.ts was owned by another lane on
 * the night this landed and could not be touched. Moving them is a two-line
 * change plus one import path in webhook.server.ts, with no behaviour to
 * re-verify.
 */
export { incidentTaskFromObserveAlert, observeAlertKey } from "./intake-sources.js";
export type { ObserveAlertPayload } from "./intake-sources.js";
export { lookupRepoForObserveService, repoForObserveService } from "./evidence.js";
