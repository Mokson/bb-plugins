// The ingest and join half of the ledger's write surface.
//
// `ObservatoryStore` owns the row shapes every module reads. This file adds
// the statements only ingest and the log join need: the event watermark, the
// pending-split queue, the match table, and the two narrow column updates that
// must NOT go through a full turn upsert (a join writes four columns and must
// never clobber the twenty-six that events own).
import type { Database, Statement } from "better-sqlite3";
import type { SplitSource } from "./store.js";

/**
 * How long a `log-window` turn stays eligible for another join pass.
 *
 * A turn is joined within a minute of completing, while bb's own usage event
 * and the provider's JSONL flush are both still settling. The first pass
 * therefore compares a finished slice against unfinished bb totals and
 * labels the turn `log-window`; measured on the live ledger, 340 of 393
 * `log-window` claude-code turns became exact once the same partition was
 * re-run later. Excluding `log-window` from the pending queue froze that
 * first, premature verdict forever, so it is now retried while the turn is
 * young enough for either side to still be moving. `log-exact` and
 * `sidechain` are terminal: there is nothing better to find.
 */
export const REJOIN_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface PendingSplitTurn {
  thread_id: string;
  turn_id: string;
  provider_id: string | null;
  provider_thread_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  reasoning_tokens: number | null;
  model_requested: string | null;
  split_source: SplitSource | null;
}

export interface MatchRow {
  thread_id: string;
  turn_id: string;
  log_key: string;
  method: string;
  confidence: number;
}

export interface SplitUpdate {
  thread_id: string;
  turn_id: string;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  model_reported: string | null;
  split_source: SplitSource;
}

export interface CostUpdate {
  thread_id: string;
  turn_id: string;
  cost_usd: number | null;
  cost_source: string | null;
  pricing_status: string | null;
  cache_savings_usd: number | null;
}

export interface CoverageView {
  turns: number;
  logExact: number;
  logWindow: number;
  sidechain: number;
  unavailable: number;
}

/** One provider's slice of `CoverageView`. */
export interface ProviderCoverageView extends CoverageView {
  provider: string;
}

export interface StaleThread {
  thread_id: string;
  last_event_seq: number | null;
  last_seen_at: string | null;
  status: string | null;
}

export class EventStore {
  readonly db: Database;
  private readonly getWatermarkStatement: Statement<
    [string],
    { last_event_seq: number | null } | undefined
  >;
  private readonly setWatermarkStatement: Statement;
  private readonly upsertMatchStatement: Statement;
  private readonly pendingSplitStatement: Statement<
    [{ cutoff: string; limit: number }],
    PendingSplitTurn
  >;
  private readonly pendingPriceStatement: Statement<
    [string],
    PendingSplitTurn
  >;
  private readonly turnsForThreadStatement: Statement<
    [string],
    PendingSplitTurn
  >;
  private readonly threadsByRootStatement: Statement<[string], { thread_id: string }>;
  private readonly updateSeatStatement: Statement;
  private readonly updateSplitStatement: Statement;
  private readonly updateCostStatement: Statement;
  private readonly staleThreadsStatement: Statement<[string, number], StaleThread>;
  private readonly coverageStatement: Statement<
    [{ provider: string | null }],
    CoverageView
  >;
  private readonly coverageByProviderStatement: Statement<
    [{ provider: string | null }],
    ProviderCoverageView
  >;

  constructor(db: Database) {
    this.db = db;
    this.getWatermarkStatement = db.prepare(
      "SELECT last_event_seq FROM obs_thread WHERE thread_id = ?",
    );
    // The watermark only ever moves FORWARD: a concurrent drain that read an
    // older page must not rewind the tail the next drain starts from.
    this.setWatermarkStatement = db.prepare(
      `UPDATE obs_thread
          SET last_event_seq = MAX(COALESCE(last_event_seq, -1), @seq),
              last_seen_at = @at
        WHERE thread_id = @thread_id`,
    );
    this.upsertMatchStatement = db.prepare(
      `INSERT INTO obs_match (thread_id, turn_id, log_key, method, confidence)
       VALUES (@thread_id, @turn_id, @log_key, @method, @confidence)
       ON CONFLICT(thread_id, turn_id) DO UPDATE SET
         log_key = excluded.log_key,
         method = excluded.method,
         confidence = excluded.confidence`,
    );
    // Only turns that could still gain a BETTER split: completed, in a thread
    // whose provider session is known, and not already proven exact. Turns
    // with no split yet sort first, so a backlog of young `log-window` turns
    // can never push a never-joined turn past the page limit.
    this.pendingSplitStatement = db.prepare(
      `SELECT t.thread_id, t.turn_id, h.provider_id, h.provider_thread_id,
              t.started_at, t.completed_at, t.cached_input_tokens,
              t.output_tokens, t.input_tokens, t.reasoning_tokens,
              t.model_requested, t.split_source
         FROM obs_turn t
         JOIN obs_thread h ON h.thread_id = t.thread_id
        WHERE (t.split_source IS NULL
               OR t.split_source = 'unavailable'
               OR (t.split_source = 'log-window' AND t.started_at > @cutoff))
          AND h.provider_thread_id IS NOT NULL
          AND t.completed_at IS NOT NULL
        ORDER BY (t.split_source = 'log-window'), t.started_at
        LIMIT @limit`,
    );
    // Pricing must not wait for the join. A turn bb has already reported
    // tokens and a model for is priceable from bb's numbers alone, and the
    // join only ever refines that. Turns already carrying a `pricing_status`
    // are left alone: the join's figure, built on the finer log split, wins.
    this.pendingPriceStatement = db.prepare(
      `SELECT t.thread_id, t.turn_id, h.provider_id, h.provider_thread_id,
              t.started_at, t.completed_at, t.cached_input_tokens,
              t.output_tokens, t.input_tokens, t.reasoning_tokens,
              t.model_requested, t.split_source
         FROM obs_turn t
         JOIN obs_thread h ON h.thread_id = t.thread_id
        WHERE t.thread_id = ?
          AND t.pricing_status IS NULL
          AND t.completed_at IS NOT NULL
          AND (t.split_source IS NULL OR t.split_source <> 'sidechain')
        ORDER BY t.started_at, t.turn_id`,
    );
    // Every real turn of one thread, pending or not. The join partitions over
    // this, not over the pending queue: a matched turn between two pending
    // ones is still a boundary. Synthetic sidechain children are excluded -
    // they are outputs of the partition, never inputs to it.
    this.turnsForThreadStatement = db.prepare(
      `SELECT t.thread_id, t.turn_id, h.provider_id, h.provider_thread_id,
              t.started_at, t.completed_at, t.cached_input_tokens,
              t.output_tokens, t.input_tokens, t.reasoning_tokens,
              t.model_requested, t.split_source
         FROM obs_turn t
         JOIN obs_thread h ON h.thread_id = t.thread_id
        WHERE t.thread_id = ?
          AND (t.split_source IS NULL OR t.split_source <> 'sidechain')
        ORDER BY t.started_at, t.turn_id`,
    );
    this.threadsByRootStatement = db.prepare(
      "SELECT thread_id FROM obs_thread WHERE root_thread_id = ? ORDER BY depth, thread_id",
    );
    this.updateSeatStatement = db.prepare(
      "UPDATE obs_thread SET seat = @seat, tier_tag = @tier_tag WHERE thread_id = @thread_id",
    );
    this.updateSplitStatement = db.prepare(
      `UPDATE obs_turn
          SET cache_read_tokens = @cache_read_tokens,
              cache_write_tokens = @cache_write_tokens,
              model_reported = COALESCE(@model_reported, model_reported),
              split_source = @split_source
        WHERE thread_id = @thread_id AND turn_id = @turn_id`,
    );
    this.updateCostStatement = db.prepare(
      `UPDATE obs_turn
          SET cost_usd = @cost_usd,
              cost_source = @cost_source,
              pricing_status = @pricing_status,
              cache_savings_usd = @cache_savings_usd
        WHERE thread_id = @thread_id AND turn_id = @turn_id`,
    );
    this.staleThreadsStatement = db.prepare(
      `SELECT thread_id, last_event_seq, last_seen_at, status
         FROM obs_thread
        WHERE (status IS NULL OR status NOT IN ('archived', 'deleted'))
          AND (last_seen_at IS NULL OR last_seen_at < ?)
        ORDER BY COALESCE(last_seen_at, '')
        LIMIT ?`,
    );
    // The exactness gate is per provider - one provider with no parser can
    // otherwise drag a healthy one under the bar, and the number nobody can
    // segment is the number nobody can act on. `@provider` of NULL means all.
    const coverageColumns = `COUNT(*) AS turns,
              COALESCE(SUM(t.split_source = 'log-exact'), 0) AS logExact,
              COALESCE(SUM(t.split_source = 'log-window'), 0) AS logWindow,
              COALESCE(SUM(t.split_source = 'sidechain'), 0) AS sidechain,
              COALESCE(SUM(t.split_source IS NULL
                           OR t.split_source = 'unavailable'), 0)
                AS unavailable`;
    this.coverageStatement = db.prepare(
      `SELECT ${coverageColumns}
         FROM obs_turn t
         LEFT JOIN obs_thread h ON h.thread_id = t.thread_id
        WHERE (@provider IS NULL OR h.provider_id = @provider)`,
    );
    this.coverageByProviderStatement = db.prepare(
      `SELECT COALESCE(h.provider_id, 'unknown') AS provider, ${coverageColumns}
         FROM obs_turn t
         LEFT JOIN obs_thread h ON h.thread_id = t.thread_id
        WHERE (@provider IS NULL OR h.provider_id = @provider)
        GROUP BY provider
        ORDER BY provider`,
    );
  }

  watermark(threadId: string): number | null {
    return this.getWatermarkStatement.get(threadId)?.last_event_seq ?? null;
  }

  setWatermark(threadId: string, seq: number, at: string): void {
    this.setWatermarkStatement.run({ thread_id: threadId, seq, at });
  }

  upsertMatch(row: MatchRow): void {
    this.upsertMatchStatement.run(row);
  }

  /**
   * `cutoff` is the oldest `started_at` a `log-window` turn may have and
   * still be retried. The empty string sorts below every ISO timestamp, so
   * an explicitly requested backfill can retry the whole history.
   */
  listTurnsPendingSplit(limit = 500, cutoff = ""): PendingSplitTurn[] {
    return this.pendingSplitStatement.all({ cutoff, limit });
  }

  /** The default retry horizon: turns young enough to still be settling. */
  static rejoinCutoff(now = Date.now()): string {
    return new Date(now - REJOIN_WINDOW_MS).toISOString();
  }

  /** One thread's completed turns that carry no price yet, oldest first. */
  listTurnsPendingPrice(threadId: string): PendingSplitTurn[] {
    return this.pendingPriceStatement.all(threadId);
  }

  /** Every non-sidechain turn of one thread, oldest first. */
  listTurnsForThread(threadId: string): PendingSplitTurn[] {
    return this.turnsForThreadStatement.all(threadId);
  }

  listThreadsByRoot(rootThreadId: string): string[] {
    return this.threadsByRootStatement
      .all(rootThreadId)
      .map((row) => row.thread_id);
  }

  updateThreadSeat(
    threadId: string,
    seat: string | null,
    tierTag: string | null,
  ): void {
    this.updateSeatStatement.run({
      thread_id: threadId,
      seat,
      tier_tag: tierTag,
    });
  }

  updateTurnSplit(update: SplitUpdate): void {
    this.updateSplitStatement.run(update);
  }

  updateTurnCost(update: CostUpdate): void {
    this.updateCostStatement.run(update);
  }

  /** Threads whose last drain is older than `before`, oldest first. */
  listStaleThreads(before: string, limit = 50): StaleThread[] {
    return this.staleThreadsStatement.all(before, limit);
  }

  coverage(provider: string | null = null): CoverageView {
    const row = this.coverageStatement.get({ provider });
    return {
      turns: row?.turns ?? 0,
      logExact: row?.logExact ?? 0,
      logWindow: row?.logWindow ?? 0,
      sidechain: row?.sidechain ?? 0,
      unavailable: row?.unavailable ?? 0,
    };
  }

  /** The same view, one row per provider. */
  coverageByProvider(
    provider: string | null = null,
  ): ProviderCoverageView[] {
    return this.coverageByProviderStatement.all({ provider });
  }
}
