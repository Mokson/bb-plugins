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
/**
 * Threads whose normalize carry stays resident. The durable copy in `obs_meta`
 * is authoritative, so this is purely a read cache and evicting is free.
 */
export const CARRY_CACHE_LIMIT = 256;

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
  // A rejected request never becomes a turn, but it clears the pending model
  // in the carry, so the drain has to see it.
  "client/turn/rejected",
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
  /**
   * Called after a thread's turns are committed, so a read-only analyzer runs
   * on fresh rows instead of polling. Core stays the only writer of the
   * ledger: a hook writes its own module's signals and nothing else. A throw
   * is logged and swallowed, because an analyzer must never be able to stall
   * the drain loop every other module is fed by.
   */
  onThreadCommitted?: (threadId: string) => void;
}

/** Notified after a thread's drain lands, with the rows that batch wrote. */
export type DrainListener = (threadId: string, ingested: number) => void;

export interface Ingest {
  start(signal: AbortSignal): Promise<void>;
  markDirty(threadId: string): void;
  drainOnce(): Promise<number>;
  drainThread(threadId: string): Promise<number>;
  /**
   * Watch the drain instead of opening a second `thread:changed` subscription.
   *
   * The analyzer modules need to know a thread just moved, and the only reason
   * this hook exists is that the alternative — one subscription per module —
   * multiplies the push stream by the module count and still races the drain
   * it is trying to observe. A listener runs after the batch is committed, so
   * it reads a settled ledger, and a throwing listener is logged and
   * swallowed: an analyzer must not be able to stall ingest. Returns the
   * unsubscribe.
   */
  onDrained(listener: DrainListener): () => void;
  /** Forget how far these threads were drained; the next drain re-reads all. */
  reset(threadIds: readonly string[]): void;
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
  // `bb.sdk` is bind-gated: touching it during `createCoreModule` setup, which
  // runs before `listen`, throws. The registry is therefore built on the first
  // drain rather than in the factory.
  let registryInstance = options.registry ?? null;
  function registry(): ThreadRegistry {
    registryInstance ??= new ThreadRegistry({
      threads: bb.sdk.threads,
      log: bb.log,
    });
    return registryInstance;
  }
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

  const drainListeners = new Set<DrainListener>();

  function markDirty(threadId: string): void {
    if (threadId) dirty.add(threadId);
  }

  function onDrained(listener: DrainListener): () => void {
    drainListeners.add(listener);
    return () => {
      drainListeners.delete(listener);
    };
  }

  function notifyDrained(threadId: string, ingested: number): void {
    for (const listener of drainListeners) {
      try {
        listener(threadId, ingested);
      } catch (error) {
        bb.log.warn(
          `[core] drain listener failed for ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * The carry is as durable as the watermark it pairs with.
   *
   * The watermark says "events up to seq N are folded in"; the carry says what
   * that fold left half-finished — the running token baseline and the open
   * turn. Keeping the watermark on disk and the carry in memory meant a plugin
   * reload replayed neither, and the first `thread/tokenUsage/updated` after
   * the reload was read as a delta against nothing, so a whole thread's
   * running total was billed to one turn. They are written in one transaction
   * for the same reason.
   */
  function carryKey(threadId: string): string {
    return `carry:${threadId}`;
  }

  function loadCarry(threadId: string): NormalizeCarry {
    const cached = carries.get(threadId);
    if (cached) return cached;
    const raw = store.getMeta(carryKey(threadId));
    if (!raw) return emptyCarry();
    try {
      // A carry is a cache of derivable state, so a shape that no longer
      // parses is a re-derive, never a crash.
      return { ...emptyCarry(), ...(JSON.parse(raw) as NormalizeCarry) };
    } catch {
      return emptyCarry();
    }
  }

  /** Keep the newest threads' carries resident; the rest reload from disk. */
  function rememberCarry(threadId: string, carry: NormalizeCarry): void {
    carries.delete(threadId);
    carries.set(threadId, carry);
    while (carries.size > CARRY_CACHE_LIMIT) {
      const oldest = carries.keys().next();
      if (oldest.done) break;
      carries.delete(oldest.value);
    }
  }

  /**
   * Drain one thread from its watermark to the tail.
   *
   * The watermark is stored, not remembered, so a reload resumes where the
   * last drain stopped and re-running a drain over the same page rewrites the
   * same rows by primary key.
   */
  async function drainThread(threadId: string): Promise<number> {
    const resolved = await registry().resolve(threadId);
    const watermark = events.watermark(threadId);
    // The registry row must land first: turns denormalize `root_thread_id`,
    // and the join needs `provider_thread_id` on the thread. The upsert is a
    // PATCH, so the columns the registry cannot know — `last_event_seq`, and
    // `provider_thread_id`, which only the event stream carries — keep the
    // values earlier drains proved instead of being nulled on every tick.
    store.upsertThread({
      ...resolved.row,
      last_seen_at: new Date(now()).toISOString(),
    });
    const rootThreadId = resolved.row.root_thread_id ?? threadId;

    let carry = loadCarry(threadId);
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
            thread_id: threadId,
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
        // Same transaction as the watermark: a carry that outran its
        // watermark would double count on the next drain, and one that lagged
        // would drop a turn's tokens.
        store.setMeta(carryKey(threadId), JSON.stringify(result.carry));
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

    // An empty drain means the durable carry is already current, so the
    // resident copy is redundant and an idle thread stops holding memory.
    if (ingested === 0) carries.delete(threadId);
    else rememberCarry(threadId, carry);
    counters.drains += 1;
    counters.lastDrainAt = new Date(now()).toISOString();
    if (ingested > 0 && options.onThreadCommitted) {
      try {
        options.onThreadCommitted(threadId);
      } catch (error) {
        bb.log.warn(
          `[core] commit hook for ${threadId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    notifyDrained(threadId, ingested);
    return ingested;
  }

  /**
   * Rewind these threads to the start of their event history.
   *
   * The watermark and the carry are one fact in two places — "folded up to
   * seq N, with this much left open" — so they are cleared together, in one
   * transaction, or a drain would resume with a carry that describes events it
   * is about to read again. Nothing here reads or writes a provider log: the
   * rows this drops are all re-derivable from bb's own event stream.
   */
  function reset(threadIds: readonly string[]): void {
    // Prepared per call rather than at construction: this is the rare admin
    // path, and the drain loop should not carry statements it never runs.
    const clearWatermark = store.db.prepare(
      "UPDATE obs_thread SET last_event_seq = NULL WHERE thread_id = ?",
    );
    const clearCarry = store.db.prepare("DELETE FROM obs_meta WHERE key = ?");
    store.db.transaction(() => {
      for (const threadId of threadIds) {
        clearWatermark.run(threadId);
        clearCarry.run(carryKey(threadId));
        carries.delete(threadId);
        dirty.add(threadId);
      }
    })();
    counters.dirty = dirty.size;
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

  /**
   * Re-run the log join over every turn still without a proven split.
   *
   * DRAINED, not one page. The pending queue is capped per call and ordered
   * oldest first, so a single pass over a ledger with more than that many
   * unjoined turns left the NEWEST ones - the ones anyone is actually looking
   * at - permanently unattributed. A backfill of 802 turns matched 73% on one
   * pass and 97% once drained.
   *
   * Turns that stay `unavailable` are re-read on every pass and never clear,
   * so the loop stops on a pass that proved nothing new rather than on an
   * empty queue. `considered` accumulates work done across passes and so
   * counts a re-read turn once per pass; the split counters do not.
   */
  function rejoinPending(): JoinSummary | null {
    counters.lastLogsPassAt = new Date(now()).toISOString();
    if (!options.logs || !options.priceTurn) return null;
    const deps = {
      store,
      events,
      logs: options.logs,
      priceTurn: options.priceTurn,
      catalog: options.catalog,
    };
    const total = joinPendingTurns(deps);
    let proved = total.logExact + total.logWindow + total.sidechain;
    while (proved > 0) {
      const pass = joinPendingTurns(deps);
      proved = pass.logExact + pass.logWindow + pass.sidechain;
      total.considered += pass.considered;
      total.logExact += pass.logExact;
      total.logWindow += pass.logWindow;
      total.sidechain += pass.sidechain;
      total.unavailable = pass.unavailable;
      total.rows += pass.rows;
      total.unattributedBefore += pass.unattributedBefore;
      total.unattributedAfter += pass.unattributedAfter;
    }
    counters.lastJoin = total;
    return total;
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
        registry().invalidate(thread.id);
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
    onDrained,
    drainOnce,
    drainThread,
    reset,
    reconcileStale,
    rejoinPending,
    counters: () => ({ ...counters, dirty: dirty.size }),
  };
}
