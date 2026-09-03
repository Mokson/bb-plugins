import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  clearIndex,
  indexedThreadCount,
  loadRollup,
  MIGRATIONS,
  pruneThreads,
  readCursor,
  writeThread,
  type SqliteDatabase,
} from "./index-store";
import { collapseInvocations, type SkillInvocation } from "./model";
import { shouldRefresh } from "./refresh-policy";
import { INDEX_CHANNEL, skillUsageRpcContract } from "./skill-usage-contract";

/** Event types that can carry a Skill tool call. */
const SKILL_EVENT_TYPES = ["item/started", "item/completed"] as const;

/** Events per `events.list` page. */
const EVENT_PAGE = 1000;

/**
 * Page ceiling for one thread. A thread longer than this indexes its first
 * million events; the cap exists so a runaway thread cannot stall a pass.
 */
const MAX_EVENT_PAGES = 1000;

/** Threads per `threads.list` page. */
const THREAD_PAGE = 200;

/** Server-held wait for the live thread panel. */
const WAIT_MS = 25_000;

/** Threads between progress signals during a backfill. */
const PROGRESS_EVERY = 5;

const LAST_REFRESH_KEY = "index.lastRefreshAt";

interface IndexStatus {
  running: boolean;
  done: number;
  total: number;
  indexedThreads: number;
  lastRefreshAt: number | null;
  error: string | null;
}

interface ThreadRef {
  id: string;
  projectId: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const handle = bb.storage.database();
  bb.storage.migrate(handle, [...MIGRATIONS]);
  // The driver handle satisfies the narrow slice index-store needs; the cast
  // keeps that slice as the module's contract instead of pulling the full
  // better-sqlite3 type into every call site.
  const db = handle as unknown as SqliteDatabase;

  let status: IndexStatus = {
    running: false,
    done: 0,
    total: 0,
    indexedThreads: indexedThreadCount(db),
    lastRefreshAt: (await bb.storage.kv.get<number>(LAST_REFRESH_KEY)) ?? null,
    error: null,
  };

  // One pass at a time. A second refresh request while a pass runs is a no-op
  // that returns the live status, so an impatient panel cannot fan out passes.
  let pass: Promise<void> | null = null;
  const disposed = new AbortController();

  function publishStatus(): void {
    bb.realtime.publish(INDEX_CHANNEL, { ...status });
  }

  /**
   * Every thread BB knows about, archived and hidden included. `threads.list`
   * documents `archived` as a filter without stating whether true means "only
   * archived" or "archived too", so both queries run and merge by id.
   */
  async function listAllThreads(signal: AbortSignal): Promise<ThreadRef[]> {
    const byId = new Map<string, ThreadRef>();
    for (const archived of [undefined, true] as const) {
      let offset = 0;
      for (;;) {
        if (signal.aborted) return [...byId.values()];
        const page = (await bb.sdk.threads.list({
          archived,
          includeHidden: true,
          limit: THREAD_PAGE,
          offset,
          signal,
        })) as unknown[];
        for (const entry of page) {
          const record = asRecord(entry);
          const id = record["id"];
          const projectId = record["projectId"];
          if (typeof id === "string" && typeof projectId === "string") {
            byId.set(id, { id, projectId });
          }
        }
        if (page.length < THREAD_PAGE) break;
        offset += THREAD_PAGE;
      }
    }
    return [...byId.values()];
  }

  /**
   * Walk one thread's item events from `afterSeq`, returning the skill
   * invocations found and the highest sequence seen. The highest sequence is
   * of any item event, not only skill ones, so the cursor advances past
   * threads that used no skills at all.
   */
  async function walkThread(
    threadId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): Promise<{ invocations: SkillInvocation[]; lastSeq: number }> {
    const rows: unknown[] = [];
    let cursor = afterSeq;
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      if (signal.aborted) break;
      const events = (await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(cursor),
        limit: String(EVENT_PAGE),
        order: "asc",
        types: SKILL_EVENT_TYPES,
        signal,
      })) as unknown[];
      for (const event of events) {
        rows.push(event);
        const seq = asRecord(event)["seq"];
        if (typeof seq === "number" && seq > cursor) cursor = seq;
      }
      if (events.length < EVENT_PAGE) break;
    }
    return { invocations: collapseInvocations(rows), lastSeq: cursor };
  }

  async function runPass(rebuild: boolean): Promise<void> {
    const signal = disposed.signal;
    status = {
      running: true,
      done: 0,
      total: 0,
      indexedThreads: status.indexedThreads,
      lastRefreshAt: status.lastRefreshAt,
      error: null,
    };
    publishStatus();
    try {
      if (rebuild) clearIndex(db);
      const threads = await listAllThreads(signal);
      status.total = threads.length;
      publishStatus();
      // Threads deleted since the last pass leave rows nothing can name, so
      // they go before the walk rather than lingering until the next open.
      pruneThreads(db, new Set(threads.map((thread) => thread.id)));

      for (const thread of threads) {
        if (signal.aborted) break;
        const after = readCursor(db, thread.id);
        const walked = await walkThread(thread.id, after, signal);
        if (walked.invocations.length > 0 || walked.lastSeq > after) {
          writeThread(db, {
            threadId: thread.id,
            projectId: thread.projectId,
            invocations: walked.invocations,
            lastSeq: walked.lastSeq,
          });
        }
        status.done += 1;
        if (status.done % PROGRESS_EVERY === 0) {
          status.indexedThreads = indexedThreadCount(db);
          publishStatus();
        }
      }
      status.lastRefreshAt = Date.now();
      await bb.storage.kv.set(LAST_REFRESH_KEY, status.lastRefreshAt);
    } catch (error) {
      status.error = errorMessage(error);
      bb.log.error(`skill-usage index pass failed: ${status.error}`);
    } finally {
      status.running = false;
      status.indexedThreads = indexedThreadCount(db);
      pass = null;
      publishStatus();
    }
  }

  /** Thread titles for the rollup drill-down, resolved live so renames land. */
  async function threadTitles(ids: ReadonlySet<string>): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (ids.size === 0) return titles;
    for (const archived of [undefined, true] as const) {
      let offset = 0;
      for (;;) {
        const page = (await bb.sdk.threads.list({
          archived,
          includeHidden: true,
          limit: THREAD_PAGE,
          offset,
        })) as unknown[];
        for (const entry of page) {
          const record = asRecord(entry);
          const id = record["id"];
          if (typeof id !== "string" || !ids.has(id)) continue;
          const title = record["title"];
          const fallback = record["titleFallback"];
          if (typeof title === "string" && title.length > 0) titles.set(id, title);
          else if (typeof fallback === "string" && fallback.length > 0) titles.set(id, fallback);
        }
        if (page.length < THREAD_PAGE) break;
        offset += THREAD_PAGE;
      }
    }
    return titles;
  }

  bb.onDispose(() => {
    disposed.abort();
  });

  bb.rpc.register(skillUsageRpcContract, {
    threadInvocations: async ({ threadId }) => {
      // Thread scope reads events directly rather than the index, so what the
      // panel shows for the thread you are in is never a refresh behind.
      const walked = await walkThread(threadId, 0, disposed.signal);
      return { invocations: walked.invocations };
    },

    waitThread: async ({ threadId, afterSeq }) => {
      // One wait per event type: `events.wait` takes a single type, and a
      // skill that has started but not finished must show as in flight.
      const waits = SKILL_EVENT_TYPES.map((type) =>
        bb.sdk.threads.events.wait({
          threadId,
          type,
          afterSeq: String(afterSeq),
          waitMs: String(WAIT_MS),
          signal: disposed.signal,
        }),
      );
      const first = await Promise.race(waits);
      return { changed: first !== null };
    },

    rollup: async ({ scope, threadId }) => {
      let projectId: string | null = null;
      if (scope === "project") {
        const thread = asRecord(await bb.sdk.threads.get({ threadId }));
        const id = thread["projectId"];
        if (typeof id !== "string" || id.length === 0) {
          throw new Error("Thread has no project.");
        }
        projectId = id;
      }
      const rows = loadRollup(db, projectId);
      const ids = new Set<string>();
      for (const row of rows) {
        for (const thread of row.threads) ids.add(thread.threadId);
      }
      const titles = await threadTitles(ids);
      return {
        skills: rows.map((row) => ({
          ...row,
          threads: row.threads.map((thread) => ({
            ...thread,
            title: titles.get(thread.threadId) ?? null,
          })),
        })),
      };
    },

    indexStatus: async () => ({ ...status }),

    indexRefresh: async ({ rebuild }) => {
      const wanted = shouldRefresh({
        running: pass !== null,
        lastRefreshAt: status.lastRefreshAt,
        nowMs: Date.now(),
        rebuild: rebuild === true,
      });
      if (wanted) {
        pass = runPass(rebuild === true);
      }
      return { ...status };
    },
  });
}
