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
 *
 * Version 2: `obs_log_turn` gained a `path` column, which is now the row's
 * delete key. Rows written by version 1 carry a null path and nothing can
 * recover it, so every file is reparsed once and re-upserts its rows with the
 * path filled in.
 */
export const PARSER_VERSION = 2;

/**
 * What one database row costs against the byte budget.
 *
 * A SQLite parser reads no file bytes, so it used to report `bytesRead: 0` and
 * escape the budget entirely: a 50MB OpenCode store was scanned whole on every
 * pass while the budget still read as untouched. The weight is the order of
 * magnitude of a real OpenCode `message.data` blob, which is what the query
 * walks even though `json_extract` hands back only scalars.
 */
const DB_ROW_BYTE_WEIGHT = 4 * 1024;

/** Rows one database scan may return, however much budget is left. */
const MAX_DB_ROWS_PER_SCAN = 2_000;

/** A root still holding files to read, and the budget left to read them with. */
interface RootQueue {
  root: string;
  files: string[];
  budget: number;
}

/**
 * Hand `amount` bytes back to the roots still working.
 *
 * A root that runs out of files before it runs out of budget has not earned
 * the right to waste it: the leftover is carried forward to the roots that
 * still have something to read, which is what keeps a fair split from also
 * being a wasteful one.
 */
function redistribute(queues: RootQueue[], amount: number): void {
  if (amount <= 0 || queues.length === 0) return;
  const share = Math.floor(amount / queues.length);
  for (const queue of queues) queue.budget += share;
  queues[0]!.budget += amount - share * queues.length;
}

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
    /**
     * Row count at which the pass stops taking new files.
     *
     * Checked between files, not between rows, so the returned batch can
     * overshoot by the contents of the file that crossed the line. Bounding it
     * exactly would mean returning half a file, which the resume cursor cannot
     * describe.
     */
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

/** How many `stat` calls are in flight at once while ordering a root. */
const STAT_CONCURRENCY = 256;

/**
 * Discovered paths, most recently modified first.
 *
 * One `stat` per file, which is the same syscall `indexOne` makes anyway and
 * is measured in tens of milliseconds across thousands of files. It buys the
 * ordering that decides which files a budgeted pass reaches.
 *
 * Issued in bounded chunks rather than one `Promise.all` over the lot:
 * `MAX_FILES_PER_ROOT` is 50,000, and 50,000 simultaneous `stat` calls swamp
 * libuv's thread pool and stall every other await in the worker behind them.
 */
async function newestFirst(paths: string[]): Promise<string[]> {
  const stamped: Array<{ path: string; mtimeMs: number }> = [];
  for (let start = 0; start < paths.length; start += STAT_CONCURRENCY) {
    const chunk = paths.slice(start, start + STAT_CONCURRENCY);
    stamped.push(
      ...(await Promise.all(
        chunk.map(async (path) => ({
          path,
          mtimeMs: await stat(path).then(
            (entry) => entry.mtimeMs,
            () => 0,
          ),
        })),
      )),
    );
  }
  stamped.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
  );
  return stamped.map((entry) => entry.path);
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
    let done = true;

    // Every root is walked before any of them is read, because `missing` is
    // only correct once the whole tree has been seen. Walking is cheap;
    // reading is what the budget is for.
    const queues: RootQueue[] = [];
    for (const root of input.roots) {
      const found = await discoverFiles(root);
      for (const path of found) seen.add(path);
      // Newest first: the sessions a person is asking about are the ones they
      // just ran, so a budget that runs out mid-pass leaves the OLD tail
      // unindexed rather than the live one.
      if (found.length) {
        queues.push({ root, files: await newestFirst(found), budget: 0 });
      }
    }

    // Round robin over the roots, each spending its OWN share of the budget.
    //
    // The list order used to be the schedule, and one shared pot meant
    // `~/.claude/projects` (2,000+ files, gigabytes) consumed every pass on its
    // own: after days of running, the live database held claude-code rows and
    // nothing else. Not a slow backlog, a permanent one. Two things fix it,
    // and both are needed. Taking one file from each root in turn is the
    // rotation; giving each root its own slice of the budget is what stops the
    // first root's first file from spending the whole pass before the rotation
    // gets a second turn. A root that finishes early hands its leftover to the
    // roots still working, so fairness costs no throughput.
    redistribute(queues, input.maxBytes);
    let turn = 0;
    while (queues.length) {
      if (rows.length >= input.limit) {
        // The trees were fully walked above, so `missing` is still correct;
        // the caller is told to come back with `done: false`.
        done = false;
        break;
      }
      turn %= queues.length;
      const queue = queues[turn]!;
      if (queue.budget <= 0) {
        // This root is spent for the pass. Its files stay unread and the next
        // pass resumes them from the same cursors.
        queues.splice(turn, 1);
        done = false;
        continue;
      }

      const path = queue.files.shift()!;
      const exhausted = queue.files.length === 0;
      if (exhausted) {
        queues.splice(turn, 1);
      } else {
        turn += 1;
      }

      const parser = parserFor(path);
      let outcome: IndexOutcome | null = null;
      if (parser) {
        try {
          outcome = await indexOne(
            queue.root,
            path,
            parser,
            resumeState(input, path),
            queue.budget,
          );
        } catch {
          // The file vanished or became unreadable mid-sweep. Next pass.
          outcome = null;
        }
      }
      if (outcome) {
        files.push(outcome.file);
        queue.budget -= outcome.bytesRead;
        if (!outcome.complete) done = false;
        for (const row of outcome.rows) {
          rows.push(toWireRow(row, path, outcome.file.indexedBytes));
        }
      }
      if (exhausted) redistribute(queues, Math.max(0, queue.budget));
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

/**
 * A SQLite-backed provider, resumed from an ordering cursor.
 *
 * Two pieces of file state are reused with different meanings, which is why
 * they are spelled out here: `indexedLines` holds the parser's scan CURSOR
 * (OpenCode's `time_created`), and `indexedBytes` is the completion flag,
 * equal to the file size once the store has been scanned to its end and zero
 * while a scan is still paging. That is what lets the unchanged-file
 * short-circuit below stay honest: a store whose size and mtime have not moved
 * is skipped ONLY when the last scan actually finished it.
 */
async function indexDatabase(
  root: string,
  path: string,
  parser: LogParser,
  previous: FileState | undefined,
  size: number,
  mtimeMs: number,
  byteBudget: number,
): Promise<IndexOutcome | null> {
  const sinceCursor = previous?.indexedLines ?? 0;
  // WAL sidecars mean the main file's mtime can lag a write, so an unchanged
  // stat is not proof of an unchanged store; but re-querying a finished store
  // whose stat has not moved costs a query on every pass for no rows, and the
  // next write moves the stat. An over-eager re-query is the cheap error.
  if (
    previous &&
    previous.parserVersion === PARSER_VERSION &&
    previous.sizeBytes === size &&
    previous.mtimeMs === mtimeMs &&
    previous.indexedBytes >= size
  ) {
    return null;
  }

  const limit = Math.max(
    1,
    Math.min(
      MAX_DB_ROWS_PER_SCAN,
      Math.floor(Math.max(0, byteBudget) / DB_ROW_BYTE_WEIGHT),
    ),
  );
  let rows: ParsedLogTurn[] = [];
  let cursor = sinceCursor;
  let complete = true;
  let parseError: string | null = null;
  try {
    if (isDatabaseParser(parser)) {
      const scan = parser.scanDatabase(path, { sinceCursor, limit });
      rows = scan.rows;
      cursor = scan.cursor;
      complete = scan.done;
    }
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
      indexedBytes: complete ? size : 0,
      indexedLines: cursor,
      contentHash: null,
      parserVersion: PARSER_VERSION,
      // Only the page that starts at zero replaces what is stored. A later
      // page ADDS to it, and a reset there would delete every earlier page.
      reset: sinceCursor === 0,
      parseError,
    },
    rows,
    bytesRead: rows.length * DB_ROW_BYTE_WEIGHT,
    complete,
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
    return indexDatabase(
      root,
      path,
      parser,
      previous,
      size,
      mtimeMs,
      byteBudget,
    );
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
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const indexedBytes = read.endByte;
  // Fingerprint BEFORE parsing and re-stat immediately after, so the hash and
  // the lines describe the same file.
  //
  // The window this closes: a provider that rotates or rewrites a log between
  // the read and the fingerprint produced a hash of the NEW head over rows
  // parsed from the OLD one. The next pass compared that hash, found it
  // matching, and treated the rewrite as a clean append. Everything below is
  // stated relative to the `fileStat` taken at the top of this function, so a
  // size or mtime that has moved means the outcome describes two different
  // files; the honest answer is to record nothing and let the next pass see
  // the file settled.
  const contentHash = await headFingerprint(path, indexedBytes).catch(
    () => null,
  );
  const after = await stat(path).catch(() => null);
  if (
    !after ||
    after.size !== size ||
    Math.round(after.mtimeMs) !== mtimeMs
  ) {
    return null;
  }

  if (!parseError) {
    try {
      rows = parser.parseLines(read.lines, { path, startLine });
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      rows = [];
    }
  }

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
