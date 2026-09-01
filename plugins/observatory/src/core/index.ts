// The core module's public surface. Every other module reads the ledger
// through these names and never reaches past them into a file.
export {
  CARRY_TURN_LIMIT,
  delta,
  emptyCarry,
  fingerprintArgs,
  normalizeEvents,
  type ItemPatch,
  type NormalizeCarry,
  type NormalizeResult,
  type ThreadEventRow,
  type ThreadPatch,
  type TokenTotals,
  type TurnCounters,
  type TurnPatch,
} from "./events.js";
export {
  DELIVER_SEATS,
  ROOT_WALK_DEPTH_CAP,
  ThreadRegistry,
  findRunFolder,
  parseSeatAndTier,
  type ResolvedThread,
  type SeatAndTier,
  type ThreadRegistryOptions,
} from "./threads.js";
export {
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  isExactMatch,
  joinPendingTurns,
  joinSession,
  sidechainTurnId,
  type JoinDeps,
  type JoinSummary,
  type LogTurn,
  type LogTurnQuery,
  type LogTurnSource,
  type PriceTurnFn,
  type PriceTurnInput,
  type PriceTurnResult,
} from "./join.js";
export {
  IDLE_POLL_MS,
  PAGE_LIMIT,
  STALE_AFTER_MS,
  TICK_BUDGET_MS,
  createIngest,
  type DrainListener,
  type Ingest,
  type IngestCounters,
  type IngestOptions,
} from "./ingest.js";
export {
  EventStore,
  type CostUpdate,
  type CoverageView,
  type MatchRow,
  type PendingSplitTurn,
  type SplitUpdate,
  type StaleThread,
} from "./store-events.js";
export {
  ObservatoryStore,
  applyMigrations,
  type SplitSource,
  type StoreCounts,
} from "./store.js";
