/**
 * The rollup index: the plugin's own sqlite table of skill invocations across
 * threads. It exists because the BB SDK has no cross-thread event query - the
 * only supported read is `threads.events.list` one thread at a time, so a
 * project or global rollup would otherwise re-walk every thread on every open.
 *
 * Rows hold facts only. Thread titles are resolved live at render time, so a
 * rename never has to rewrite the index.
 */

import { rollup, type SkillInvocation, type SkillRollupRow } from "./model";

/** The slice of better-sqlite3 this module uses. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
}

/**
 * Append-only. Never reorder or edit a shipped statement: the host uses the
 * array index as the migration id.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS invocations (
     thread_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     skill TEXT NOT NULL,
     args TEXT,
     status TEXT NOT NULL,
     PRIMARY KEY (thread_id, item_id)
   )`,
  `CREATE INDEX IF NOT EXISTS invocations_project_idx ON invocations (project_id)`,
  `CREATE INDEX IF NOT EXISTS invocations_skill_idx ON invocations (skill)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     thread_id TEXT PRIMARY KEY,
     last_seq INTEGER NOT NULL
   )`,
  `ALTER TABLE invocations ADD COLUMN source TEXT NOT NULL DEFAULT 'tool'`,
  // Null for tool calls, which come from events. Command rows carry the log
  // they were parsed from, so re-reading a changed log replaces exactly its
  // own rows.
  `ALTER TABLE invocations ADD COLUMN file_path TEXT`,
  `CREATE TABLE IF NOT EXISTS session_files (
     thread_id TEXT NOT NULL,
     file_path TEXT NOT NULL,
     mtime_ms INTEGER NOT NULL,
     size_bytes INTEGER NOT NULL,
     PRIMARY KEY (thread_id, file_path)
   )`,
  `CREATE TABLE IF NOT EXISTS thread_sessions (
     thread_id TEXT NOT NULL,
     provider_thread_id TEXT NOT NULL,
     PRIMARY KEY (thread_id, provider_thread_id)
   )`,
];

/**
 * Highest event sequence already indexed for a thread. Zero means the thread
 * has never been walked, which is also the correct `afterSeq` for a first pass.
 */
export function readCursor(db: SqliteDatabase, threadId: string): number {
  const row = db.prepare(`SELECT last_seq FROM cursors WHERE thread_id = ?`).get(threadId);
  if (row === null || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)["last_seq"];
  return typeof value === "number" ? value : 0;
}

const UPSERT_INVOCATION = `INSERT INTO invocations
   (thread_id, item_id, project_id, seq, created_at, skill, args, status, source, file_path)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (thread_id, item_id) DO UPDATE SET
   project_id = excluded.project_id,
   created_at = excluded.created_at,
   skill = excluded.skill,
   args = excluded.args,
   status = excluded.status,
   source = excluded.source,
   file_path = excluded.file_path`;

/**
 * Write one thread's invocations and advance its cursor in a single
 * transaction, so a crash mid-pass can only re-do work, never skip it.
 */
export function writeThread(
  db: SqliteDatabase,
  args: {
    threadId: string;
    projectId: string;
    invocations: readonly SkillInvocation[];
    lastSeq: number;
  },
): void {
  const upsert = db.prepare(UPSERT_INVOCATION);
  const cursor = db.prepare(
    `INSERT INTO cursors (thread_id, last_seq) VALUES (?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET last_seq = excluded.last_seq`,
  );
  db.transaction(() => {
    for (const invocation of args.invocations) {
      upsert.run(
        args.threadId,
        invocation.itemId,
        args.projectId,
        invocation.seq,
        invocation.createdAt,
        invocation.skill,
        invocation.args,
        invocation.status,
        invocation.source,
        null,
      );
    }
    cursor.run(args.threadId, args.lastSeq);
  })();
}

/**
 * Drop every indexed thread that is no longer in `liveThreadIds`. Totals then
 * only ever describe threads you can still open.
 */
export function pruneThreads(db: SqliteDatabase, liveThreadIds: ReadonlySet<string>): number {
  const indexed = db
    .prepare(`SELECT thread_id FROM cursors`)
    .all()
    .map((row) => (row as Record<string, unknown>)["thread_id"])
    .filter((id): id is string => typeof id === "string");
  const gone = indexed.filter((id) => !liveThreadIds.has(id));
  if (gone.length === 0) return 0;
  const dropInvocations = db.prepare(`DELETE FROM invocations WHERE thread_id = ?`);
  const dropCursor = db.prepare(`DELETE FROM cursors WHERE thread_id = ?`);
  const dropFiles = db.prepare(`DELETE FROM session_files WHERE thread_id = ?`);
  const dropSessions = db.prepare(`DELETE FROM thread_sessions WHERE thread_id = ?`);
  db.transaction(() => {
    for (const id of gone) {
      dropInvocations.run(id);
      dropCursor.run(id);
      dropFiles.run(id);
      dropSessions.run(id);
    }
  })();
  return gone.length;
}

function toInvocation(row: unknown): SkillInvocation | null {
  if (row === null || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const threadId = record["thread_id"];
  const skill = record["skill"];
  if (typeof threadId !== "string" || typeof skill !== "string") return null;
  const status = record["status"];
  return {
    itemId: typeof record["item_id"] === "string" ? record["item_id"] : "",
    threadId,
    seq: typeof record["seq"] === "number" ? record["seq"] : 0,
    createdAt: typeof record["created_at"] === "number" ? record["created_at"] : 0,
    skill,
    args: typeof record["args"] === "string" ? record["args"] : null,
    status: status === "completed" || status === "failed" ? status : "running",
    result: null,
    source: record["source"] === "command" ? "command" : "tool",
  };
}

/** Rollup rows for one project, or for everything when `projectId` is null. */
export function loadRollup(db: SqliteDatabase, projectId: string | null): SkillRollupRow[] {
  const rows =
    projectId === null
      ? db.prepare(`SELECT * FROM invocations`).all()
      : db.prepare(`SELECT * FROM invocations WHERE project_id = ?`).all(projectId);
  const invocations = rows
    .map(toInvocation)
    .filter((invocation): invocation is SkillInvocation => invocation !== null);
  return rollup(invocations);
}

/** Threads with at least one indexed invocation. */
export function indexedThreadCount(db: SqliteDatabase): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM invocations`).get();
  if (row === null || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)["n"];
  return typeof value === "number" ? value : 0;
}

/** Drop everything, so the next pass rebuilds from scratch. */
export function clearIndex(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec(`DELETE FROM invocations`);
    db.exec(`DELETE FROM cursors`);
    db.exec(`DELETE FROM session_files`);
    db.exec(`DELETE FROM thread_sessions`);
  })();
}

/**
 * Remember which provider sessions a thread has used. An incremental pass sees
 * only new events, so the ids must persist: without them a pass with nothing
 * new could not find the session log to re-read.
 */
export function recordSessions(
  db: SqliteDatabase,
  threadId: string,
  providerThreadIds: ReadonlySet<string>,
): void {
  if (providerThreadIds.size === 0) return;
  const insert = db.prepare(
    `INSERT INTO thread_sessions (thread_id, provider_thread_id) VALUES (?, ?)
     ON CONFLICT (thread_id, provider_thread_id) DO NOTHING`,
  );
  db.transaction(() => {
    for (const id of providerThreadIds) insert.run(threadId, id);
  })();
}

/** Provider session ids known for a thread. */
export function readSessions(db: SqliteDatabase, threadId: string): Set<string> {
  const rows = db.prepare(`SELECT provider_thread_id FROM thread_sessions WHERE thread_id = ?`).all(threadId);
  const ids = new Set<string>();
  for (const row of rows) {
    const value = (row as Record<string, unknown>)["provider_thread_id"];
    if (typeof value === "string") ids.add(value);
  }
  return ids;
}

/**
 * True when a session log is unchanged since it was last parsed. Session logs
 * grow to megabytes, so an unchanged file is skipped rather than re-read.
 */
export function sessionLogUnchanged(
  db: SqliteDatabase,
  threadId: string,
  file: { path: string; mtimeMs: number; sizeBytes: number },
): boolean {
  const row = db
    .prepare(`SELECT mtime_ms, size_bytes FROM session_files WHERE thread_id = ? AND file_path = ?`)
    .get(threadId, file.path);
  if (row === null || typeof row !== "object") return false;
  const record = row as Record<string, unknown>;
  return record["mtime_ms"] === file.mtimeMs && record["size_bytes"] === file.sizeBytes;
}

/**
 * Replace one session log's command invocations. Scoped to the file, so a
 * thread with several provider sessions keeps the rows of the others.
 */
export function writeCommands(
  db: SqliteDatabase,
  args: {
    threadId: string;
    projectId: string;
    file: { path: string; mtimeMs: number; sizeBytes: number };
    invocations: readonly SkillInvocation[];
  },
): void {
  const drop = db.prepare(`DELETE FROM invocations WHERE thread_id = ? AND file_path = ?`);
  const upsert = db.prepare(UPSERT_INVOCATION);
  const remember = db.prepare(
    `INSERT INTO session_files (thread_id, file_path, mtime_ms, size_bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id, file_path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes`,
  );
  db.transaction(() => {
    drop.run(args.threadId, args.file.path);
    for (const invocation of args.invocations) {
      upsert.run(
        args.threadId,
        invocation.itemId,
        args.projectId,
        invocation.seq,
        invocation.createdAt,
        invocation.skill,
        invocation.args,
        invocation.status,
        invocation.source,
        args.file.path,
      );
    }
    remember.run(args.threadId, args.file.path, args.file.mtimeMs, args.file.sizeBytes);
  })();
}
