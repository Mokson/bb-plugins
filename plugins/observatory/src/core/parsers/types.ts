// What a provider log row means, and the helpers every parser shares.
//
// A parser turns raw session-log lines into `ParsedLogTurn`s and nothing else:
// no filesystem, no database, no clock. That is what makes each one testable
// from a fixture string, and it is why the byte accounting, the resume cursor
// and the log-key construction all live in the indexer instead.
//
// The one rule that outranks every other: a parser NEVER invents a number.
// `cacheRead` and `cacheWrite` are `null` when the provider did not report the
// split, because a fabricated split silently becomes a fabricated dollar
// figure two modules downstream.

/**
 * One priced model call, as the provider recorded it.
 *
 * This is `LogTurnRow` minus the storage identity: the indexer owns `log_key`
 * because only it knows the file and line a row came from.
 */
export interface ParsedLogTurn {
  provider: string;
  /** The provider's own session id. Null when the log does not carry one. */
  providerThreadId: string | null;
  /** Epoch milliseconds. */
  ts: number;
  /** Zero-based line within the source file, for the fallback log key. */
  line: number;
  /**
   * The provider's own request identity, when it has one.
   *
   * Claude Code writes one JSONL row per stream flush, so a single request
   * appears several times with IDENTICAL usage. Keying the row by `requestId`
   * makes the store's upsert collapse them; summing them would triple every
   * bill. Null means "no request identity", and the indexer falls back to
   * ts plus line.
   */
  dedupeKey: string | null;
  model: string | null;
  /** Uncached input tokens. */
  input: number;
  /** Null when the provider did not split cache read from cache write. */
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number;
  reasoning: number;
  /** The provider's own cost figure, when it reports one (Pi, OpenCode). */
  loggedCostUsd: number | null;
  isSidechain: boolean;
  /** The subagent that produced this row, for sidechain attribution. */
  agentId: string | null;
  cwd: string | null;
  skillNames: string[];
  mcpNames: string[];
}

export interface ParseContext {
  /** Absolute path of the file the lines came from. */
  path: string;
  /** Zero-based line number of `lines[0]` within the file. */
  startLine: number;
}

/**
 * A provider's log format.
 *
 * `parseLines` takes a slice so the indexer can resume mid-file; parsers that
 * need file-level context (a session-id header line that has already scrolled
 * past) recover it from `ctx.path` rather than by holding state across calls.
 */
export interface LogParser {
  provider: string;
  matches(path: string): boolean;
  parseLines(lines: string[], ctx: ParseContext): ParsedLogTurn[];
}

/** Where a database scan resumes, and how much of it to take. */
export interface DatabaseScanRequest {
  /**
   * Resume point, INCLUSIVE, in the units the parser's own cursor uses.
   *
   * Inclusive rather than exclusive so a group of rows sharing one timestamp
   * can never straddle a page boundary and lose its tail. The overlap costs
   * one re-read of the final group, and the store's upsert on `log_key` makes
   * that a no-op.
   */
  sinceCursor: number;
  /** Upper bound on rows returned by one scan. */
  limit: number;
}

export interface DatabaseScanResult {
  rows: ParsedLogTurn[];
  /** Where the next scan resumes. Never moves backwards. */
  cursor: number;
  /** False when rows remain behind `cursor`. */
  done: boolean;
}

/**
 * A provider whose log is a SQLite database rather than an append-only file.
 *
 * Cursor and OpenCode have no byte offset to resume from, so they resume from
 * an ORDERING cursor instead. That is the difference that matters at scale: a
 * 50MB OpenCode store holds six figures of assistant messages, and returning
 * all of them on every change turns a background pass into a stall. They still
 * implement `LogParser` so one registry covers every provider, but
 * `parseLines` is inert for them and the indexer branches on the presence of
 * `scanDatabase`.
 */
export interface DatabaseLogParser extends LogParser {
  scanDatabase(path: string, request: DatabaseScanRequest): DatabaseScanResult;
}

export function isDatabaseParser(
  parser: LogParser,
): parser is DatabaseLogParser {
  return typeof (parser as DatabaseLogParser).scanDatabase === "function";
}

// ---------------------------------------------------------------------------
// Shared coercions.
//
// Session logs are written by half a dozen agents across many versions, so a
// field that is a number today may be a numeric string or missing tomorrow.
// Every parser reads through these rather than trusting a shape.
// ---------------------------------------------------------------------------

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A finite number, or null. Accepts numeric strings. */
export function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A non-negative integer token count. Missing or junk reads as 0. */
export function count(value: unknown): number {
  return Math.max(0, Math.round(finite(value) ?? 0));
}

/**
 * A non-negative integer token count, or null when the field is ABSENT.
 *
 * The difference from `count` is the whole cache-split rule: a provider that
 * omits `cache_read` has not told us it was zero.
 */
export function countOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = finite(value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Epoch milliseconds from an ISO string or a numeric timestamp. */
export function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds and milliseconds are both in the wild. Anything below this
    // threshold is a second-resolution stamp, not a 1970 date.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Parse JSONL, skipping blank and malformed lines. */
export function jsonLines(
  lines: string[],
  startLine: number,
): Array<{ value: Record<string, unknown>; line: number }> {
  const parsed: Array<{ value: Record<string, unknown>; line: number }> = [];
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      const value = asObject(JSON.parse(raw));
      // A live session file's last line is often half-written. The indexer
      // only ever hands over COMPLETE lines, so a parse failure here is a
      // genuinely corrupt row and dropping it is right.
      if (value) parsed.push({ value, line: startLine + index });
    } catch {
      // Ignored on purpose; see above.
    }
  });
  return parsed;
}

/** Collect distinct, defined strings in first-seen order. */
export function distinct(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.trim()) seen.add(value);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// The registry.
//
// Declared here rather than in an index module so `LogParser` and the list of
// its implementations stay one import for every consumer. The circular-looking
// imports below are fine: each parser module imports only the TYPES from this
// file, and the values it exports are read lazily at module init.
// ---------------------------------------------------------------------------
export { PARSERS, parserFor } from "./registry.js";
