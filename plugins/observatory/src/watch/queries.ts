// Watch's read side. Every rule reads the ledger through one snapshot, so the
// rules themselves are pure functions over plain data and a rule test needs no
// database at all.
//
// Nothing here writes. The only writer of `obs_turn`/`obs_item`/`obs_thread`
// is core, and watch reading its own derived state back out is what keeps the
// two modules from needing a shared cache.
import type { Database, Statement } from "better-sqlite3";

/** Items kept per snapshot. The widest rule window is the last 20 items; the
 * oscillation rule needs the commands interleaved with them, so the read is
 * deliberately wider than the widest single rule. */
export const ITEM_WINDOW = 60;
/** The window the retry-storm rule counts errors inside. */
export const RETRY_WINDOW_MS = 10 * 60 * 1_000;

export interface ItemFact {
  itemId: string;
  seq: number;
  kind: string;
  name: string;
  path: string | null;
  fingerprint: string | null;
  startedAt: number | null;
  completedAt: number | null;
  status: string | null;
}

export interface ThreadFact {
  threadId: string;
  title: string;
  seat: string | null;
  status: string | null;
  rootThreadId: string;
}

export interface WatchSnapshot {
  thread: ThreadFact;
  now: number;
  /** Ascending by seq: the rules walk them forward. */
  items: ItemFact[];
  /** Latest timestamp any turn or item on this thread carries. */
  lastEventAt: number | null;
  /** The item that started and has not completed. */
  openItem: ItemFact | null;
  openTurn: boolean;
  lastTurnStartedAt: number | null;
  /** When the last turn ENDED, or null while it is still running. */
  lastTurnCompletedAt: number | null;
  lastTurnId: string | null;
  /** Item seq of the most recent fileChange, the burn rule's anchor. */
  lastFileChangeSeq: number | null;
  tokensSinceFileChange: number;
  /** Turns that failed with `willRetry` inside the retry window, oldest first. */
  retries: Array<{ turnId: string; at: number }>;
  treeCostUsd: number;
  dayCostUsd: number;
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function maxOf(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

interface ThreadRowLite {
  thread_id: string;
  title: string | null;
  seat: string | null;
  status: string | null;
  root_thread_id: string | null;
}

interface ItemRowLite {
  item_id: string;
  seq: number | null;
  kind: string | null;
  name: string | null;
  path: string | null;
  input_fingerprint: string | null;
  started_at: string | null;
  completed_at: string | null;
  status: string | null;
}

interface TurnRowLite {
  turn_id: string;
  seq_started: number | null;
  started_at: string | null;
  completed_at: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  error_category: string | null;
  will_retry: number | null;
}

interface ThreadSteerRowLite {
  thread_id: string;
  title: string | null;
  status: string | null;
  visibility: string | null;
  origin: string | null;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  run_folder: string | null;
}

/** The thread facts the ladder's guards and the premise reminder read. */
export interface ThreadSteerFact {
  threadId: string;
  title: string;
  status: string | null;
  visibility: string | null;
  origin: string | null;
  parentThreadId: string | null;
  rootThreadId: string;
  runFolder: string | null;
  silentMs: number | null;
}

/** One recorded ladder send. `detail` is `<rule>: <evidence>` when a rule drove it. */
export interface SteerActionRow {
  id: number;
  action: string;
  at: string;
  detail: string | null;
  result: string | null;
}

export interface SignalRowLite {
  id: number;
  module: string;
  kind: string;
  thread_id: string | null;
  severity: string | null;
  opened_at: string;
  closed_at: string | null;
  payload: string | null;
  dedupe_key: string;
}

/** Prepared once, like the write side: the sweep runs every minute over every
 * active thread, and re-preparing there would dominate its cost. */
export class WatchQueries {
  private readonly activeThreadsStatement: Statement<[], ThreadRowLite>;
  private readonly threadStatement: Statement<[string], ThreadRowLite>;
  private readonly itemsStatement: Statement<[string, number], ItemRowLite>;
  private readonly turnsStatement: Statement<[string], TurnRowLite>;
  private readonly treeCostStatement: Statement<[string], { total: number | null }>;
  private readonly dayCostStatement: Statement<
    [string, string],
    { total: number | null }
  >;
  private readonly openSignalsStatement: Statement<[string], SignalRowLite>;
  private readonly threadSignalsStatement: Statement<[string, number], SignalRowLite>;
  private readonly actionsStatement: Statement<
    [string, number],
    { id: number; action: string; at: string; detail: string | null }
  >;
  private readonly allOpenSignalsStatement: Statement<[number], SignalRowLite>;
  private readonly allSignalsStatement: Statement<[number], SignalRowLite>;
  private readonly queueCountStatement: Statement<[string], { n: number }>;
  private readonly stalledCountStatement: Statement<
    [string, string],
    { n: number }
  >;
  private readonly overBudgetCountStatement: Statement<[string], { n: number }>;
  private readonly steerContextStatement: Statement<[string], ThreadSteerRowLite>;
  private readonly steerHistoryStatement: Statement<
    [string, string],
    SteerActionRow
  >;
  private readonly steerCountStatement: Statement<
    [string, string],
    { n: number }
  >;
  private readonly steerCountOverallStatement: Statement<
    [string],
    { n: number }
  >;
  private readonly staleOpenSignalsStatement: Statement<[], SignalRowLite>;
  private readonly lastCompactedTurnStatement: Statement<
    [string],
    { turn_id: string }
  >;

  constructor(private readonly db: Database) {
    // "active" is bb's own lifecycle status, written by core from the
    // `thread.active` event. An idle or archived thread cannot stall.
    this.activeThreadsStatement = db.prepare(
      `SELECT thread_id, title, seat, status, root_thread_id
         FROM obs_thread WHERE status = 'active' ORDER BY thread_id`,
    );
    this.threadStatement = db.prepare(
      `SELECT thread_id, title, seat, status, root_thread_id
         FROM obs_thread WHERE thread_id = ?`,
    );
    this.itemsStatement = db.prepare(
      `SELECT item_id, seq, kind, name, path, input_fingerprint,
              started_at, completed_at, status
         FROM obs_item WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
    );
    this.turnsStatement = db.prepare(
      `SELECT turn_id, seq_started, started_at, completed_at, input_tokens,
              cached_input_tokens, output_tokens, reasoning_tokens,
              error_category, will_retry
         FROM obs_turn WHERE thread_id = ? ORDER BY seq_started DESC LIMIT 100`,
    );
    this.treeCostStatement = db.prepare(
      "SELECT SUM(cost_usd) AS total FROM obs_turn WHERE root_thread_id = ?",
    );
    // A half-open RANGE, not `substr(started_at, 1, 10) = ?`. Wrapping the
    // column in a function makes `obs_turn_started` unusable and turns the
    // per-minute sweep's day rollup into a full scan per active thread.
    this.dayCostStatement = db.prepare(
      `SELECT SUM(cost_usd) AS total FROM obs_turn
        WHERE started_at >= ? AND started_at < ?`,
    );
    this.openSignalsStatement = db.prepare(
      `SELECT id, module, kind, thread_id, severity, opened_at, closed_at,
              payload, dedupe_key
         FROM obs_signal
        WHERE module = 'watch' AND thread_id = ? AND closed_at IS NULL`,
    );
    this.threadSignalsStatement = db.prepare(
      `SELECT id, module, kind, thread_id, severity, opened_at, closed_at,
              payload, dedupe_key
         FROM obs_signal
        WHERE module = 'watch' AND thread_id = ?
        ORDER BY opened_at DESC, id DESC LIMIT ?`,
    );
    this.actionsStatement = db.prepare(
      `SELECT id, action, at, detail FROM obs_action
        WHERE thread_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    );
    this.allOpenSignalsStatement = db.prepare(
      `SELECT id, module, kind, thread_id, severity, opened_at, closed_at,
              payload, dedupe_key
         FROM obs_signal WHERE closed_at IS NULL
        ORDER BY opened_at DESC, id DESC LIMIT ?`,
    );
    this.allSignalsStatement = db.prepare(
      `SELECT id, module, kind, thread_id, severity, opened_at, closed_at,
              payload, dedupe_key
         FROM obs_signal WHERE module = 'watch'
        ORDER BY opened_at DESC, id DESC LIMIT ?`,
    );
    // The inbox counts are totals over every open row, not over the page the
    // list renders, so they are COUNT(*)s rather than a length of the slice.
    // The module and stall-kind lists arrive as JSON so the caller keeps
    // owning which sources and which rules count, without a rebuilt statement.
    const openAndKnown = `FROM obs_signal
        WHERE closed_at IS NULL
          AND module IN (SELECT value FROM json_each(?))`;
    this.queueCountStatement = db.prepare(
      `SELECT COUNT(*) AS n ${openAndKnown}`,
    );
    this.stalledCountStatement = db.prepare(
      `SELECT COUNT(DISTINCT thread_id) AS n ${openAndKnown}
          AND module = 'watch'
          AND thread_id IS NOT NULL
          AND kind IN (SELECT value FROM json_each(?))`,
    );
    this.overBudgetCountStatement = db.prepare(
      `SELECT COUNT(*) AS n ${openAndKnown} AND kind LIKE '%budget%'`,
    );
    this.steerContextStatement = db.prepare(
      `SELECT thread_id, title, status, visibility, origin, parent_thread_id,
              root_thread_id, run_folder
         FROM obs_thread WHERE thread_id = ?`,
    );
    // `result` is the ladder's verdict vocabulary; only the two that reached a
    // thread count as a send.
    const sentSteer = `FROM obs_action
        WHERE action IN ('steer','escalate')
          AND result IN ('steered','escalated')
          AND at > ?`;
    this.steerHistoryStatement = db.prepare(
      `SELECT id, action, at, detail, result FROM obs_action
        WHERE action IN ('steer','escalate')
          AND result IN ('steered','escalated')
          AND thread_id = ? AND at > ?
        ORDER BY at ASC, id ASC`,
    );
    this.steerCountStatement = db.prepare(
      `SELECT COUNT(*) AS n FROM obs_action
        WHERE action IN ('steer','escalate')
          AND result IN ('steered','escalated')
          AND thread_id = ? AND at > ?`,
    );
    this.steerCountOverallStatement = db.prepare(
      `SELECT COUNT(*) AS n ${sentSteer}`,
    );
    // A LEFT JOIN, not an inner one: a signal whose thread row was pruned is
    // as stale as one whose thread went idle, and an inner join would leave it
    // open forever for want of a row to compare against.
    this.staleOpenSignalsStatement = db.prepare(
      `SELECT s.id, s.module, s.kind, s.thread_id, s.severity, s.opened_at,
              s.closed_at, s.payload, s.dedupe_key
         FROM obs_signal s
         LEFT JOIN obs_thread t ON t.thread_id = s.thread_id
        WHERE s.module = 'watch'
          AND s.closed_at IS NULL
          AND s.thread_id IS NOT NULL
          AND (t.thread_id IS NULL OR t.status IS NULL OR t.status != 'active')
        ORDER BY s.id`,
    );
    this.lastCompactedTurnStatement = db.prepare(
      `SELECT turn_id FROM obs_turn
        WHERE thread_id = ? AND compacted = 1
        ORDER BY seq_started DESC LIMIT 1`,
    );
  }

  /**
   * Open-signal totals for the inbox header: every open row from a known
   * module, the distinct threads a stall rule holds open, and the rows naming
   * a budget.
   */
  openCounts(
    modules: readonly string[],
    stallKinds: readonly string[],
  ): { queue: number; stalled: number; overBudget: number } {
    const sources = JSON.stringify(modules);
    return {
      queue: this.queueCountStatement.get(sources)?.n ?? 0,
      stalled:
        this.stalledCountStatement.get(sources, JSON.stringify(stallKinds))
          ?.n ?? 0,
      overBudget: this.overBudgetCountStatement.get(sources)?.n ?? 0,
    };
  }

  activeThreads(): ThreadFact[] {
    return this.activeThreadsStatement.all().map(toThreadFact);
  }

  /**
   * Just the two liveness facts the watch list renders per row.
   *
   * The list used to call `snapshot`, which sums subtree AND day cost for
   * every row — two aggregates over `obs_turn` per active thread, for a view
   * that shows neither. The rules need the full snapshot; a list does not.
   */
  liveness(threadId: string): {
    lastEventAt: number | null;
    openItem: ItemFact | null;
  } {
    const items = this.itemsStatement
      .all(threadId, ITEM_WINDOW)
      .map(toItemFact);
    const turns = this.turnsStatement.all(threadId);
    return {
      lastEventAt: maxOf([
        ...items.flatMap((item) => [item.startedAt, item.completedAt]),
        ...turns.flatMap((turn) => [
          toMs(turn.started_at),
          toMs(turn.completed_at),
        ]),
      ]),
      // `itemsStatement` is newest-first, so the first in-flight item it
      // returns is the most recent one.
      openItem:
        items.find(
          (item) => item.startedAt !== null && item.completedAt === null,
        ) ?? null,
    };
  }

  thread(threadId: string): ThreadFact | null {
    const row = this.threadStatement.get(threadId);
    return row ? toThreadFact(row) : null;
  }

  /**
   * Everything the ladder's guards read, in one statement.
   *
   * Separate from `thread()` because the guards need three columns the rules
   * never look at — `visibility`, `origin`, `parent_thread_id` — and widening
   * `ThreadFact` would put them in every rule's snapshot for no reader.
   *
   * `silentMs` comes from `liveness`, which is the same measurement the stalls
   * page renders, so the number in a steer and the number on the page cannot
   * disagree.
   */
  steerContext(threadId: string, now: number): ThreadSteerFact | null {
    const row = this.steerContextStatement.get(threadId);
    if (!row) return null;
    const { lastEventAt } = this.liveness(threadId);
    return {
      threadId: row.thread_id,
      title: row.title ?? row.thread_id,
      status: row.status,
      visibility: row.visibility,
      origin: row.origin,
      parentThreadId: row.parent_thread_id,
      rootThreadId: row.root_thread_id ?? row.thread_id,
      runFolder: row.run_folder,
      silentMs: lastEventAt === null ? null : now - lastEventAt,
    };
  }

  /**
   * Ladder sends on one thread strictly after `since`, oldest first.
   *
   * Only rows that actually reached a thread count. A refusal row carries the
   * reason it did not send in `result`, and counting those toward the cooldown
   * would let a quiet-hours window silence the following hour too.
   */
  steerHistory(threadId: string, since: string): SteerActionRow[] {
    return this.steerHistoryStatement.all(threadId, since);
  }

  /** The same rows, counted for this thread and across every thread. */
  steerCounts(
    threadId: string,
    since: string,
  ): { thread: number; overall: number } {
    return {
      thread: this.steerCountStatement.get(threadId, since)?.n ?? 0,
      overall: this.steerCountOverallStatement.get(since)?.n ?? 0,
    };
  }

  /**
   * Open watch signals whose thread is no longer running.
   *
   * The other half of the reconcile. `evaluateThread` closes a signal whose
   * rule stopped holding, but it only ever runs for threads the sweep still
   * considers active — so a thread that finished while a signal was open left
   * that signal open forever. In the live database that was every open row:
   * 235 of 235 sat on an idle or errored thread.
   */
  staleOpenSignals(): SignalRowLite[] {
    return this.staleOpenSignalsStatement.all();
  }

  /**
   * The id of this thread's most recent compacted turn, or null.
   *
   * Core marks `obs_turn.compacted` from the `thread/compacted` event, so
   * watch detects a compaction by reading the ledger rather than by opening a
   * second subscription to the event stream. The turn id is what the premise
   * reminder's watermark stores: "the compaction I have already answered".
   */
  lastCompactedTurnId(threadId: string): string | null {
    return this.lastCompactedTurnStatement.get(threadId)?.turn_id ?? null;
  }

  openSignals(threadId: string): SignalRowLite[] {
    return this.openSignalsStatement.all(threadId);
  }

  signalsForThread(threadId: string, limit = 50): SignalRowLite[] {
    return this.threadSignalsStatement.all(threadId, limit);
  }

  actionsForThread(threadId: string, limit = 50) {
    return this.actionsStatement.all(threadId, limit);
  }

  signals(options: { threadId?: string; open?: boolean; limit?: number }) {
    const limit = options.limit ?? 100;
    const rows = options.threadId
      ? this.signalsForThread(options.threadId, limit)
      : this.allSignalsStatement.all(limit);
    return options.open ? rows.filter((row) => row.closed_at === null) : rows;
  }

  openSignalsAllModules(limit = 200): SignalRowLite[] {
    return this.allOpenSignalsStatement.all(limit);
  }

  /**
   * Everything the rules need for one thread, read in one place.
   *
   * Synchronous on purpose. better-sqlite3 is synchronous, so a snapshot plus
   * its evaluation cannot interleave with another evaluation of the same
   * thread — that is the whole concurrency argument between the drain hook and
   * the minute sweep, and it only holds while nothing here awaits.
   */
  snapshot(threadId: string, now: number): WatchSnapshot | null {
    const thread = this.thread(threadId);
    if (!thread) return null;

    const items = this.itemsStatement
      .all(threadId, ITEM_WINDOW)
      .map(toItemFact)
      .reverse();
    const turns = this.turnsStatement.all(threadId);

    const openItem =
      [...items]
        .reverse()
        .find((item) => item.startedAt !== null && item.completedAt === null) ??
      null;

    const lastEventAt = maxOf([
      ...items.flatMap((item) => [item.startedAt, item.completedAt]),
      ...turns.flatMap((turn) => [
        toMs(turn.started_at),
        toMs(turn.completed_at),
      ]),
    ]);

    const openTurn = turns.some(
      (turn) => turn.started_at !== null && turn.completed_at === null,
    );
    const lastTurn = turns[0] ?? null;

    const lastFileChange = [...items]
      .reverse()
      .find((item) => item.kind === "fileChange");
    const lastFileChangeSeq = lastFileChange?.seq ?? null;

    // Turns are ordered newest first; count back to the turn that owned the
    // last file change. An absent anchor means the thread has changed nothing
    // yet, so every turn counts.
    //
    // Comparing `turn.seq_started` against an ITEM seq is sound because both
    // are the same number: core writes `seq_started` and `obs_item.seq` from
    // `row.seq` of one per-thread event page (`src/core/events.ts`, the
    // `turn/started` and item branches), so one sequence space orders turns
    // and items together.
    let tokensSinceFileChange = 0;
    for (const turn of turns) {
      if (
        lastFileChangeSeq !== null &&
        turn.seq_started !== null &&
        turn.seq_started < lastFileChangeSeq
      ) {
        break;
      }
      tokensSinceFileChange +=
        (turn.input_tokens ?? 0) +
        (turn.cached_input_tokens ?? 0) +
        (turn.output_tokens ?? 0) +
        (turn.reasoning_tokens ?? 0);
    }

    const retries = turns
      .filter((turn) => turn.will_retry === 1 && turn.error_category !== null)
      .map((turn) => ({
        turnId: turn.turn_id,
        at: toMs(turn.completed_at) ?? toMs(turn.started_at) ?? 0,
      }))
      .filter((entry) => entry.at > 0 && now - entry.at <= RETRY_WINDOW_MS)
      .sort((left, right) => left.at - right.at);

    const day = new Date(now).toISOString().slice(0, 10);
    const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      thread,
      now,
      items,
      lastEventAt,
      openItem,
      openTurn,
      lastTurnStartedAt: toMs(lastTurn?.started_at ?? null),
      lastTurnCompletedAt: toMs(lastTurn?.completed_at ?? null),
      lastTurnId: lastTurn?.turn_id ?? null,
      lastFileChangeSeq,
      tokensSinceFileChange,
      retries,
      treeCostUsd:
        this.treeCostStatement.get(thread.rootThreadId)?.total ?? 0,
      dayCostUsd: this.dayCostStatement.get(day, nextDay)?.total ?? 0,
    };
  }
}

function toThreadFact(row: ThreadRowLite): ThreadFact {
  return {
    threadId: row.thread_id,
    title: row.title ?? row.thread_id,
    seat: row.seat,
    status: row.status,
    rootThreadId: row.root_thread_id ?? row.thread_id,
  };
}

function toItemFact(row: ItemRowLite): ItemFact {
  return {
    itemId: row.item_id,
    seq: row.seq ?? 0,
    kind: row.kind ?? "unknown",
    name: row.name ?? row.kind ?? "unknown",
    path: row.path,
    fingerprint: row.input_fingerprint,
    startedAt: toMs(row.started_at),
    completedAt: toMs(row.completed_at),
    status: row.status,
  };
}
