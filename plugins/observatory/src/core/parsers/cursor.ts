// Cursor ACP sessions (`~/.cursor/acp-sessions/<session>/store.db`).
//
// The finding that shapes this file: Cursor's store carries NO usage. Its
// whole schema is
//
//     CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
//     CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
//
// with no token counts, no cost, no model and no per-message timestamp. The
// community scanner fills that hole with an estimator (characters / 3.6, a
// synthetic 200k context window per request). This plugin will not: an
// estimate stored in the same column as a measurement becomes an invented
// dollar figure the moment anything sums the column, and the ledger's one hard
// rule is that a cache split is never fabricated.
//
// So Cursor contributes exactly one row per session: a PRESENCE marker with
// zero tokens, a null split and no model. Downstream that prices as
// `unknown`/`unavailable`, which is the truth, and it lets the UI say "Cursor
// session, usage not recorded" instead of "no transcript found".
import { basename, dirname } from "node:path";
import {
  type DatabaseLogParser,
  type DatabaseScanResult,
  type ParseContext,
  type ParsedLogTurn,
} from "./types.js";
import { openReadOnly, type ReadOnlyDatabase } from "./sqlite.js";

export const CURSOR_PROVIDER = "acp-cursor";

/** The directory name IS the session id. */
export function cursorSessionId(path: string): string {
  return basename(dirname(path));
}

interface CursorMeta {
  name?: unknown;
  createdAt?: unknown;
  agentId?: unknown;
}

/**
 * `meta.value` is a HEX-encoded JSON string, not raw JSON. It is the only
 * place a real timestamp (`createdAt`, epoch ms) exists in the store, so it is
 * worth the decode: without it the row would have to be stamped from the
 * file's mtime, which moves every time Cursor checkpoints.
 */
export function decodeCursorMeta(value: string | null): CursorMeta | null {
  if (!value) return null;
  const hex = /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
  try {
    const json = hex ? Buffer.from(value, "hex").toString("utf8") : value;
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CursorMeta)
      : null;
  } catch {
    return null;
  }
}

/**
 * One presence row per session, so there is nothing to page: the scan is
 * always answered whole and the cursor is the marker's own timestamp.
 */
export function scanCursorDatabase(
  path: string,
  open: (file: string) => ReadOnlyDatabase = openReadOnly,
): DatabaseScanResult {
  const db = open(path);
  const empty: DatabaseScanResult = { rows: [], cursor: 0, done: true };
  try {
    const meta = db
      .prepare<[], { value: string }>("SELECT value FROM meta LIMIT 1")
      .get();
    const decoded = decodeCursorMeta(meta?.value ?? null);
    const createdAt =
      typeof decoded?.createdAt === "number" &&
      Number.isFinite(decoded.createdAt)
        ? decoded.createdAt
        : null;
    // No meta and no blobs means an empty or unreadable store: nothing to
    // record at all, rather than a marker for a session that never ran.
    const blobs = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM blobs")
      .get();
    if (createdAt === null && (blobs?.n ?? 0) === 0) return empty;

    const rows: ParsedLogTurn[] = [
      {
        provider: CURSOR_PROVIDER,
        providerThreadId: cursorSessionId(path),
        ts: createdAt ?? 0,
        line: 0,
        dedupeKey: "session",
        model: null,
        input: 0,
        // Not zero: unknown. Cursor never wrote a split.
        cacheRead: null,
        cacheWrite: null,
        output: 0,
        reasoning: 0,
        loggedCostUsd: null,
        isSidechain: false,
        agentId:
          typeof decoded?.agentId === "string" ? decoded.agentId : null,
        cwd: null,
        skillNames: [],
        mcpNames: [],
      },
    ];
    return { rows, cursor: createdAt ?? 0, done: true };
  } finally {
    db.close();
  }
}

export const cursorParser: DatabaseLogParser = {
  provider: CURSOR_PROVIDER,
  matches: (path) =>
    basename(path) === "store.db" &&
    (path.includes("/.cursor/acp-sessions/") || path.includes("/.cursor/chats/")),
  // Nothing line-shaped to parse; the indexer routes this parser through
  // `scanDatabase`.
  parseLines: (_lines: string[], _ctx: ParseContext) => [],
  scanDatabase: (path) => scanCursorDatabase(path),
};
