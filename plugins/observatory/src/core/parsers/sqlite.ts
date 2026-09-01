// Read-only access to another tool's live SQLite store.
//
// Two rules, both learned the hard way by the community scanners:
//
//  - Open READ-ONLY but NOT immutable. Cursor and OpenCode both run in WAL
//    mode and leave the main file's mtime frozen between checkpoints, so an
//    `immutable=1` reader would silently miss every uncheckpointed write. A
//    plain read-only handle still sees the WAL.
//  - Never let one unreadable store take the pass down. A store held by a hot
//    journal that a read-only handle cannot recover throws; the caller logs
//    and moves on to the next file.
import Database from "better-sqlite3";

export interface ReadOnlyStatement<P extends unknown[], R> {
  get(...params: P): R | undefined;
  all(...params: P): R[];
}

export interface ReadOnlyDatabase {
  prepare<P extends unknown[] = [], R = unknown>(
    sql: string,
  ): ReadOnlyStatement<P, R>;
  close(): void;
}

export function openReadOnly(path: string): ReadOnlyDatabase {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return {
    prepare: <P extends unknown[], R>(sql: string) =>
      db.prepare(sql) as unknown as ReadOnlyStatement<P, R>,
    close: () => db.close(),
  };
}
