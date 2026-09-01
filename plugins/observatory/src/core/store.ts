// The ledger's only writer.
//
// Every statement is prepared once at construction: the ingest path upserts a
// turn per event batch, and re-preparing there would dominate its cost.
// Nothing here decides anything — the store persists what core computed, so
// the analyzers can be pure SQL over one shape.
import type { Database, Statement } from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

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

/** Apply the schema. Idempotent: `bb.storage.migrate` skips applied indexes. */
export function applyMigrations(
  db: Database,
  migrate: (db: Database, statements: string[]) => void,
): void {
  migrate(db, MIGRATIONS);
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

function columns(row: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = row[key] ?? null;
  return out;
}

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

function upsert(table: string, keys: readonly string[], pk: readonly string[]) {
  const names = keys.join(", ");
  const binds = keys.map((key) => `@${key}`).join(", ");
  const updates = keys
    .filter((key) => !pk.includes(key))
    .map((key) => `${key} = excluded.${key}`)
    .join(", ");
  return `INSERT INTO ${table} (${names}) VALUES (${binds})
          ON CONFLICT(${pk.join(", ")}) DO UPDATE SET ${updates}`;
}

export class ObservatoryStore {
  readonly db: Database;
  private readonly upsertThreadStatement: Statement;
  private readonly upsertTurnStatement: Statement;
  private readonly upsertItemStatement: Statement;
  private readonly insertSignalStatement: Statement;
  private readonly selectSignalStatement: Statement<
    [string],
    { id: number } | undefined
  >;
  private readonly closeSignalStatement: Statement;
  private readonly insertActionStatement: Statement;
  private readonly getMetaStatement: Statement<
    [string],
    { value: string } | undefined
  >;
  private readonly setMetaStatement: Statement;
  private readonly countStatements: Record<keyof StoreCounts, Statement>;

  constructor(db: Database) {
    this.db = db;
    this.upsertThreadStatement = db.prepare(
      upsert("obs_thread", THREAD_COLUMNS, ["thread_id"]),
    );
    this.upsertTurnStatement = db.prepare(
      upsert("obs_turn", TURN_COLUMNS, ["thread_id", "turn_id"]),
    );
    this.upsertItemStatement = db.prepare(
      upsert("obs_item", ITEM_COLUMNS, ["item_id"]),
    );
    // DO NOTHING, then read: the conflict is the dedupe key doing its job, and
    // the caller needs the EXISTING episode's id, not a new one.
    this.insertSignalStatement = db.prepare(
      `INSERT INTO obs_signal
         (module, kind, thread_id, turn_id, severity, opened_at, closed_at, payload, dedupe_key)
       VALUES (@module, @kind, @thread_id, @turn_id, @severity, @opened_at, NULL, @payload, @dedupe_key)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    );
    this.selectSignalStatement = db.prepare(
      "SELECT id FROM obs_signal WHERE dedupe_key = ?",
    );
    this.closeSignalStatement = db.prepare(
      "UPDATE obs_signal SET closed_at = ? WHERE id = ? AND closed_at IS NULL",
    );
    this.insertActionStatement = db.prepare(
      `INSERT INTO obs_action (signal_id, thread_id, action, at, detail, result)
       VALUES (@signal_id, @thread_id, @action, @at, @detail, @result)`,
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
    this.upsertThreadStatement.run({
      ...columns(row, THREAD_COLUMNS),
      depth: row.depth ?? 0,
    });
  }

  upsertTurn(
    row: Partial<Nullable<TurnRow>> & { thread_id: string; turn_id: string },
  ): void {
    this.upsertTurnStatement.run(columns(row, TURN_COLUMNS));
  }

  upsertItem(row: Partial<Nullable<ItemRow>> & { item_id: string; thread_id: string }): void {
    this.upsertItemStatement.run(columns(row, ITEM_COLUMNS));
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
