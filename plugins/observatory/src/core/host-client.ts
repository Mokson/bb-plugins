// The log-indexing seam.
//
// Log parsing is filesystem work on the machine that ran the agent, so it
// belongs in the `bb.host` worker. Everything above it talks to this
// interface, and phase 1 plus every test uses `LocalHostClient`, which
// implements it in-process. That keeps the indexer testable without a daemon
// and keeps the remote-host case a swap of one object.
//
// The split of responsibility with `indexer.ts` is deliberate: this side owns
// bytes (walking roots, resuming at an offset, proving a file was appended to
// and not rewritten) and returns parsed rows plus new file state. The indexer
// owns the database and decides what to persist. Nothing here touches sqlite
// except through a provider's own read-only store.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  isDatabaseParser,
  parserFor,
  type LogParser,
  type ParsedLogTurn,
} from "./parsers/types.js";

/**
 * Bumped when a parser's output changes meaning. A file indexed by an older
 * version is reparsed from byte zero rather than resumed, because resuming
 * would leave rows from two different interpretations in one session.
 */
export const PARSER_VERSION = 1;

/**
 * How much of a file's head identifies it.
 *
 * A full-prefix hash would re-read every indexed byte on every pass; on a
 * multi-gigabyte `~/.claude/projects` that is the entire cost of the sweep.
 * Head bytes plus size plus mtime catch the cases that matter: a truncated
 * file shrinks, and a rewritten file changes its opening lines.
 */
export const FINGERPRINT_BYTES = 64 * 1024;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".Trash",
  "__pycache__",
]);

/** Guard rails on one sweep, so a pathological tree cannot hang the worker. */
const MAX_WALK_DEPTH = 12;
const MAX_FILES_PER_ROOT = 50_000;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** What the store already knows about a file, so the host can resume it. */
export const fileStateSchema = z
  .object({
    indexedBytes: z.number(),
    indexedLines: z.number(),
    contentHash: z.string().nullable(),
    sizeBytes: z.number(),
    mtimeMs: z.number(),
    parserVersion: z.number(),
  })
  .strict();

export const indexBatchInputSchema = z
  .object({
    /** Absolute log roots to scan. */
    roots: z.array(z.string()),
    /**
     * Resume point per file path: bytes already indexed. Kept for callers
     * that only hold the byte offset; `state` supersedes it when both are
     * given, because a byte offset alone cannot prove a file was appended to
     * rather than rewritten in place.
     */
    cursors: z.record(z.string(), z.number()).default({}),
    state: z.record(z.string(), fileStateSchema).default({}),
    /** Upper bound on rows returned in one call. */
    limit: z.number().int().positive().default(500),
    /** Upper bound on bytes read for parsing in one call. */
    maxBytes: z.number().int().positive().default(20_000_000),
  })
  .strict();

export const logRowSchema = z
  .object({
    logKey: z.string(),
    provider: z.string(),
    providerThreadId: z.string().nullable(),
    /** Epoch milliseconds. */
    ts: z.number(),
    path: z.string(),
    indexedBytes: z.number(),
    model: z.string().nullable(),
    input: z.number(),
    cacheRead: z.number().nullable(),
    cacheWrite: z.number().nullable(),
    output: z.number(),
    reasoning: z.number(),
    loggedCostUsd: z.number().nullable(),
    isSidechain: z.boolean(),
    agentId: z.string().nullable(),
    cwd: z.string().nullable(),
    skillNames: z.array(z.string()),
    mcpNames: z.array(z.string()),
  })
  .strict();

export const fileResultSchema = z
  .object({
    path: z.string(),
    rootId: z.string(),
    provider: z.string(),
    providerThreadId: z.string().nullable(),
    sizeBytes: z.number(),
    mtimeMs: z.number(),
    indexedBytes: z.number(),
    indexedLines: z.number(),
    contentHash: z.string().nullable(),
    parserVersion: z.number(),
    /** True when the file was reparsed from zero rather than resumed. */
    reset: z.boolean(),
    parseError: z.string().nullable(),
  })
  .strict();

export const indexBatchOutputSchema = z
  .object({
    rows: z.array(logRowSchema),
    files: z.array(fileResultSchema).default([]),
    /** Known paths that no longer exist on disk. The indexer prunes them. */
    missing: z.array(z.string()).default([]),
    /** False when more rows remain behind the returned cursors. */
    done: z.boolean(),
  })
  .strict();

export const pingOutputSchema = z.object({ ok: z.literal(true) }).strict();

/** The contract both the host worker and `LocalHostClient` implement. */
export const hostContract = defineRpcContract({
  ping: { input: z.object({}).strict(), output: pingOutputSchema },
  indexBatch: {
    input: indexBatchInputSchema,
    output: indexBatchOutputSchema,
  },
});

export type IndexBatchInput = z.input<typeof indexBatchInputSchema>;
export type IndexBatchOutput = z.output<typeof indexBatchOutputSchema>;
export type LogRow = z.output<typeof logRowSchema>;
export type FileResult = z.output<typeof fileResultSchema>;
export type FileState = z.output<typeof fileStateSchema>;

export interface HostClient {
  ping(): Promise<{ ok: true }>;
  indexBatch(input: IndexBatchInput): Promise<IndexBatchOutput>;
}

// ---------------------------------------------------------------------------
// Filesystem work
// ---------------------------------------------------------------------------

/** Files some parser claims, under one root. */
export async function discoverFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES_PER_ROOT) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped, not fatal: one bad permission
      // must not cost the whole sweep.
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_PER_ROOT) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (parserFor(path)) found.push(path);
    }
  }

  try {
    const rootStat = await stat(root);
    if (rootStat.isFile()) return parserFor(root) ? [root] : [];
  } catch {
    // A root a provider was never installed for. Absent, not an error.
    return [];
  }
  await walk(root, 0);
  found.sort();
  return found;
}

/**
 * sha256 over the first `min(length, FINGERPRINT_BYTES)` bytes.
 *
 * `length` is the INDEXED length, never the file's current size. Fingerprinting
 * the whole of a small file would make every append look like a rewrite, since
 * the appended bytes fall inside the window; hashing a fixed prefix of what was
 * already parsed is stable under append and still changes under a rewrite.
 */
export async function headFingerprint(
  path: string,
  length: number,
): Promise<string | null> {
  if (length <= 0) return null;
  const end = Math.min(length, FINGERPRINT_BYTES) - 1;
  const hash = createHash("sha256");
  const stream = createReadStream(path, { start: 0, end });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

export interface ReadResult {
  lines: string[];
  /** Byte offset after the last COMPLETE line. */
  endByte: number;
}

/**
 * Complete lines only, from `startByte`.
 *
 * A live session file usually ends mid-line, so the cursor stops at the last
 * newline and the partial tail is re-read next pass, when it is whole.
 *
 * `atEof` handles the other case, and it is not an optimisation: plenty of
 * finished session files have no trailing newline at all. Without this their
 * last line would never be consumable, the cursor would never reach the file's
 * size, and every sweep would re-read and re-upsert them forever. A fragment
 * at EOF is accepted only when it parses as JSON, which a half-written line
 * essentially never does.
 */
export async function readCompleteLines(
  path: string,
  startByte: number,
  endByte: number,
  atEof = false,
): Promise<ReadResult> {
  if (endByte <= startByte) return { lines: [], endByte: startByte };
  const stream = createReadStream(path, { start: startByte, end: endByte - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);
  const lastNewline = buffer.lastIndexOf(10);

  const consumed = lastNewline + 1;
  const lines =
    lastNewline === -1
      ? []
      : buffer
          .subarray(0, lastNewline)
          .toString("utf8")
          .split("\n")
          .map((line) => line.replace(/\r$/, ""));

  if (atEof) {
    const tail = buffer.subarray(consumed).toString("utf8").trim();
    if (tail) {
      try {
        JSON.parse(tail);
        lines.push(tail);
        return { lines, endByte };
      } catch {
        // A genuinely half-written last line. Left for the next pass.
      }
    } else if (consumed < buffer.length) {
      // Trailing whitespace only; nothing will ever be parsed from it.
      return { lines, endByte };
    }
  }

  if (lastNewline === -1) return { lines: [], endByte: startByte };
  return { lines, endByte: startByte + consumed };
}

/** `provider:session:requestId`, or `provider:session:ts:line` without one. */
export function logKeyFor(row: ParsedLogTurn): string {
  const session = row.providerThreadId ?? "unknown";
  return row.dedupeKey
    ? `${row.provider}:${session}:${row.dedupeKey}`
    : `${row.provider}:${session}:${row.ts}:${row.line}`;
}

function toWireRow(
  row: ParsedLogTurn,
  path: string,
  indexedBytes: number,
): LogRow {
  return {
    logKey: logKeyFor(row),
    provider: row.provider,
    providerThreadId: row.providerThreadId,
    ts: row.ts,
    path,
    indexedBytes,
    model: row.model,
    input: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    loggedCostUsd: row.loggedCostUsd,
    isSidechain: row.isSidechain,
    agentId: row.agentId,
    cwd: row.cwd,
    skillNames: row.skillNames,
    mcpNames: row.mcpNames,
  };
}

interface IndexOutcome {
  file: FileResult;
  rows: ParsedLogTurn[];
  bytesRead: number;
  complete: boolean;
}

/**
 * The in-process implementation, and the only one phase 1 uses.
 *
 * Stateless by design: the caller supplies the resume state and gets new state
 * back, so a crash mid-sweep costs at most one batch of re-parsing and two
 * sweeps cannot corrupt each other's cursors.
 */
export class LocalHostClient implements HostClient {
  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async indexBatch(rawInput: IndexBatchInput): Promise<IndexBatchOutput> {
    const input = indexBatchInputSchema.parse(rawInput);
    const rows: LogRow[] = [];
    const files: FileResult[] = [];
    const seen = new Set<string>();
    let bytesRead = 0;
    let done = true;

    for (const root of input.roots) {
      for (const path of await discoverFiles(root)) {
        seen.add(path);
        const parser = parserFor(path);
        if (!parser) continue;
        if (bytesRead >= input.maxBytes || rows.length >= input.limit) {
          // Out of budget. The tree was still walked, so `missing` stays
          // correct; the caller is told to come back with `done: false`.
          done = false;
          continue;
        }

        const previous = resumeState(input, path);
        let outcome: IndexOutcome | null;
        try {
          outcome = await indexOne(
            root,
            path,
            parser,
            previous,
            input.maxBytes - bytesRead,
          );
        } catch {
          // The file vanished or became unreadable mid-sweep. Next pass.
          continue;
        }
        if (!outcome) continue;

        files.push(outcome.file);
        bytesRead += outcome.bytesRead;
        if (!outcome.complete) done = false;
        for (const row of outcome.rows) {
          rows.push(toWireRow(row, path, outcome.file.indexedBytes));
        }
      }
    }

    // A cursor for a path the walk did not find. The roots were fully walked
    // above, so absence here is real rather than a missed directory.
    const missing = [
      ...new Set([...Object.keys(input.cursors), ...Object.keys(input.state)]),
    ].filter((path) => !seen.has(path));

    return { rows, files, missing, done };
  }
}

function resumeState(
  input: z.output<typeof indexBatchInputSchema>,
  path: string,
): FileState | undefined {
  const state = input.state[path];
  if (state) return state;
  const bytes = input.cursors[path];
  if (bytes === undefined) return undefined;
  // A bare byte cursor cannot prove the head is unchanged, so it is given a
  // null hash: the resume still happens, and the first pass that also carries
  // state upgrades it.
  return {
    indexedBytes: bytes,
    indexedLines: 0,
    contentHash: null,
    sizeBytes: 0,
    mtimeMs: 0,
    parserVersion: PARSER_VERSION,
  };
}

async function indexDatabase(
  root: string,
  path: string,
  parser: LogParser,
  previous: FileState | undefined,
  size: number,
  mtimeMs: number,
): Promise<IndexOutcome | null> {
  // A SQLite store has no byte cursor, so it is re-queried whenever size or
  // mtime moved. WAL sidecars mean the main file's mtime can lag a write; an
  // over-eager re-query only costs a query, while a missed one loses rows.
  if (
    previous &&
    previous.parserVersion === PARSER_VERSION &&
    previous.sizeBytes === size &&
    previous.mtimeMs === mtimeMs
  ) {
    return null;
  }
  let rows: ParsedLogTurn[] = [];
  let parseError: string | null = null;
  try {
    rows = isDatabaseParser(parser) ? parser.scanDatabase(path) : [];
  } catch (error) {
    // A store held by a hot journal, or an encrypted one. Recorded on the
    // file row so the coverage report can explain the gap rather than hide it.
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    file: {
      path,
      rootId: root,
      provider: parser.provider,
      providerThreadId: rows[0]?.providerThreadId ?? null,
      sizeBytes: size,
      mtimeMs,
      indexedBytes: size,
      indexedLines: 0,
      contentHash: null,
      parserVersion: PARSER_VERSION,
      reset: true,
      parseError,
    },
    rows,
    bytesRead: 0,
    complete: true,
  };
}

async function indexOne(
  root: string,
  path: string,
  parser: LogParser,
  previous: FileState | undefined,
  byteBudget: number,
): Promise<IndexOutcome | null> {
  const fileStat = await stat(path);
  const size = fileStat.size;
  const mtimeMs = Math.round(fileStat.mtimeMs);

  if (isDatabaseParser(parser)) {
    return indexDatabase(root, path, parser, previous, size, mtimeMs);
  }

  const parserChanged =
    previous !== undefined && previous.parserVersion !== PARSER_VERSION;
  // Either the file was truncated, or a cursor points past its end. Both mean
  // the stored rows describe a file that no longer exists.
  const shrank =
    previous !== undefined &&
    (size < previous.sizeBytes || previous.indexedBytes > size);

  let reset = previous === undefined || parserChanged || shrank;
  if (!reset && previous) {
    if (
      previous.indexedBytes >= size &&
      previous.sizeBytes === size &&
      previous.mtimeMs === mtimeMs
    ) {
      // Fully indexed and untouched. The common case on every pass, and the
      // reason a sweep over 6,000 files is cheap.
      return null;
    }
    if (previous.contentHash !== null) {
      // The file grew. Prove the already-indexed prefix is unchanged, or the
      // "append" is really an in-place rewrite and the stored rows are stale.
      const head = await headFingerprint(path, previous.indexedBytes);
      if (head !== previous.contentHash) reset = true;
    }
  }

  const startByte = reset ? 0 : (previous?.indexedBytes ?? 0);
  const startLine = reset ? 0 : (previous?.indexedLines ?? 0);
  const limit = Math.min(size, startByte + Math.max(0, byteBudget));

  let read: ReadResult = { lines: [], endByte: startByte };
  let parseError: string | null = null;
  let rows: ParsedLogTurn[] = [];
  try {
    read = await readCompleteLines(path, startByte, limit, limit >= size);
    rows = parser.parseLines(read.lines, { path, startLine });
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const indexedBytes = read.endByte;
  const contentHash = await headFingerprint(path, indexedBytes).catch(() => null);
  const sessionId =
    rows.find((row) => row.providerThreadId)?.providerThreadId ?? null;

  return {
    file: {
      path,
      rootId: root,
      provider: parser.provider,
      providerThreadId: sessionId,
      sizeBytes: size,
      mtimeMs,
      indexedBytes,
      indexedLines: startLine + read.lines.length,
      contentHash,
      parserVersion: PARSER_VERSION,
      reset,
      parseError,
    },
    rows,
    bytesRead: Math.max(0, indexedBytes - startByte),
    complete: indexedBytes >= size,
  };
}
