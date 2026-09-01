// The ledger schema, as an ordered statement list.
//
// Append-only. `bb.storage.migrate` keys applied migrations by INDEX and
// records each statement's hash, so a shipped statement is never reordered or
// edited; a schema change is a new entry at the end.
//
// Only `ObservatoryStore` writes these tables. Every module other than core
// reads them.

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS obs_thread (
     thread_id          TEXT PRIMARY KEY,
     project_id         TEXT,
     provider_id        TEXT,
     provider_thread_id TEXT,
     parent_thread_id   TEXT,
     root_thread_id     TEXT,
     depth              INTEGER NOT NULL DEFAULT 0,
     title              TEXT,
     seat               TEXT,
     tier_tag           TEXT,
     visibility         TEXT,
     origin             TEXT,
     run_folder         TEXT,
     cwd                TEXT,
     created_at         TEXT,
     last_event_seq     INTEGER,
     last_seen_at       TEXT,
     status             TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS obs_thread_root ON obs_thread (root_thread_id)`,
  `CREATE INDEX IF NOT EXISTS obs_thread_provider
     ON obs_thread (provider_id, provider_thread_id)`,
  // `split_source` is CHECKed rather than trusted: a fabricated cache split is
  // the one number this plugin must never invent, so "unavailable" has to be a
  // value the schema itself admits.
  `CREATE TABLE IF NOT EXISTS obs_turn (
     thread_id           TEXT NOT NULL,
     turn_id             TEXT NOT NULL,
     root_thread_id      TEXT,
     seq_started         INTEGER,
     seq_completed       INTEGER,
     started_at          TEXT,
     completed_at        TEXT,
     duration_ms         INTEGER,
     model_requested     TEXT,
     model_reported      TEXT,
     effort              TEXT,
     input_tokens        INTEGER,
     cached_input_tokens INTEGER,
     cache_read_tokens   INTEGER,
     cache_write_tokens  INTEGER,
     output_tokens       INTEGER,
     reasoning_tokens    INTEGER,
     context_used        INTEGER,
     context_window      INTEGER,
     cost_usd            REAL,
     cost_source         TEXT,
     pricing_status      TEXT,
     cache_savings_usd   REAL,
     tool_calls          INTEGER,
     file_changes        INTEGER,
     file_reads          INTEGER,
     compacted           INTEGER,
     error_category      TEXT,
     will_retry          INTEGER,
     split_source        TEXT CHECK (
       split_source IN ('log-exact','log-window','sidechain','unavailable')
     ),
     PRIMARY KEY (thread_id, turn_id)
   )`,
  `CREATE INDEX IF NOT EXISTS obs_turn_root ON obs_turn (root_thread_id)`,
  `CREATE INDEX IF NOT EXISTS obs_turn_started ON obs_turn (started_at)`,
  `CREATE TABLE IF NOT EXISTS obs_item (
     item_id      TEXT PRIMARY KEY,
     thread_id    TEXT NOT NULL,
     turn_id      TEXT,
     seq          INTEGER,
     kind         TEXT,
     name         TEXT,
     status       TEXT,
     started_at   TEXT,
     completed_at TEXT,
     duration_ms  INTEGER,
     path         TEXT,
     input_fingerprint TEXT,
     error        TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS obs_item_turn ON obs_item (thread_id, turn_id)`,
  `CREATE TABLE IF NOT EXISTS obs_log_file (
     path               TEXT PRIMARY KEY,
     root_id            TEXT,
     provider           TEXT,
     size_bytes         INTEGER,
     mtime_ms           INTEGER,
     indexed_bytes      INTEGER,
     indexed_lines      INTEGER,
     parser_version     INTEGER,
     content_hash       TEXT,
     provider_thread_id TEXT,
     indexed_at         TEXT,
     parse_error        TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS obs_log_turn (
     log_key            TEXT PRIMARY KEY,
     provider           TEXT,
     provider_thread_id TEXT,
     ts                 TEXT,
     model              TEXT,
     input              INTEGER,
     cache_read         INTEGER,
     cache_write        INTEGER,
     output             INTEGER,
     reasoning          INTEGER,
     logged_cost_usd    REAL,
     is_sidechain       INTEGER,
     agent_id           TEXT,
     cwd                TEXT,
     skill_names        TEXT,
     mcp_names          TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS obs_log_turn_session
     ON obs_log_turn (provider, provider_thread_id, ts)`,
  `CREATE TABLE IF NOT EXISTS obs_match (
     thread_id  TEXT NOT NULL,
     turn_id    TEXT NOT NULL,
     log_key    TEXT NOT NULL,
     method     TEXT,
     confidence REAL,
     PRIMARY KEY (thread_id, turn_id)
   )`,
  // `dedupe_key` is the episode identity: opening the same signal twice is the
  // normal case (every scan re-derives it), so the UNIQUE index is what makes
  // `openSignal` idempotent rather than a caller-side existence check.
  `CREATE TABLE IF NOT EXISTS obs_signal (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     module     TEXT NOT NULL,
     kind       TEXT NOT NULL,
     thread_id  TEXT,
     turn_id    TEXT,
     severity   TEXT,
     opened_at  TEXT NOT NULL,
     closed_at  TEXT,
     payload    TEXT,
     dedupe_key TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS obs_signal_dedupe
     ON obs_signal (dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS obs_signal_open
     ON obs_signal (module, closed_at)`,
  `CREATE TABLE IF NOT EXISTS obs_action (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     signal_id INTEGER,
     thread_id TEXT,
     action    TEXT NOT NULL,
     at        TEXT NOT NULL,
     detail    TEXT,
     result    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS obs_action_signal ON obs_action (signal_id)`,
  `CREATE TABLE IF NOT EXISTS pricing_catalog (
     id         TEXT PRIMARY KEY,
     revision   TEXT,
     fetched_at TEXT,
     data       TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS obs_root (
     id           TEXT PRIMARY KEY,
     provider     TEXT,
     path         TEXT,
     kind         TEXT,
     exists_flag  INTEGER,
     last_scan_at TEXT,
     error        TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS obs_meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
  // ---------------------------------------------------------------------
  // `obs_log_turn` rebuild: a `path` column, and `ts` as a real INTEGER.
  //
  // Two defects share one rebuild because SQLite cannot change a column's
  // type in place and a second rebuild would copy the table twice.
  //
  //  - `path`. Rows were pruned by (provider, provider_thread_id), which is
  //    not the identity of a FILE. Codex moves finished rollouts from
  //    `~/.codex/sessions` to `~/.codex/archived_sessions`; both roots are
  //    scanned, so pruning the vanished old path deleted the rows the new
  //    path had just written. The `IS NULL` form of that delete was worse
  //    still: it took every null-thread row the provider had.
  //  - `ts`. Declared TEXT, so SQLite's TEXT affinity stored the bound
  //    integer as a string. Range comparisons only worked by the accident
  //    that epoch milliseconds are 13 digits wide today; the first
  //    narrower value (a second-resolution stamp, a 1970 default) sorts
  //    ahead of everything and silently drops out of every window query.
  //
  // Copied rows carry a null `path`: it cannot be recovered from the row.
  // `PARSER_VERSION` is bumped alongside this migration, so every file is
  // reparsed once and re-upserts its rows with the path filled in.
  `ALTER TABLE obs_log_turn RENAME TO obs_log_turn_v1`,
  `CREATE TABLE obs_log_turn (
     log_key            TEXT PRIMARY KEY,
     provider           TEXT,
     provider_thread_id TEXT,
     path               TEXT,
     ts                 INTEGER,
     model              TEXT,
     input              INTEGER,
     cache_read         INTEGER,
     cache_write        INTEGER,
     output             INTEGER,
     reasoning          INTEGER,
     logged_cost_usd    REAL,
     is_sidechain       INTEGER,
     agent_id           TEXT,
     cwd                TEXT,
     skill_names        TEXT,
     mcp_names          TEXT
   )`,
  `INSERT INTO obs_log_turn (
     log_key, provider, provider_thread_id, path, ts, model, input,
     cache_read, cache_write, output, reasoning, logged_cost_usd,
     is_sidechain, agent_id, cwd, skill_names, mcp_names
   )
   SELECT log_key, provider, provider_thread_id, NULL, CAST(ts AS INTEGER),
          model, input, cache_read, cache_write, output, reasoning,
          logged_cost_usd, is_sidechain, agent_id, cwd, skill_names, mcp_names
     FROM obs_log_turn_v1`,
  // Takes the old `obs_log_turn_session` index with it: an index follows its
  // table through a rename, so the name is free again below.
  `DROP TABLE obs_log_turn_v1`,
  `CREATE INDEX IF NOT EXISTS obs_log_turn_session
     ON obs_log_turn (provider, provider_thread_id, ts)`,
  `CREATE INDEX IF NOT EXISTS obs_log_turn_path ON obs_log_turn (path)`,
  // Phase 4, context module. A snapshot is one scan of one cwd: what the
  // prefix of every request in that project is made of. It is kept rather
  // than recomputed so composition can be compared across days, and so a
  // calibration factor has a history to be judged against.
  `CREATE TABLE IF NOT EXISTS obs_ctx_snapshot (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id         TEXT,
     cwd                TEXT NOT NULL,
     taken_at           TEXT NOT NULL,
     provider           TEXT,
     total_est_tokens   INTEGER NOT NULL,
     calibration_factor REAL,
     calibration_error  REAL
   )`,
  `CREATE INDEX IF NOT EXISTS obs_ctx_snapshot_cwd
     ON obs_ctx_snapshot (cwd, taken_at)`,
  // One row per surface block. `duplicate_of` names the block this one
  // overlaps and `dead` marks a skill description no indexed session ever
  // used: both are derived once at scan time so the panel and the CLI read
  // the same verdict rather than each recomputing it.
  `CREATE TABLE IF NOT EXISTS obs_ctx_block (
     snapshot_id  INTEGER NOT NULL,
     surface      TEXT NOT NULL
                  CHECK (surface IN ('instruction','skill','mcp','plugin-tool')),
     path         TEXT,
     name         TEXT,
     bytes        INTEGER NOT NULL,
     est_tokens   INTEGER NOT NULL,
     hash         TEXT,
     duplicate_of TEXT,
     dead         INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS obs_ctx_block_snapshot
     ON obs_ctx_block (snapshot_id)`,
];
