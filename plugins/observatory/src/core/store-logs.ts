// The provider-log half of the ledger: `obs_log_file` and `obs_log_turn`.
//
// Separate from `ObservatoryStore` because it is written by a different clock.
// The bb-event tables are driven by a push subscription; these two are driven
// by a filesystem sweep that has to survive being interrupted, so the file
// table is really a resume cursor with a schema.
//
// Content is NEVER stored. Skill and MCP names, token counts, model ids and
// timestamps only: enough to price and attribute a turn, nothing that could
// leak a prompt into this database.
import type { Database, Statement } from "better-sqlite3";

export interface LogFileRow {
  path: string;
  root_id: string | null;
  provider: string | null;
  size_bytes: number | null;
  mtime_ms: number | null;
  /** Bytes already parsed. The resume point. */
  indexed_bytes: number | null;
  indexed_lines: number | null;
  parser_version: number | null;
  /** sha256 of the indexed prefix, to prove an append is an append. */
  content_hash: string | null;
  provider_thread_id: string | null;
  indexed_at: string | null;
  parse_error: string | null;
}

export interface LogTurnRow {
  log_key: string;
  provider: string;
  provider_thread_id: string | null;
  /** Epoch milliseconds. */
  ts: number;
  model: string | null;
  input: number;
  /** Null when the provider did not split cache read from cache write. */
  cache_read: number | null;
  cache_write: number | null;
  output: number;
  reasoning: number;
  logged_cost_usd: number | null;
  /** 0 or 1. */
  is_sidechain: number;
  agent_id: string | null;
  cwd: string | null;
  /** JSON array, serialized. */
  skill_names: string | null;
  mcp_names: string | null;
}

export interface ListLogTurnsQuery {
  provider: string;
  providerThreadId: string;
  tsFrom: number;
  tsTo: number;
}

const FILE_COLUMNS = [
  "path",
  "root_id",
  "provider",
  "size_bytes",
  "mtime_ms",
  "indexed_bytes",
  "indexed_lines",
  "parser_version",
  "content_hash",
  "provider_thread_id",
  "indexed_at",
  "parse_error",
] as const;

const TURN_COLUMNS = [
  "log_key",
  "provider",
  "provider_thread_id",
  "ts",
  "model",
  "input",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
  "logged_cost_usd",
  "is_sidechain",
  "agent_id",
  "cwd",
  "skill_names",
  "mcp_names",
] as const;

function upsert(table: string, keys: readonly string[], pk: string) {
  const names = keys.join(", ");
  const binds = keys.map((key) => `@${key}`).join(", ");
  const updates = keys
    .filter((key) => key !== pk)
    .map((key) => `${key} = excluded.${key}`)
    .join(", ");
  return `INSERT INTO ${table} (${names}) VALUES (${binds})
          ON CONFLICT(${pk}) DO UPDATE SET ${updates}`;
}

function bind(row: object, keys: readonly string[]) {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key] ?? null;
  return out;
}

/**
 * `obs_log_turn.ts` is declared TEXT in the shipped migration, so SQLite's
 * TEXT affinity converts the integer we bind. Reading it back therefore yields
 * a string, and every read coerces.
 *
 * Range comparisons still behave: epoch milliseconds are 13 digits for every
 * date between 2001 and 2286, and equal-length digit strings order the same
 * lexicographically as numerically. The migration list is append-only and
 * owned elsewhere, so the column type is not this module's to change.
 */
function toMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hydrate(row: Record<string, unknown>): LogTurnRow {
  return { ...(row as unknown as LogTurnRow), ts: toMs(row.ts) };
}

export class LogStore {
  private readonly upsertFileStatement: Statement;
  private readonly getFileStatement: Statement<[string], LogFileRow | undefined>;
  private readonly deleteFileStatement: Statement;
  private readonly upsertTurnStatement: Statement;
  private readonly listTurnsStatement: Statement;
  private readonly unmatchedStatement: Statement;
  private readonly cursorsStatement: Statement;
  private readonly deleteTurnsForFileStatement: Statement;

  constructor(private readonly db: Database) {
    this.upsertFileStatement = db.prepare(
      upsert("obs_log_file", FILE_COLUMNS, "path"),
    );
    this.getFileStatement = db.prepare(
      "SELECT * FROM obs_log_file WHERE path = ?",
    );
    this.deleteFileStatement = db.prepare(
      "DELETE FROM obs_log_file WHERE path = ?",
    );
    this.upsertTurnStatement = db.prepare(
      upsert("obs_log_turn", TURN_COLUMNS, "log_key"),
    );
    this.listTurnsStatement = db.prepare(
      `SELECT * FROM obs_log_turn
        WHERE provider = @provider
          AND provider_thread_id = @providerThreadId
          AND ts >= @tsFrom AND ts <= @tsTo
        ORDER BY ts ASC, log_key ASC`,
    );
    // The join module's inbox: log rows no `obs_match` row claims. Ordered
    // oldest first so a backlog is worked through in the order it accrued.
    this.unmatchedStatement = db.prepare(
      `SELECT t.* FROM obs_log_turn t
        WHERE t.ts >= ?
          AND NOT EXISTS (SELECT 1 FROM obs_match m WHERE m.log_key = t.log_key)
        ORDER BY t.ts ASC, t.log_key ASC
        LIMIT ?`,
    );
    this.cursorsStatement = db.prepare(
      "SELECT path, indexed_bytes FROM obs_log_file",
    );
    this.deleteTurnsForFileStatement = db.prepare(
      `DELETE FROM obs_log_turn
        WHERE provider = ? AND provider_thread_id IS ?`,
    );
  }

  upsertLogFile(row: LogFileRow): void {
    this.upsertFileStatement.run(bind(row, FILE_COLUMNS));
  }

  getLogFile(path: string): LogFileRow | null {
    return this.getFileStatement.get(path) ?? null;
  }

  upsertLogTurn(row: LogTurnRow): void {
    this.upsertTurnStatement.run(bind(row, TURN_COLUMNS));
  }

  listLogTurns(query: ListLogTurnsQuery): LogTurnRow[] {
    return (this.listTurnsStatement.all(query) as Record<string, unknown>[]).map(
      hydrate,
    );
  }

  listUnmatchedSince(tsFrom: number, limit: number): LogTurnRow[] {
    return (
      this.unmatchedStatement.all(tsFrom, limit) as Record<string, unknown>[]
    ).map(hydrate);
  }

  /** Resume points, keyed by path, as the host client's `cursors` input. */
  cursors(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.cursorsStatement.all() as Array<{
      path: string;
      indexed_bytes: number | null;
    }>) {
      out[row.path] = row.indexed_bytes ?? 0;
    }
    return out;
  }

  /**
   * Forget a file that no longer exists.
   *
   * Its turn rows go with it: a deleted session log is a session that can
   * never be re-derived, and leaving priced rows behind would keep billing a
   * thread nothing can explain. Rows are removed by session rather than by
   * path because `obs_log_turn` is keyed on the provider's session, not on
   * where the file happened to sit.
   */
  pruneFile(path: string): void {
    const file = this.getLogFile(path);
    if (file?.provider) {
      this.deleteTurnsForFileStatement.run(
        file.provider,
        file.provider_thread_id,
      );
    }
    this.deleteFileStatement.run(path);
  }

  /** Run `fn` in one transaction. A partial file must never land. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
