// The log indexer: the database half of the sweep.
//
// `LocalHostClient` owns bytes; this owns rows. Keeping the two apart is what
// makes the remote-host case a swap of one object and lets the whole resume
// protocol be tested against a fake client with no filesystem at all.
//
// The pass is: read the resume state out of `obs_log_file`, hand it to the
// host with a byte budget, write back what comes home in ONE transaction, and
// prune the files the host could not find. A budgeted pass that runs every
// five minutes beats an unbudgeted one that runs once and blocks the plugin.
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostClient, LogRow, FileResult } from "./host-client.js";
import type { LogFileRow, LogStore, LogTurnRow } from "./store-logs.js";

export interface IndexerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LogIndexerDeps {
  store: LogStore;
  host: HostClient;
  roots: string[];
  log: IndexerLog;
}

export interface IndexBudget {
  maxBytes: number;
}

/**
 * Turn rows one pass may carry home.
 *
 * The old ceiling was 100,000, which is not a ceiling: it is a promise to hold
 * a six-figure array in memory, ship it over rpc and write it in one
 * transaction if a big enough store ever showed up. A few thousand rows is a
 * batch; the pass returns `done: false` and the next one continues, which is
 * the protocol this indexer already runs on.
 */
export const MAX_ROWS_PER_PASS = 5_000;

export interface IndexRunResult {
  /** Files whose state changed this pass. */
  files: number;
  /** Log turns written. */
  rows: number;
  /** False when the budget ran out before the roots were exhausted. */
  done: boolean;
}

export interface LogIndexer {
  runOnce(budget: IndexBudget): Promise<IndexRunResult>;
  defaultRoots(): string[];
}

/**
 * Where each provider keeps its sessions.
 *
 * Roots that do not exist are not an error and are not filtered here: the host
 * walks them, finds nothing, and the absence shows up as zero files. Filtering
 * on existence at construction time would mean a provider installed after the
 * plugin loaded is never picked up.
 */
export function defaultLogRoots(home = homedir()): string[] {
  return [
    join(home, ".claude", "projects"),
    join(home, ".codex", "sessions"),
    join(home, ".codex", "archived_sessions"),
    join(home, ".pi", "agent", "sessions"),
    join(home, ".bb", "pi-bridge-sessions"),
    join(home, ".omp", "agent", "sessions"),
    join(home, ".cursor", "acp-sessions"),
    process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "opencode")
      : join(home, ".local", "share", "opencode"),
  ];
}

function toFileRow(file: FileResult): LogFileRow {
  return {
    path: file.path,
    root_id: file.rootId,
    provider: file.provider,
    size_bytes: file.sizeBytes,
    mtime_ms: file.mtimeMs,
    indexed_bytes: file.indexedBytes,
    indexed_lines: file.indexedLines,
    parser_version: file.parserVersion,
    content_hash: file.contentHash,
    provider_thread_id: file.providerThreadId,
    indexed_at: new Date().toISOString(),
    parse_error: file.parseError,
  };
}

function toTurnRow(row: LogRow): LogTurnRow {
  return {
    log_key: row.logKey,
    provider: row.provider,
    provider_thread_id: row.providerThreadId,
    // The row's delete key. See `LogTurnRow.path`.
    path: row.path,
    ts: row.ts,
    model: row.model,
    input: row.input,
    cache_read: row.cacheRead,
    cache_write: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    logged_cost_usd: row.loggedCostUsd,
    is_sidechain: row.isSidechain ? 1 : 0,
    agent_id: row.agentId,
    cwd: row.cwd,
    // Serialized here rather than in the parser so the parsers stay free of
    // storage concerns. Empty arrays are stored as null: the column means
    // "which skills", and "[]" reads as an answer where null reads as none.
    skill_names: row.skillNames.length ? JSON.stringify(row.skillNames) : null,
    mcp_names: row.mcpNames.length ? JSON.stringify(row.mcpNames) : null,
  };
}

export function createLogIndexer(deps: LogIndexerDeps): LogIndexer {
  const { store, host, roots, log } = deps;

  return {
    defaultRoots: () => defaultLogRoots(),

    async runOnce(budget: IndexBudget): Promise<IndexRunResult> {
      // The resume state, built per path from what the last pass stored. The
      // hash and size travel with the offset because the offset alone cannot
      // tell an append from a rewrite.
      const cursors = store.cursors();
      const state: Record<
        string,
        {
          indexedBytes: number;
          indexedLines: number;
          contentHash: string | null;
          sizeBytes: number;
          mtimeMs: number;
          parserVersion: number;
        }
      > = {};
      for (const path of Object.keys(cursors)) {
        const file = store.getLogFile(path);
        if (!file) continue;
        state[path] = {
          indexedBytes: file.indexed_bytes ?? 0,
          indexedLines: file.indexed_lines ?? 0,
          contentHash: file.content_hash,
          sizeBytes: file.size_bytes ?? 0,
          mtimeMs: file.mtime_ms ?? 0,
          parserVersion: file.parser_version ?? 0,
        };
      }

      let batch;
      try {
        batch = await host.indexBatch({
          roots,
          cursors,
          state,
          limit: MAX_ROWS_PER_PASS,
          maxBytes: budget.maxBytes,
        });
      } catch (error) {
        // A host that is down must not take the plugin's cron with it; the
        // next pass resumes from exactly the same cursors.
        log.error(
          `log indexer: host batch failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { files: 0, rows: 0, done: false };
      }

      // One transaction for the whole batch. A half-written file would leave
      // an offset that claims rows the database does not hold.
      //
      // Resets are applied FIRST, and they are the reason this order matters.
      // `file.reset` means the host proved the file was rewritten in place
      // rather than appended to, so the rows already stored for it describe
      // bytes that no longer exist. The host was computing that flag and the
      // indexer was ignoring it: the stale rows survived, the rewritten file's
      // rows landed beside them under new keys, and the session was billed
      // twice. Deleting by path inside the same transaction makes the rewrite
      // a replacement.
      store.transaction(() => {
        for (const file of batch.files) {
          if (file.reset) store.deleteTurnsForPath(file.path);
        }
        for (const row of batch.rows) store.upsertLogTurn(toTurnRow(row));
        for (const file of batch.files) store.upsertLogFile(toFileRow(file));
        for (const path of batch.missing) store.pruneFile(path);
      });

      for (const file of batch.files) {
        if (file.parseError) {
          log.warn(`log indexer: ${file.path}: ${file.parseError}`);
        }
      }
      if (batch.missing.length) {
        log.info(`log indexer: pruned ${batch.missing.length} vanished files`);
      }

      return {
        files: batch.files.length,
        rows: batch.rows.length,
        done: batch.done,
      };
    },
  };
}
