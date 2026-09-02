// The watch module's public surface. `server.ts` and the panel reach the
// module through these names and never past them into a file.
export {
  ESCALATION_CHANNEL,
  RULE_IDS,
  SIGNAL_CHANNEL,
  WATCH_MODES,
  parseRuleId,
  parseSeverity,
  signalBroadcastSchema,
  watchContract,
  type InboxAction,
  type InboxCounts,
  type InboxRow,
  type InboxSource,
  type RuleId,
  type Severity,
  type SignalBroadcast,
  type SignalView,
  type ThreadSignalView,
  type WatchMode,
  type WatchRow,
  type WatchSettingsView,
} from "./contract.js";
export {
  MODE_KV_KEY,
  PER_DAY_KEY,
  QUIET_HOURS_KEY,
  RULE_ENABLED_KEYS,
  RULE_THRESHOLDS,
  THRESHOLDS_KV_KEY,
  WATCH_SETTING_DESCRIPTORS,
  inQuietHours,
  parseQuietHours,
  readWatchConfig,
  type QuietHours,
  type WatchConfig,
} from "./settings.js";
export {
  ITEM_WINDOW,
  RETRY_WINDOW_MS,
  WatchQueries,
  type ItemFact,
  type ThreadFact,
  type WatchSnapshot,
} from "./queries.js";
export {
  STALL_RULES,
  STEER_ELIGIBLE_RULES,
  UNFINGERPRINTED,
  dedupeKey,
  evaluate,
  type Finding,
} from "./rules.js";
export {
  OVERALL_HOURLY_CAP,
  PER_THREAD_HOURLY_CAP,
  RESERVED_TITLE_PREFIXES,
  STEER_COOLDOWN_MS,
  createLadder,
  escalationDiagnostic,
  ruleOfDetail,
  steerDiagnostic,
  type Ladder,
  type LadderOutcome,
  type SignalTransition,
  type SteerVerdict,
  type ThreadContext,
} from "./ladder.js";
export {
  buildPremiseReminder,
  isOpenDecision,
  readLedger,
  section,
} from "./premise.js";
export {
  createEngine,
  evidenceOf,
  parsePayload,
  type EvaluationResult,
  type WatchEngine,
} from "./engine.js";
export {
  buildExplain,
  buildInbox,
  buildWatchList,
  stageOf,
  toThreadSignalView,
} from "./views.js";
export {
  TRAJECTORY_MAX_CHARS,
  createTrajectory,
  type Trajectory,
} from "./trajectory.js";
export {
  createWatchModule,
  createWatchRuntime,
  type SettingsReader,
  type WatchHandle,
  type WatchRuntime,
} from "./module.js";
export {
  STEER_NOTE,
  createWatchRpcHandlers,
  runManualSteer,
  settingsView,
  steerMessage,
} from "./rpc.js";
export {
  WATCH_CLI_COMMANDS,
  formatExplain,
  formatWatchList,
  runWatchCli,
} from "./cli.js";
