// The distillery module's public surface. `server.ts` and the panel reach the
// module through these names and never past them into a file.
export {
  CAUSE_CLASSES,
  DRAFT_STATES,
  PROSE_RUNG,
  RUNGS,
  SIGNAL_SOURCES,
  distilleryContract,
  draftEditSchema,
  isCanonicalCauseClass,
  rungSchema,
  type CauseClass,
  type ClusterView,
  type CorrectionView,
  type DistillAction,
  type DistillStatus,
  type DraftEdit,
  type DraftState,
  type DraftView,
  type Rung,
  type ScanCounts,
  type SignalSource,
  type TopCluster,
} from "./contract.js";
export {
  PREVIEW_MAX_CHARS,
  REDACTION_RULES,
  hasUnredacted,
  parseCounts,
  redact,
  serializeCounts,
  type Redacted,
  type RedactionCounts,
  type RedactionRule,
} from "./redact.js";
export {
  SCANNERS,
  knownRunFolders,
  ledgerRow,
  normalizeCauseClass,
  repoRootOf,
  scanAll,
  section,
  signatureOf,
  type Correction,
  type ScanContext,
  type Scanner,
} from "./signals.js";
export {
  MIN_CLUSTER_RUNS,
  MIN_CLUSTER_SIZE,
  clusterCorrections,
  clusterId,
  normalizeSignature,
  topClusters,
  type Cluster,
} from "./cluster.js";
export {
  ALLOWED_HOME_PREFIXES,
  DRAFT_THREAD_TAG,
  MAX_BATCH_CLUSTERS,
  buildPrompt,
  dedupeCorpus,
  draftThreadTitle,
  isAllowedHome,
  isAlreadyCovered,
  monthSpendUsd,
  monthStart,
  operationIdFor,
  parseDraftReply,
  runDraftBatch,
  selectBatch,
  storeBatchDrafts,
  type DraftBatchResult,
  type ParsedDraft,
} from "./draft.js";
export {
  RECURRENCE_CAP,
  applyBlockReason,
  applyDraft,
  appendFindingsRow,
  expandHome,
  improvementFileName,
  isOnDefaultBranch,
  nextFindingId,
  renderImprovement,
  slugify,
  type ApplyResult,
} from "./apply.js";
export {
  DistilleryRuntime,
  type ActResult,
  type DistilleryHandle,
  type QueueRow,
} from "./queue.js";
export { DistilleryStore, type CorrectionInput } from "./store.js";
export {
  DISTILLERY_SETTING_DESCRIPTORS,
  readDistilleryConfig,
  type DistilleryConfig,
} from "./settings.js";
export {
  createDistilleryModule,
  createDistilleryRuntime,
  type SettingsReader,
} from "./module.js";
export {
  STATUS_TOOL,
  STATUS_TOOL_MAX_CHARS,
  createDistilleryRpcHandlers,
  renderStatusTool,
  requireRuntime,
} from "./rpc.js";
export { DISTILL_CLI_COMMANDS, runDistillCli } from "./cli.js";
