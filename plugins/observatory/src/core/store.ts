// The ledger's only writer.
//
// Every statement is prepared once at construction: the ingest path upserts a
// turn per event batch, and re-preparing there would dominate its cost.
// Nothing here decides anything — the store persists what core computed, so
// the analyzers can be pure SQL over one shape.
import type { Database, Statement } from "better-sqlite3";
import { MIGRATIONS, OBS_LOG_TURN_COLUMNS } from "./migrations.js";

export { MIGRATIONS };

/** How a turn's cache read/write split was obtained. Never invented. */
export type SplitSource =
  | "log-exact"
  | "log-window"
  | "sidechain"
  | "unavailable";

export interface ThreadRow {
  thread_id: string;
  project_id: string | null;
  provider_id: string | null;
  provider_thread_id: string | null;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  depth: number;
  title: string | null;
  seat: string | null;
  tier_tag: string | null;
  visibility: string | null;
  origin: string | null;
  run_folder: string | null;
  cwd: string | null;
  created_at: string | null;
  last_event_seq: number | null;
  last_seen_at: string | null;
  status: string | null;
}

export interface TurnRow {
  thread_id: string;
  turn_id: string;
  root_thread_id: string | null;
  seq_started: number | null;
  seq_completed: number | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  model_requested: string | null;
  model_reported: string | null;
  effort: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  /** NULL until a log row proves the split. */
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  context_used: number | null;
  context_window: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  pricing_status: string | null;
  cache_savings_usd: number | null;
  tool_calls: number | null;
  file_changes: number | null;
  file_reads: number | null;
  compacted: number | null;
  error_category: string | null;
  will_retry: number | null;
  split_source: SplitSource | null;
}

export interface ItemRow {
  item_id: string;
  thread_id: string;
  turn_id: string | null;
  seq: number | null;
  kind: string | null;
  name: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  path: string | null;
  input_fingerprint: string | null;
  error: string | null;
}

export interface SignalRow {
  id: number;
  module: string;
  kind: string;
  thread_id: string | null;
  turn_id: string | null;
  severity: string | null;
  opened_at: string;
  closed_at: string | null;
  payload: string | null;
  dedupe_key: string;
}

export interface OpenSignal {
  module: string;
  kind: string;
  dedupeKey: string;
  threadId?: string | null;
  turnId?: string | null;
  severity?: string | null;
  openedAt: string;
  payload?: unknown;
}

export interface RecordAction {
  signalId?: number | null;
  threadId?: string | null;
  action: string;
  at: string;
  detail?: string | null;
  result?: string | null;
}

export interface StoreCounts {
  threads: number;
  turns: number;
  items: number;
  openSignals: number;
  actions: number;
}

/** Errors a re-executed idempotent statement is allowed to raise. */
const ALREADY_APPLIED = /already exists|duplicate column/i;

/** The columns a table currently has, empty when the table does not exist. */
function columnsOf(db: Database, table: string): string[] {
  return db
    .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name);
}

/**
 * Bring a pre-rebuild `obs_log_turn` to the current shape: SQLite cannot retype
 * a column in place, so the table is copied. Guarded on the absence of `path`,
 * which makes it a no-op on every database that has already been through it.
 */
function rebuildLogTurns(db: Database): void {
  const columns = columnsOf(db, "obs_log_turn");
  if (columns.length === 0 || columns.includes("path")) return;
  // Copied rows carry a null `path`: it cannot be recovered from the row. The
  // rename takes the old indexes with it, so they are recreated after.
  db.exec(`
    ALTER TABLE obs_log_turn RENAME TO obs_log_turn_v1;
    CREATE TABLE obs_log_turn (${OBS_LOG_TURN_COLUMNS});
    INSERT INTO obs_log_turn (
      log_key, provider, provider_thread_id, path, ts, model, input,
      cache_read, cache_write, output, reasoning, logged_cost_usd,
      is_sidechain, agent_id, cwd, skill_names, mcp_names
    )
    SELECT log_key, provider, provider_thread_id, NULL, CAST(ts AS INTEGER),
           model, input, cache_read, cache_write, output, reasoning,
           logged_cost_usd, is_sidechain, agent_id, cwd, skill_names, mcp_names
      FROM obs_log_turn_v1;
    DROP TABLE obs_log_turn_v1;
    CREATE INDEX IF NOT EXISTS obs_log_turn_session
      ON obs_log_turn (provider, provider_thread_id, ts);
    CREATE INDEX IF NOT EXISTS obs_log_turn_path ON obs_log_turn (path);
  `);
}

/**
 * Apply the schema, then heal it.
 *
 * `bb.storage.migrate` skips applied statements BY INDEX, and several branches
 * appended to `MIGRATIONS` concurrently. Live databases therefore have indexes
 * marked applied whose recorded statement is not the one shipping at that
 * index, and the table it should have created is simply absent. Re-executing
 * every statement directly closes that gap: each one is idempotent, so the only
 * errors it can raise are "already exists" and "duplicate column", and anything
 * else is a real fault that must not be swallowed.
 */
export function applyMigrations(
  db: Database,
  migrate: (db: Database, statements: string[]) => void,
): void {
  migrate(db, MIGRATIONS);
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!ALREADY_APPLIED.test(message)) throw error;
    }
  }
  rebuildLogTurns(db);
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

const THREAD_COLUMNS = [
  "thread_id",
  "project_id",
  "provider_id",
  "provider_thread_id",
  "parent_thread_id",
  "root_thread_id",
  "depth",
  "title",
  "seat",
  "tier_tag",
  "visibility",
  "origin",
  "run_folder",
  "cwd",
  "created_at",
  "last_event_seq",
  "last_seen_at",
  "status",
] as const;

const TURN_COLUMNS = [
  "thread_id",
  "turn_id",
  "root_thread_id",
  "seq_started",
  "seq_completed",
  "started_at",
  "completed_at",
  "duration_ms",
  "model_requested",
  "model_reported",
  "effort",
  "input_tokens",
  "cached_input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
  "context_used",
  "context_window",
  "cost_usd",
  "cost_source",
  "pricing_status",
  "cache_savings_usd",
  "tool_calls",
  "file_changes",
  "file_reads",
  "compacted",
  "error_category",
  "will_retry",
  "split_source",
] as const;

const ITEM_COLUMNS = [
  "item_id",
  "thread_id",
  "turn_id",
  "seq",
  "kind",
  "name",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
  "path",
  "input_fingerprint",
  "error",
] as const;

/**
 * A PARTIAL upsert: only the keys a caller actually supplied are written.
 *
 * This is the difference between a patch and a row. Ingest folds one page of
 * events at a time, and a page proves only some columns — a later page may
 * carry a turn's `completed_at` and nothing else. Binding the whole column
 * list, which is what a single fixed statement forces, makes every absent key
 * an explicit NULL, so each page ERASES what the previous page established:
 * the split, the cache columns, the cost, `started_at`.
 *
 * The prepared-once property survives because statements are cached per key
 * shape, and callers only have a handful of shapes.
 */
class PartialUpsert {
  private readonly cache = new Map<string, Statement>();

  constructor(
    private readonly db: Database,
    private readonly table: string,
    private readonly keys: readonly string[],
    private readonly pk: readonly string[],
    /**
     * Columns an UPDATE must never overwrite once they hold a value, because
     * another writer owns them. `split_source` is the case that matters: the
     * log join proves it, and a later event page re-asserting its
     * "unavailable" default would throw the proof away.
     */
    private readonly keepExisting: readonly string[] = [],
  ) {}

  run(row: Record<string, unknown>): void {
    const present = this.keys.filter((key) => row[key] !== undefined);
    const shape = present.join(",");
    let statement = this.cache.get(shape);
    if (!statement) {
      statement = this.db.prepare(this.sql(present));
      this.cache.set(shape, statement);
    }
    const bindings: Record<string, unknown> = {};
    for (const key of present) bindings[key] = row[key];
    statement.run(bindings);
  }

  private sql(present: readonly string[]): string {
    const names = present.join(", ");
    const binds = present.map((key) => `@${key}`).join(", ");
    const updates = present
      .filter((key) => !this.pk.includes(key))
      .map((key) =>
        this.keepExisting.includes(key)
          ? `${key} = COALESCE(${this.table}.${key}, excluded.${key})`
          : `${key} = excluded.${key}`,
      )
      .join(", ");
    const conflict = `ON CONFLICT(${this.pk.join(", ")})`;
    // A patch carrying only the primary key still has to insert the row, but
    // it has nothing to update, and `DO UPDATE SET` with no assignment is a
    // syntax error.
    const action = updates ? `DO UPDATE SET ${updates}` : "DO NOTHING";
    return `INSERT INTO ${this.table} (${names}) VALUES (${binds})
            ${conflict} ${action}`;
  }
}

export class ObservatoryStore {
  readonly db: Database;
  private readonly threadUpsert: PartialUpsert;
  private readonly turnUpsert: PartialUpsert;
  private readonly itemUpsert: PartialUpsert;
  private readonly insertSignalStatement: Statement;
  private readonly selectSignalStatement: Statement<
    [string],
    { id: number } | undefined
  >;
  private readonly closeSignalStatement: Statement;
  private readonly insertActionStatement: Statement;
  private readonly countPublishedStatement: Statement<
    [string, string],
    { n: number }
  >;
  private readonly countPublishedOverallStatement: Statement<
    [string],
    { n: number }
  >;
  private readonly getMetaStatement: Statement<
    [string],
    { value: string } | undefined
  >;
  private readonly setMetaStatement: Statement;
  private readonly countStatements: Record<keyof StoreCounts, Statement>;

  constructor(db: Database) {
    this.db = db;
    this.threadUpsert = new PartialUpsert(db, "obs_thread", THREAD_COLUMNS, [
      "thread_id",
    ]);
    this.turnUpsert = new PartialUpsert(
      db,
      "obs_turn",
      TURN_COLUMNS,
      ["thread_id", "turn_id"],
      ["split_source"],
    );
    this.itemUpsert = new PartialUpsert(db, "obs_item", ITEM_COLUMNS, [
      "item_id",
    ]);
    // DO NOTHING, then read: the conflict is the dedupe key doing its job, and
    // the caller needs the EXISTING episode's id, not a new one. Both the
    // conflict target and the read are scoped to OPEN rows, matching the
    // partial unique index, so a closed episode whose anchor recurs opens a
    // second row instead of handing back the closed one forever.
    this.insertSignalStatement = db.prepare(
      `INSERT INTO obs_signal
         (module, kind, thread_id, turn_id, severity, opened_at, closed_at, payload, dedupe_key)
       VALUES (@module, @kind, @thread_id, @turn_id, @severity, @opened_at, NULL, @payload, @dedupe_key)
       ON CONFLICT(dedupe_key) WHERE closed_at IS NULL DO NOTHING`,
    );
    this.selectSignalStatement = db.prepare(
      "SELECT id FROM obs_signal WHERE dedupe_key = ? AND closed_at IS NULL",
    );
    this.closeSignalStatement = db.prepare(
      "UPDATE obs_signal SET closed_at = ? WHERE id = ? AND closed_at IS NULL",
    );
    this.insertActionStatement = db.prepare(
      `INSERT INTO obs_action (signal_id, thread_id, action, at, detail, result)
       VALUES (@signal_id, @thread_id, @action, @at, @detail, @result)`,
    );
    // The notification budget, read back off the ledger rather than held in
    // memory: a plugin reload must not hand anyone a fresh allowance.
    this.countPublishedStatement = db.prepare(
      `SELECT COUNT(*) AS n FROM obs_action
        WHERE result = 'sent' AND thread_id = ? AND at > ?`,
    );
    this.countPublishedOverallStatement = db.prepare(
      "SELECT COUNT(*) AS n FROM obs_action WHERE result = 'sent' AND at > ?",
    );
    this.getMetaStatement = db.prepare(
      "SELECT value FROM obs_meta WHERE key = ?",
    );
    this.setMetaStatement = db.prepare(
      `INSERT INTO obs_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.countStatements = {
      threads: db.prepare("SELECT COUNT(*) AS n FROM obs_thread"),
      turns: db.prepare("SELECT COUNT(*) AS n FROM obs_turn"),
      items: db.prepare("SELECT COUNT(*) AS n FROM obs_item"),
      openSignals: db.prepare(
        "SELECT COUNT(*) AS n FROM obs_signal WHERE closed_at IS NULL",
      ),
      actions: db.prepare("SELECT COUNT(*) AS n FROM obs_action"),
    };
  }

  upsertThread(row: Partial<Nullable<ThreadRow>> & { thread_id: string }): void {
    // `depth` is NOT NULL in the schema; an explicit null still means zero,
    // but an ABSENT depth leaves whatever the last resolve proved.
    this.threadUpsert.run(
      row.depth === undefined ? row : { ...row, depth: row.depth ?? 0 },
    );
  }

  upsertTurn(
    row: Partial<Nullable<TurnRow>> & { thread_id: string; turn_id: string },
  ): void {
    this.turnUpsert.run(row);
  }

  upsertItem(row: Partial<Nullable<ItemRow>> & { item_id: string; thread_id: string }): void {
    this.itemUpsert.run(row);
  }

  /** Returns the existing episode's id when `dedupeKey` is already open. */
  openSignal(signal: OpenSignal): number {
    this.insertSignalStatement.run({
      module: signal.module,
      kind: signal.kind,
      thread_id: signal.threadId ?? null,
      turn_id: signal.turnId ?? null,
      severity: signal.severity ?? null,
      opened_at: signal.openedAt,
      payload:
        signal.payload === undefined ? null : JSON.stringify(signal.payload),
      dedupe_key: signal.dedupeKey,
    });
    const existing = this.selectSignalStatement.get(signal.dedupeKey);
    if (!existing) {
      throw new Error(
        `signal "${signal.dedupeKey}" vanished between insert and read`,
      );
    }
    return existing.id;
  }

  /** No-op on an already-closed signal, so a repeated scan is harmless. */
  closeSignal(id: number, closedAt: string): void {
    this.closeSignalStatement.run(closedAt, id);
  }

  /**
   * Actions recorded with `result = 'sent'` strictly after `since` (an ISO
   * instant), for one thread and across all of them.
   */
  publishedActionsSince(
    since: string,
    threadId: string,
  ): { thread: number; overall: number } {
    return {
      thread: this.countPublishedStatement.get(threadId, since)?.n ?? 0,
      overall: this.countPublishedOverallStatement.get(since)?.n ?? 0,
    };
  }

  recordAction(action: RecordAction): number {
    const result = this.insertActionStatement.run({
      signal_id: action.signalId ?? null,
      thread_id: action.threadId ?? null,
      action: action.action,
      at: action.at,
      detail: action.detail ?? null,
      result: action.result ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  getMeta(key: string): string | null {
    return this.getMetaStatement.get(key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.setMetaStatement.run(key, value);
  }

  counts(): StoreCounts {
    const read = (statement: Statement) =>
      (statement.get() as { n: number }).n;
    return {
      threads: read(this.countStatements.threads),
      turns: read(this.countStatements.turns),
      items: read(this.countStatements.items),
      openSignals: read(this.countStatements.openSignals),
      actions: read(this.countStatements.actions),
    };
  }

  /**
   * TODO(phase 1): prune by the `retention.itemsDays`,
   * `retention.logTurnsDays` and `retention.turnsDays` settings. Signals and
   * actions are kept: they are the evidence a steer or a budget breach
   * happened, and nothing regenerates them.
   */
  prune(_retention: {
    itemsDays: number;
    logTurnsDays: number;
    turnsDays: number;
  }): void {
    // Deliberately empty until phase 1 has rows worth pruning.
  }
}
