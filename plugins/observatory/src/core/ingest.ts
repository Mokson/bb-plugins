// The ingest loop: bb's push signal in, ledger rows out.
//
// bb has no "turn happened" plugin event. `bb.events.on` carries thread
// lifecycle only, and the per-turn rows live behind `threads.events.list`. So
// ingest is a dirty set: the realtime `thread:changed` signal (and the
// lifecycle events) mark a thread dirty, and a background service drains each
// dirty thread from its stored watermark to the tail.
//
// The signal is deliberately treated as a HINT. Everything is re-derivable
// from `(threadId, afterSeq)`, so a dropped signal costs latency until the
// reconcile pass, never a lost row, and a duplicated signal costs nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ObservatoryStore } from "./store.js";
import type { EventStore } from "./store-events.js";
import {
  emptyCarry,
  normalizeEvents,
  type NormalizeCarry,
} from "./events.js";
import { ThreadRegistry } from "./threads.js";
import {
  joinPendingTurns,
  type JoinSummary,
  type LogTurnSource,
  type PriceTurnFn,
} from "./join.js";

/** Events per `events.list` page. */
export const PAGE_LIMIT = 500;
/** SQL milliseconds spent per drain tick before yielding to the event loop. */
export const TICK_BUDGET_MS = 250;
/** Idle sleep between drains when the dirty set is empty. */
export const IDLE_POLL_MS = 1_000;
/** A thread not drained within this is re-queued by `reconcileStale`. */
export const STALE_AFTER_MS = 5 * 60 * 1_000;

/** Event types that mean "this thread has ledger-relevant new rows". */
const INGEST_EVENT_TYPES = new Set([
  "thread/identity",
  "thread/compacted",
  "thread/context/cleared",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "provider/error",
  "client/turn/requested",
]);

export interface IngestCounters {
  dirty: number;
  drains: number;
  events: number;
  lastDrainAt: string | null;
  lastReconcileAt: string | null;
  lastLogsPassAt: string | null;
  lastJoin: JoinSummary | null;
}

export interface IngestOptions {
  bb: BbPluginApi;
  store: ObservatoryStore;
  events: EventStore;
  /** Absent until the log indexer has run; the join simply finds nothing. */
  logs?: LogTurnSource | null;
  priceTurn?: PriceTurnFn | null;
  catalog?: unknown;
  registry?: ThreadRegistry;
  now?: () => number;
}

export interface Ingest {
  start(signal: AbortSignal): Promise<void>;
  markDirty(threadId: string): void;
  drainOnce(): Promise<number>;
  drainThread(threadId: string): Promise<number>;
  reconcileStale(): Promise<number>;
  rejoinPending(): JoinSummary | null;
  counters(): IngestCounters;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export function createIngest(options: IngestOptions): Ingest {
  const { bb, store, events } = options;
  const now = options.now ?? Date.now;
  const registry =
    options.registry ?? new ThreadRegistry({ threads: bb.sdk.threads, log: bb.log });
  const dirty = new Set<string>();
  const carries = new Map<string, NormalizeCarry>();
  const counters: IngestCounters = {
    dirty: 0,
    drains: 0,
    events: 0,
    lastDrainAt: null,
    lastReconcileAt: null,
    lastLogsPassAt: null,
    lastJoin: null,
  };

  function markDirty(threadId: string): void {
    if (threadId) dirty.add(threadId);
  }

  /**
   * Drain one thread from its watermark to the tail.
   *
   * The watermark is stored, not remembered, so a reload resumes where the
   * last drain stopped and re-running a drain over the same page rewrites the
   * same rows by primary key.
   */
  async function drainThread(threadId: string): Promise<number> {
    const resolved = await registry.resolve(threadId);
    // Read the watermark BEFORE the registry upsert and carry it through
    // every write: `upsertThread` writes the full column list, so a row
    // rebuilt from the registry alone would null `last_event_seq` and make
    // the next drain replay the whole thread.
    const watermark = events.watermark(threadId);
    const row = {
      ...resolved.row,
      last_event_seq: watermark,
      last_seen_at: new Date(now()).toISOString(),
    };
    // The registry row must land first: turns denormalize `root_thread_id`,
    // and the join needs `provider_thread_id` on the thread.
    store.upsertThread(row);
    const rootThreadId = resolved.row.root_thread_id ?? threadId;

    let carry = carries.get(threadId) ?? emptyCarry();
    let afterSeq = watermark;
    let ingested = 0;
    const deadline = now() + TICK_BUDGET_MS;

    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        limit: String(PAGE_LIMIT),
        ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
      });
      if (page.length === 0) break;

      const result = normalizeEvents({
        threadId,
        events: page,
        carry,
        rootThreadId,
      });
      const write = store.db.transaction(() => {
        if (result.thread.provider_thread_id) {
          store.upsertThread({
            ...row,
            thread_id: threadId,
            last_event_seq: afterSeq,
            provider_thread_id: result.thread.provider_thread_id,
          });
        }
        for (const turn of result.turns) store.upsertTurn(turn);
        for (const item of result.items) store.upsertItem(item);
        if (result.lastSeq !== null) {
          events.setWatermark(
            threadId,
            result.lastSeq,
            new Date(now()).toISOString(),
          );
        }
      });
      write();

      carry = result.carry;
      ingested += page.length;
      counters.events += page.length;
      if (result.lastSeq === null) break;
      afterSeq = result.lastSeq;
      // A partial drain is fine: the thread stays dirty and the next tick
      // resumes from the watermark just written.
      if (page.length < PAGE_LIMIT) break;
      if (now() >= deadline) {
        dirty.add(threadId);
        break;
      }
    }

    carries.set(threadId, carry);
    counters.drains += 1;
    counters.lastDrainAt = new Date(now()).toISOString();
    return ingested;
  }

  async function drainOnce(): Promise<number> {
    const batch = [...dirty];
    dirty.clear();
    let ingested = 0;
    for (const threadId of batch) {
      try {
        ingested += await drainThread(threadId);
      } catch (error) {
        // One unreadable thread must not strand the rest of the batch; it is
        // re-queued and the reconcile pass will try it again.
        dirty.add(threadId);
        bb.log.warn(
          `[core] drain ${threadId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    counters.dirty = dirty.size;
    return ingested;
  }

  /** Re-queue threads no signal has touched lately. The safety net. */
  async function reconcileStale(): Promise<number> {
    const before = new Date(now() - STALE_AFTER_MS).toISOString();
    const stale = events.listStaleThreads(before);
    for (const row of stale) markDirty(row.thread_id);
    counters.dirty = dirty.size;
    counters.lastReconcileAt = new Date(now()).toISOString();
    return stale.length;
  }

  /** Re-run the log join over every turn still without a proven split. */
  function rejoinPending(): JoinSummary | null {
    counters.lastLogsPassAt = new Date(now()).toISOString();
    if (!options.logs || !options.priceTurn) return null;
    const summary = joinPendingTurns({
      store,
      events,
      logs: options.logs,
      priceTurn: options.priceTurn,
      catalog: options.catalog,
    });
    counters.lastJoin = summary;
    return summary;
  }

  async function start(signal: AbortSignal): Promise<void> {
    // `thread:changed` names the event types it carries, so a thread whose
    // only change was, say, a pin toggle never costs a drain.
    const unsubscribe = bb.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        const threadId = event.id;
        if (typeof threadId !== "string" || threadId === "") return;
        const types = event.metadata?.eventTypes;
        if (Array.isArray(types)) {
          if (!types.some((type) => INGEST_EVENT_TYPES.has(type))) return;
        } else if (!event.changes.includes("events-appended")) {
          return;
        }
        markDirty(threadId);
      },
    });

    // Lifecycle seeds the registry: a thread that was created and archived
    // between two drains still gets its row.
    for (const name of [
      "thread.created",
      "thread.active",
      "thread.idle",
      "thread.failed",
      "thread.archived",
    ] as const) {
      bb.events.on(name, ({ thread }) => {
        registry.invalidate(thread.id);
        markDirty(thread.id);
      });
    }

    signal.addEventListener("abort", () => unsubscribe(), { once: true });
    await reconcileStale();
    while (!signal.aborted) {
      const ingested = await drainOnce();
      if (ingested === 0) await sleep(IDLE_POLL_MS, signal);
    }
    unsubscribe();
  }

  return {
    start,
    markDirty,
    drainOnce,
    drainThread,
    reconcileStale,
    rejoinPending,
    counters: () => ({ ...counters, dirty: dirty.size }),
  };
}
