/**
 * The rollup index: the plugin's own sqlite table of skill invocations across
 * threads. It exists because the BB SDK has no cross-thread event query — the
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
  const upsert = db.prepare(
    `INSERT INTO invocations
       (thread_id, item_id, project_id, seq, created_at, skill, args, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, item_id) DO UPDATE SET
       project_id = excluded.project_id,
       created_at = excluded.created_at,
       skill = excluded.skill,
       args = excluded.args,
       status = excluded.status`,
  );
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
  db.transaction(() => {
    for (const id of gone) {
      dropInvocations.run(id);
      dropCursor.run(id);
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
  })();
}
