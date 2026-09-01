// Joining bb turns to on-disk provider log turns.
//
// bb reports `cachedInputTokens` as cache reads PLUS cache writes (the
// claude-code and pi bridges both fold them), and reports no cost and no
// model. All three are only recoverable from the provider's own session log,
// and no API hands out its path, so the join is by provider session id plus a
// timestamp, and it can fail.
//
// THE UNIT MISMATCH is what this module exists to absorb. One bb turn is a
// whole agentic loop; one Claude Code log row is a single assistant request.
// A turn is therefore MANY rows (about eight, measured), not one. Matching a
// turn against a single row that equals its totals matched almost nothing:
// 5.4% of claude-code turns, against 96.8% that have rows in their window.
//
// So the join is a PARTITION, not a search. The session's rows are cut at the
// turn starts: every row belongs to the latest turn that had already begun
// when the row was written, and each row is consumed exactly once. Turn
// totals are the SUM over its slice. Nothing is ambiguous, because nothing
// competes; the only rows without a turn are those written before the first
// turn began or after the last one finished, and those are counted, not
// attributed.
//
// Failing is still a first-class outcome. `unavailable` with NULL cache
// columns is always preferred to a plausible number, and it now means exactly
// one thing: no rows landed in this turn's slice. A disagreement between the
// log sums and bb's own totals is NOT a failure, it is `log-window`.
//
// The log side arrives as ports rather than imports so this file stays
// testable without a filesystem and without the log indexer.
import type { ObservatoryStore } from "./store.js";
import type { EventStore, PendingSplitTurn } from "./store-events.js";

/** Window before a turn starts in which its provider log row may be written. */
export const WINDOW_BEFORE_MS = 2_000;
/** Window after a turn completes. Wider: the log flushes after the turn. */
export const WINDOW_AFTER_MS = 10_000;

/** One provider log turn, as the log indexer stores it. */
export interface LogTurn {
  log_key: string;
  provider: string;
  provider_thread_id: string;
  ts: number;
  model: string | null;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
  logged_cost_usd: number | null;
  is_sidechain: number | null;
  agent_id: string | null;
  skill_names: string | null;
  mcp_names: string | null;
}

export interface LogTurnQuery {
  provider: string;
  providerThreadId: string;
  tsFrom: number;
  tsTo: number;
}

/** The slice of the sibling `store-logs` module this join depends on. */
export interface LogTurnSource {
  listLogTurns(query: LogTurnQuery): LogTurn[];
}

export interface PriceTurnInput {
  provider: string;
  model: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  loggedCostUsd: number | null;
}

export interface PriceTurnResult {
  costUsd: number | null;
  costSource: string | null;
  pricingStatus: string | null;
  cacheSavingsUsd: number | null;
}

export type PriceTurnFn = (
  input: PriceTurnInput,
  catalog: unknown,
) => PriceTurnResult;

export interface JoinDeps {
  store: ObservatoryStore;
  events: EventStore;
  logs: LogTurnSource;
  priceTurn: PriceTurnFn;
  catalog: unknown;
}

export interface JoinSummary {
  considered: number;
  logExact: number;
  logWindow: number;
  sidechain: number;
  unavailable: number;
  /** Log rows attributed to some turn. */
  rows: number;
  /** Rows written before the first turn of the session began. */
  unattributedBefore: number;
  /** Rows written after the last turn of the session completed. */
  unattributedAfter: number;
}

function emptySummary(considered = 0): JoinSummary {
  return {
    considered,
    logExact: 0,
    logWindow: 0,
    sidechain: 0,
    unavailable: 0,
    rows: 0,
    unattributedBefore: 0,
    unattributedAfter: 0,
  };
}

/** The summed token shape of one turn's slice of the log. */
export interface RowSums {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** Summed only when EVERY row carries one; a partial sum is not a cost. */
  loggedCostUsd: number | null;
  /** The last row's model: the one the turn ended on. */
  model: string | null;
  /** Every distinct model the slice touched, for the match detail. */
  models: string[];
  rows: number;
  lastLogKey: string | null;
}

export function sumRows(rows: readonly LogTurn[]): RowSums {
  const sums: RowSums = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    loggedCostUsd: null,
    model: null,
    models: [],
    rows: rows.length,
    lastLogKey: null,
  };
  let costTotal = 0;
  let everyRowCosted = rows.length > 0;
  const models = new Set<string>();
  for (const row of rows) {
    sums.input += row.input ?? 0;
    sums.cacheRead += row.cache_read ?? 0;
    sums.cacheWrite += row.cache_write ?? 0;
    sums.output += row.output ?? 0;
    sums.reasoning += row.reasoning ?? 0;
    if (row.logged_cost_usd === null) everyRowCosted = false;
    else costTotal += row.logged_cost_usd;
    if (row.model) models.add(row.model);
    sums.model = row.model ?? sums.model;
    sums.lastLogKey = row.log_key;
  }
  sums.loggedCostUsd = everyRowCosted ? costTotal : null;
  sums.models = [...models];
  return sums;
}

/**
 * `log-exact` needs BOTH equalities against bb's own totals. It is now a
 * label on an already-decided attribution rather than the gate that decides
 * it: the slice is the turn's spend either way, and the two sums agreeing
 * with bb only tells us the two clocks saw the same requests.
 */
export function isExactMatch(turn: PendingSplitTurn, sums: RowSums): boolean {
  return (
    turn.cached_input_tokens !== null &&
    turn.output_tokens !== null &&
    sums.cacheRead + sums.cacheWrite === turn.cached_input_tokens &&
    sums.output === turn.output_tokens
  );
}

/**
 * `<turn_id>#sc:<agent_id>` for a synthetic subagent turn.
 *
 * The AGENT is the identity, not the row: a subagent writes many rows inside
 * one parent turn for the same reason the parent does, and one synthetic turn
 * per row turned a single seat into eight.
 */
export function sidechainTurnId(turnId: string, agentId: string): string {
  return `${turnId}#sc:${agentId || "anon"}`;
}

/**
 * Plain ASCII on purpose. This delimiter used to be a literal NUL byte, which
 * made git classify the whole module as binary and hid every diff of it.
 * Neither a provider id nor a provider session id contains a pipe.
 */
const GROUP_DELIMITER = "|";

function groupKey(turn: PendingSplitTurn): string {
  return `${turn.provider_id ?? ""}${GROUP_DELIMITER}${turn.provider_thread_id ?? ""}`;
}

function startMs(turn: PendingSplitTurn): number | null {
  const started = turn.started_at ? Date.parse(turn.started_at) : NaN;
  if (!Number.isNaN(started)) return started;
  const completed = turn.completed_at ? Date.parse(turn.completed_at) : NaN;
  return Number.isNaN(completed) ? null : completed;
}

function endMs(turn: PendingSplitTurn): number | null {
  const completed = turn.completed_at ? Date.parse(turn.completed_at) : NaN;
  return Number.isNaN(completed) ? null : completed;
}

export interface Partition {
  /** One slice per turn, positionally aligned with the turns given. */
  buckets: LogTurn[][];
  before: LogTurn[];
  after: LogTurn[];
}

/**
 * Cut `rows` at the turn starts.
 *
 * Every row goes to the LATEST turn whose start (less the lead window) is at
 * or before it, so adjacent turns never compete for a row and no row is
 * counted twice. Rows earlier than the first start, and rows past the last
 * turn's completion plus the flush window, belong to no turn: the tail trim
 * applies to the last turn ONLY, because a mid-session turn's slice is
 * already closed by the next turn's start.
 */
export function partitionRows(
  turns: readonly PendingSplitTurn[],
  rows: readonly LogTurn[],
): Partition {
  const buckets: LogTurn[][] = turns.map(() => []);
  const before: LogTurn[] = [];
  const after: LogTurn[] = [];

  const live = turns
    .map((turn, index) => ({ index, start: startMs(turn) }))
    .filter(
      (entry): entry is { index: number; start: number } => entry.start !== null,
    )
    .map((entry) => ({ index: entry.index, at: entry.start - WINDOW_BEFORE_MS }))
    .sort((a, b) => a.at - b.at || a.index - b.index);

  // `log_key` breaks ts ties so two runs over the same rows agree.
  const ordered = rows
    .slice()
    .sort((a, b) => a.ts - b.ts || a.log_key.localeCompare(b.log_key));

  let cursor = -1;
  for (const row of ordered) {
    for (let next = live[cursor + 1]; next && next.at <= row.ts; next = live[cursor + 1]) {
      cursor += 1;
    }
    const owner = cursor < 0 ? undefined : live[cursor];
    if (!owner) before.push(row);
    else buckets[owner.index]?.push(row);
  }

  const last = live[live.length - 1];
  const end = last ? endMs(turns[last.index] as PendingSplitTurn) : null;
  if (last && end !== null) {
    const limit = end + WINDOW_AFTER_MS;
    const slice = buckets[last.index] ?? [];
    buckets[last.index] = slice.filter((row) => row.ts <= limit);
    after.push(...slice.filter((row) => row.ts > limit));
  }
  return { buckets, before, after };
}

/** True when bb reported no spend at all for this turn. */
function isZeroToken(turn: PendingSplitTurn): boolean {
  return (
    (turn.cached_input_tokens ?? 0) === 0 &&
    (turn.output_tokens ?? 0) === 0 &&
    (turn.input_tokens ?? 0) === 0
  );
}

function price(
  deps: JoinDeps,
  turn: PendingSplitTurn,
  sums: RowSums | null,
): PriceTurnResult {
  // With rows in hand the log is the finer instrument: it counts the same
  // requests bb counted, split the way bb refuses to split them.
  return deps.priceTurn(
    {
      provider: turn.provider_id ?? "",
      model: sums?.model ?? turn.model_requested,
      inputTokens: sums ? sums.input : turn.input_tokens,
      cacheReadTokens: sums ? sums.cacheRead : null,
      cacheWriteTokens: sums ? sums.cacheWrite : null,
      cachedInputTokens: sums
        ? sums.cacheRead + sums.cacheWrite
        : turn.cached_input_tokens,
      outputTokens: sums ? sums.output : turn.output_tokens,
      reasoningTokens: sums ? sums.reasoning : turn.reasoning_tokens,
      loggedCostUsd: sums?.loggedCostUsd ?? null,
    },
    deps.catalog,
  );
}

/** Per-turn provenance, kept out of the schema: obs_match has no detail column. */
interface TurnDetail {
  rows: number;
  models: string[];
  /** `bb` when bb's own totals stand, `log` when the log supplied them. */
  tokenSource: "bb" | "log";
}

interface SessionStats {
  provider: string;
  session: string;
  turns: Record<string, TurnDetail>;
  unattributedBefore: number;
  unattributedAfter: number;
}

/**
 * Match one session's pending turns against its log rows.
 *
 * Returns the stats it also records under `join:<provider>:<session>`.
 */
export function joinSession(
  deps: JoinDeps,
  turns: readonly PendingSplitTurn[],
): JoinSummary {
  const summary = emptySummary(turns.length);
  const first = turns[0];
  if (!first?.provider_thread_id || !first.provider_id) {
    summary.unavailable = turns.length;
    return summary;
  }

  const ordered = turns
    .slice()
    .sort(
      (a, b) =>
        (a.started_at ?? "").localeCompare(b.started_at ?? "") ||
        a.turn_id.localeCompare(b.turn_id),
    );

  // The whole session, not a union of windows: the partition itself decides
  // what belongs where, and a window filter here would only re-create the
  // stranding it replaces.
  const rows = deps.logs.listLogTurns({
    provider: first.provider_id,
    providerThreadId: first.provider_thread_id,
    tsFrom: 0,
    tsTo: Number.MAX_SAFE_INTEGER,
  });
  const main = rows.filter((row) => row.is_sidechain !== 1);
  const sidechains = rows.filter((row) => row.is_sidechain === 1);

  const partition = partitionRows(ordered, main);
  const stats: SessionStats = {
    provider: first.provider_id,
    session: first.provider_thread_id,
    turns: {},
    unattributedBefore: partition.before.length,
    unattributedAfter: partition.after.length,
  };
  summary.unattributedBefore = partition.before.length;
  summary.unattributedAfter = partition.after.length;

  ordered.forEach((turn, index) => {
    const slice = partition.buckets[index] as LogTurn[];
    const sums = slice.length > 0 ? sumRows(slice) : null;

    if (!sums) {
      // No fabricated split: the columns stay NULL and the row says so.
      deps.events.updateTurnSplit({
        thread_id: turn.thread_id,
        turn_id: turn.turn_id,
        cache_read_tokens: null,
        cache_write_tokens: null,
        model_reported: null,
        split_source: "unavailable",
      });
      summary.unavailable += 1;
    } else {
      const exact = isExactMatch(turn, sums);
      const method = exact ? "log-exact" : "log-window";
      const zeroToken = isZeroToken(turn);
      summary.rows += sums.rows;

      // bb saw nothing; the log saw eight requests. The log is then not a
      // refinement of the turn's tokens, it IS the turn's tokens.
      if (zeroToken) {
        deps.store.upsertTurn({
          thread_id: turn.thread_id,
          turn_id: turn.turn_id,
          input_tokens: sums.input,
          cached_input_tokens: sums.cacheRead + sums.cacheWrite,
          output_tokens: sums.output,
          reasoning_tokens: sums.reasoning,
        });
      }

      deps.events.upsertMatch({
        thread_id: turn.thread_id,
        turn_id: turn.turn_id,
        log_key: sums.lastLogKey ?? "",
        method: "partition",
        confidence: exact ? 1 : 0.8,
      });
      deps.events.updateTurnSplit({
        thread_id: turn.thread_id,
        turn_id: turn.turn_id,
        cache_read_tokens: sums.cacheRead,
        cache_write_tokens: sums.cacheWrite,
        model_reported: sums.model,
        split_source: method,
      });
      stats.turns[turn.turn_id] = {
        rows: sums.rows,
        models: sums.models,
        tokenSource: zeroToken ? "log" : "bb",
      };
      if (exact) summary.logExact += 1;
      else summary.logWindow += 1;
    }

    const cost = price(deps, turn, sums);
    deps.events.updateTurnCost({
      thread_id: turn.thread_id,
      turn_id: turn.turn_id,
      cost_usd: cost.costUsd,
      cost_source: cost.costSource,
      pricing_status: cost.pricingStatus,
      cache_savings_usd: cost.cacheSavingsUsd,
    });
  });

  summary.sidechain = joinSidechains(deps, ordered, sidechains, stats);

  // A cheap slot that already exists, so the stats survive the process
  // without a schema change.
  deps.store.setMeta(
    `join:${stats.provider}:${stats.session}`,
    JSON.stringify(stats),
  );
  return summary;
}

/**
 * Deliver seats that ran as in-session subagents never became bb threads.
 * They are real spend inside the parent's session, so each agent becomes one
 * synthetic child turn per parent turn it wrote rows under.
 *
 * Partitioned per agent by the same rule as the main chain, which is what
 * makes "consumed once" structural rather than a claimed-set bookkeeping.
 */
function joinSidechains(
  deps: JoinDeps,
  ordered: readonly PendingSplitTurn[],
  sidechains: readonly LogTurn[],
  stats: SessionStats,
): number {
  const byAgent = new Map<string, LogTurn[]>();
  for (const row of sidechains) {
    const key = row.agent_id ?? "";
    const bucket = byAgent.get(key);
    if (bucket) bucket.push(row);
    else byAgent.set(key, [row]);
  }

  let created = 0;
  for (const [agentId, agentRows] of [...byAgent.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const partition = partitionRows(ordered, agentRows);
    stats.unattributedBefore += partition.before.length;
    stats.unattributedAfter += partition.after.length;
    partition.buckets.forEach((slice, index) => {
      if (slice.length === 0) return;
      const turn = ordered[index] as PendingSplitTurn;
      const sums = sumRows(slice);
      const turnId = sidechainTurnId(turn.turn_id, agentId);
      const child = price(
        deps,
        { ...turn, cached_input_tokens: null, output_tokens: null },
        sums,
      );
      deps.store.upsertTurn({
        thread_id: turn.thread_id,
        turn_id: turnId,
        root_thread_id: null,
        started_at: new Date((slice[0] as LogTurn).ts).toISOString(),
        completed_at: new Date(
          (slice[slice.length - 1] as LogTurn).ts,
        ).toISOString(),
        model_reported: sums.model,
        input_tokens: sums.input,
        cached_input_tokens: sums.cacheRead + sums.cacheWrite || null,
        cache_read_tokens: sums.cacheRead,
        cache_write_tokens: sums.cacheWrite,
        output_tokens: sums.output,
        reasoning_tokens: sums.reasoning,
        cost_usd: child.costUsd,
        cost_source: child.costSource,
        pricing_status: child.pricingStatus,
        cache_savings_usd: child.cacheSavingsUsd,
        split_source: "sidechain",
      });
      deps.events.upsertMatch({
        thread_id: turn.thread_id,
        turn_id: turnId,
        log_key: sums.lastLogKey ?? "",
        method: "partition",
        confidence: 0.8,
      });
      stats.turns[turnId] = {
        rows: sums.rows,
        models: sums.models,
        tokenSource: "log",
      };
      created += 1;
    });
  }
  return created;
}

/** Join every turn still missing a split, newest sessions included. */
export function joinPendingTurns(deps: JoinDeps, limit = 500): JoinSummary {
  const pending = deps.events.listTurnsPendingSplit(limit);
  const groups = new Map<string, PendingSplitTurn[]>();
  for (const turn of pending) {
    const key = groupKey(turn);
    const bucket = groups.get(key);
    if (bucket) bucket.push(turn);
    else groups.set(key, [turn]);
  }
  const total = emptySummary();
  for (const bucket of groups.values()) {
    const summary = joinSession(deps, bucket);
    total.considered += summary.considered;
    total.logExact += summary.logExact;
    total.logWindow += summary.logWindow;
    total.sidechain += summary.sidechain;
    total.unavailable += summary.unavailable;
    total.rows += summary.rows;
    total.unattributedBefore += summary.unattributedBefore;
    total.unattributedAfter += summary.unattributedAfter;
  }
  return total;
}
