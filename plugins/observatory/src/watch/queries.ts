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
  private readonly dayCostStatement: Statement<[string], { total: number | null }>;
  private readonly openSignalsStatement: Statement<[string], SignalRowLite>;
  private readonly threadSignalsStatement: Statement<[string, number], SignalRowLite>;
  private readonly actionsStatement: Statement<
    [string, number],
    { id: number; action: string; at: string; detail: string | null }
  >;
  private readonly allOpenSignalsStatement: Statement<[number], SignalRowLite>;
  private readonly allSignalsStatement: Statement<[number], SignalRowLite>;

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
    this.dayCostStatement = db.prepare(
      "SELECT SUM(cost_usd) AS total FROM obs_turn WHERE substr(started_at, 1, 10) = ?",
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
  }

  activeThreads(): ThreadFact[] {
    return this.activeThreadsStatement.all().map(toThreadFact);
  }

  thread(threadId: string): ThreadFact | null {
    const row = this.threadStatement.get(threadId);
    return row ? toThreadFact(row) : null;
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
    return {
      thread,
      now,
      items,
      lastEventAt,
      openItem,
      openTurn,
      lastTurnStartedAt: toMs(lastTurn?.started_at ?? null),
      lastTurnId: lastTurn?.turn_id ?? null,
      lastFileChangeSeq,
      tokensSinceFileChange,
      retries,
      treeCostUsd:
        this.treeCostStatement.get(thread.rootThreadId)?.total ?? 0,
      dayCostUsd: this.dayCostStatement.get(day)?.total ?? 0,
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
