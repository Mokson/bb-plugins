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
//
// better-sqlite3 is loaded through `createRequire` at CALL time, behind a
// specifier the bundler cannot see. That is not a style choice. A static
// import lets esbuild inline the package's JavaScript into `dist/host.js`, and
// the inlined copy of `bindings` then resolves the native addon relative to
// the BUNDLE instead of to the package: it looks for
// `<plugin>/build/Release/better_sqlite3.node`, finds nothing, and every
// Cursor and OpenCode store comes back as "Could not locate the bindings
// file". Resolving at runtime from the emitted file reaches the real package,
// whose own `__dirname` points at its own `build/Release`.
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

type DatabaseConstructor = typeof BetterSqlite3;

/** Held in a variable so no bundler can statically resolve the specifier. */
const BETTER_SQLITE3 = "better-sqlite3";

let cached: DatabaseConstructor | null = null;

function loadDatabase(): DatabaseConstructor {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(BETTER_SQLITE3);
  // Both interop shapes: the CommonJS export is the constructor itself, but a
  // transpiled wrapper hands it back under `default`.
  const resolved = (
    typeof loaded === "function"
      ? loaded
      : (loaded as { default?: unknown } | null)?.default
  ) as DatabaseConstructor | undefined;
  if (typeof resolved !== "function") {
    throw new Error(
      "better-sqlite3 did not resolve to a constructor; the plugin's node_modules are missing or unbuilt",
    );
  }
  cached = resolved;
  return resolved;
}

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
  const Database = loadDatabase();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return {
    prepare: <P extends unknown[], R>(sql: string) =>
      db.prepare(sql) as unknown as ReadOnlyStatement<P, R>,
    close: () => db.close(),
  };
}
