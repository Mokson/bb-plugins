// The ledger schema, as an ordered statement list.
//
// Append-only. `bb.storage.migrate` keys applied migrations by INDEX and
// records each statement's hash, so a shipped statement is never reordered or
// edited; a schema change is a new entry at the end.
//
// Only `ObservatoryStore` writes these tables. Every module other than core
// reads them.

/**
 * `obs_log_turn`'s current shape, shared by the create statement below and by
 * the legacy rebuild in `applyMigrations`, so the two can never drift.
 *
 * `path` exists because rows are pruned by FILE identity: pruning by
 * (provider, provider_thread_id) deleted the rows a moved Codex rollout had
 * just written under its new path. `ts` is INTEGER because a TEXT column gives
 * TEXT affinity, and range comparisons then only worked by the accident that
 * epoch milliseconds are 13 digits wide.
 */
export const OBS_LOG_TURN_COLUMNS = `
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
   `;

/**
 * Every statement here must be idempotent: `bb.storage.migrate` keys applied
 * migrations by INDEX, several branches appended concurrently, and live
 * databases therefore carry indexes marked applied whose content differs from
 * what ships here. `applyMigrations` re-executes the whole list to close that
 * gap, so a statement that cannot run twice would break every existing
 * install. Shape changes that are not expressible idempotently in SQL live as
 * runtime-guarded steps in `applyMigrations` instead.
 */
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
  `CREATE TABLE IF NOT EXISTS obs_log_turn (${OBS_LOG_TURN_COLUMNS})`,
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
  // `openSignal` idempotent rather than a caller-side existence check. It is
  // unique among OPEN rows only: globally unique, a closed episode whose anchor
  // recurs could never reopen, because the insert hit the closed row's key, did
  // nothing, and `openSignal` handed the caller back a closed id that the
  // reconcile then re-opened and re-broadcast forever.
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
  `CREATE UNIQUE INDEX IF NOT EXISTS obs_signal_dedupe_open
     ON obs_signal (dedupe_key) WHERE closed_at IS NULL`,
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
  // The `obs_log_turn` rebuild that added `path` and retyped `ts` is not
  // expressible as an idempotent statement, so it lives as a guarded step in
  // `applyMigrations`; only its indexes remain here. `PARSER_VERSION` is
  // bumped alongside it, so every file is reparsed once and re-upserts its
  // rows with the path filled in.
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
  // Databases created before the partial index still carry the globally unique
  // one. Dropping it last (rather than recreating it above) keeps the self-heal
  // replay stable: on a healthy boot this statement is a no-op.
  `DROP INDEX IF EXISTS obs_signal_dedupe`,
  // Two read paths that ran as full scans on every commit hook.
  //
  //  - `obs_signal (thread_id, turn_id)`: the cache-miss detector opens one
  //    signal per miss and the drilldown reads them back per turn.
  //  - `obs_thread (parent_thread_id)`: lineage rollups and the tool's tree
  //    scope walk children by parent, once per level of the subtree.
  `CREATE INDEX IF NOT EXISTS obs_signal_turn
     ON obs_signal (thread_id, turn_id)`,
  `CREATE INDEX IF NOT EXISTS obs_thread_parent
     ON obs_thread (parent_thread_id)`,
  // ---------------------------------------------------------------------
  // Distillery (phase 6): mined corrections, their clusters, and the drafts
  // a hidden thread writes from them.
  //
  // `preview_redacted` is named for the only thing that may ever be in it.
  // The column carries text that came from ledgers and transcripts, so the
  // name is the last reminder at the schema layer that `redact()` is the
  // only legal constructor for its value.
  `CREATE TABLE IF NOT EXISTS corrections (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     source            TEXT NOT NULL,
     signature         TEXT NOT NULL,
     cause_class       TEXT,
     preview_redacted  TEXT NOT NULL,
     redaction_counts  TEXT,
     run_folder        TEXT,
     thread_id         TEXT,
     at                TEXT NOT NULL,
     confidence        REAL NOT NULL DEFAULT 0,
     cluster_id        TEXT
   )`,
  // Re-scanning the same ledger is the normal case (a scan runs on a cron and
  // over folders that keep growing), so identity has to live in the schema
  // rather than in a caller-side existence check. Source plus signature plus
  // run folder plus timestamp is one observed correction.
  `CREATE UNIQUE INDEX IF NOT EXISTS corrections_identity
     ON corrections (source, signature, IFNULL(run_folder, ''), at)`,
  `CREATE INDEX IF NOT EXISTS corrections_cluster ON corrections (cluster_id)`,
  `CREATE INDEX IF NOT EXISTS corrections_signature ON corrections (signature)`,
  `CREATE TABLE IF NOT EXISTS correction_clusters (
     id          TEXT PRIMARY KEY,
     signature   TEXT NOT NULL,
     cause_class TEXT,
     size        INTEGER NOT NULL DEFAULT 0,
     runs        INTEGER NOT NULL DEFAULT 0,
     first_at    TEXT,
     last_at     TEXT,
     status      TEXT NOT NULL DEFAULT 'open'
   )`,
  // The state set is CHECKed rather than trusted: `applied` is the value that
  // means a file was written under ~/.agents, so an unrecognised state must
  // not be able to reach a surface that treats "not pending" as "done".
  `CREATE TABLE IF NOT EXISTS drafts (
     id                 TEXT PRIMARY KEY,
     cluster_id         TEXT NOT NULL,
     state              TEXT NOT NULL
       CHECK (state IN ('pending','accepted','rejected','edited','applied')),
     home_file          TEXT,
     rung               INTEGER,
     patch_unified_diff TEXT,
     rule_text          TEXT,
     success_signal     TEXT,
     rationale          TEXT,
     evidence_ids       TEXT,
     recurrence         INTEGER NOT NULL DEFAULT 0,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL,
     applied_path       TEXT,
     thread_id          TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS drafts_state ON drafts (state)`,
  `CREATE INDEX IF NOT EXISTS drafts_cluster ON drafts (cluster_id)`,
  // Snooze is queue state, not draft state: a snoozed draft is still pending,
  // it is only hidden until its date. Keeping it out of `drafts.state` is what
  // stops `pending` from having to mean two different things.
  `CREATE TABLE IF NOT EXISTS draft_snoozes (
     draft_id TEXT PRIMARY KEY,
     until    TEXT NOT NULL
   )`,
  // ---------------------------------------------------------------------
  // Eval (phase 5). Three tables, all owned by `src/eval/`.
  //
  // `eval_run.cases_json` freezes the SELECTED case names at run time. A case
  // file edited or deleted afterwards must not silently change what a past
  // run claims it covered, and the case files live outside this repo.
  //
  // `eval_baseline` is keyed by case, not by (case, run): a baseline is the
  // single number a gate compares against, and PRODUCT.md invariant 5 says it
  // moves only through an explicit promote.
  `CREATE TABLE IF NOT EXISTS eval_run (
     id         TEXT PRIMARY KEY,
     started_at TEXT,
     finished_at TEXT,
     tag        TEXT,
     stack_sha  TEXT,
     cases_json TEXT,
     status     TEXT,
     gate       TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS eval_run_started ON eval_run (started_at)`,
  // Trial is part of the key: a case with `trials: 3` stores three rows, and
  // a variance number needs each one, not the last writer.
  `CREATE TABLE IF NOT EXISTS eval_case_result (
     run_id         TEXT NOT NULL,
     "case"         TEXT NOT NULL,
     trial          INTEGER NOT NULL,
     status         TEXT,
     assertions_json TEXT,
     metrics_json   TEXT,
     thread_id      TEXT,
     artifacts_dir  TEXT,
     PRIMARY KEY (run_id, "case", trial)
   )`,
  `CREATE INDEX IF NOT EXISTS eval_case_result_case
     ON eval_case_result ("case")`,
  `CREATE TABLE IF NOT EXISTS eval_baseline (
     "case"       TEXT PRIMARY KEY,
     run_id       TEXT,
     metrics_json TEXT,
     promoted_at  TEXT
   )`,
  // Appended at the TAIL, never inserted: migrations are keyed by index and
  // replayed on every boot, so an insertion mid-list renumbers every statement
  // after it. Audit resolves a run folder's threads on every pack build.
  `CREATE INDEX IF NOT EXISTS obs_thread_run_folder
     ON obs_thread (run_folder)`,
];
