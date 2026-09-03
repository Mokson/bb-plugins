/**
 * The shared machinery behind the batched row lookups: one module-level cache
 * per RPC method, a TTL per entry, one in-flight guard per id, and a listener
 * set so a batch one caller issued repaints every caller that shares its ids.
 *
 * Two hooks own that shape — `useThreadExecutions` (B71) and `useLastActivity`
 * (B82) — and they differ only in the entry they store and the state they
 * derive from it, never in the fetching. The hook keeps its own semantics; the
 * cache keeps the parts that were identical.
 */
import type { z } from "zod";
export interface BatchCacheOptions<TValue, TResult, TMethod extends string> {
  /** The RPC method name, passed straight to `call`. */
  method: TMethod;
  /** How long a resolved entry is reusable. */
  readyTtlMs: number;
  /**
   * How long a rejected batch is cached. Shorter than `readyTtlMs`, so a
   * backend that is down costs one request per few seconds, not one per render.
   */
  errorTtlMs: number;
  /** The contract's per-request cap; a longer id list chunks. */
  maxIdsPerRequest: number;
  /** Pulls this batch's values out of the method's result, keyed by thread id. */
  unpack: (result: TResult) => ReadonlyMap<string, TValue>;
  /** The value stored for an id the backend omitted, and for a rejected batch. */
  missing: TValue;
}

export interface BatchCacheEntry<TValue> {
  value: TValue;
  /** True when the batch carrying this id rejected as a whole. */
  failed: boolean;
}

export interface BatchCache<TValue, TMethod extends string> {
  /** Requests every id that is neither fresh nor already in flight. */
  ensure(threadIds: readonly string[], call: BatchCall<TMethod>): void;
  /**
   * Expires one id so the next `ensure` refetches it, and repaints its
   * listeners. Round-2 M4: the dossier-channel hook for per-id TTL-bypass.
   * Expiry (not deletion) keeps the last known value on screen while the
   * refresh flies — the stale-while-revalidate contract of `get`.
   */
  invalidate(threadId: string): void;
  /**
   * The entry for one id, or undefined when it has never resolved.
   *
   * Stale-while-revalidate: an expired entry is still served. The TTL decides
   * when to REFETCH, never what to draw — dropping the value at expiry made
   * every row lose its model, effort and time label for the length of a round
   * trip, once per TTL, which is the list flickering on a timer.
   */
  get(threadId: string): BatchCacheEntry<TValue> | undefined;
  /** Repaint on any settled batch. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Test seam: the cache outlives `cleanup()`, so tests must clear it. */
  reset(): void;
}

/**
 * The RPC client's `call`, narrowed to this cache's method. `rpc.call` accepts
 * every method in the contract, so it satisfies a parameter typed to one.
 */
type BatchCall<TMethod extends string> = (
  method: TMethod,
  input: { threadIds: string[] },
) => Promise<unknown>;

/**
 * Round-2 M5: validates one wire element per batch entry at the unpack site.
 * A corrupt-but-formed element (tokensUsed: "1000") resolves to `missing`
 * under its claimed id — when the row carries no usable id it is dropped —
 * so one corrupt entry degrades alone instead of poisoning its batch.
 */
export function unpackValidated<TValue, TElement>(
  rows: unknown,
  schema: z.ZodType<TElement>,
  pick: (element: TElement) => { threadId: string; value: TValue },
  missing: TValue,
): ReadonlyMap<string, TValue> {
  const out = new Map<string, TValue>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) {
      const { threadId, value } = pick(parsed.data);
      out.set(threadId, value);
    } else if (
      typeof row === "object" &&
      row !== null &&
      typeof (row as { threadId?: unknown }).threadId === "string"
    ) {
      out.set((row as { threadId: string }).threadId, missing);
    }
  }
  return out;
}

export function createBatchCache<TValue, TResult, TMethod extends string>(
  options: BatchCacheOptions<TValue, TResult, TMethod>,
): BatchCache<TValue, TMethod> {
  const entries = new Map<string, BatchCacheEntry<TValue> & { expiresAt: number }>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  /**
   * Round-2 M2: the same FIFO cap-200 as useDossier's, so a long session
   * resolving hundreds of distinct ids cannot grow this without bound.
   */
  const MAX_BATCH_CACHE_ENTRIES = 200;
  /**
   * Ids invalidated while their batch is still in flight. The settle below
   * would otherwise store the pre-invalidation answer with a fresh TTL and the
   * event would be lost until that TTL lapses.
   */
  const invalidatedWhileInFlight = new Set<string>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const store = (threadId: string, value: TValue, failed: boolean): void => {
    entries.set(threadId, {
      value,
      failed,
      expiresAt: Date.now() + (failed ? options.errorTtlMs : options.readyTtlMs),
    });
    while (entries.size > MAX_BATCH_CACHE_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const settle = (chunk: readonly string[], values: ReadonlyMap<string, TValue> | null) => {
    for (const id of chunk) {
      // An id the backend omitted is still resolved: it has no value. A
      // REJECTED batch is different — it says nothing about the id, so the
      // last known value stands rather than blanking the row until the
      // shorter error TTL lets a retry through.
      const previous = values === null ? entries.get(id)?.value : undefined;
      store(id, previous ?? values?.get(id) ?? options.missing, values === null);
      inFlight.delete(id);
      // M4: an invalidation that landed mid-flight wins over this settle.
      // Expire what was just stored so the next `ensure` refetches; the
      // notify below repaints, and the hooks' unconditional effects refetch.
      if (invalidatedWhileInFlight.delete(id)) {
        const stored = entries.get(id);
        if (stored !== undefined) stored.expiresAt = 0;
      }
    }
    notify();
  };

  return {
    ensure(threadIds, call) {
      const due = threadIds.filter(
        (id) => !inFlight.has(id) && (entries.get(id)?.expiresAt ?? 0) <= Date.now(),
      );
      if (due.length === 0) return;

      for (let i = 0; i < due.length; i += options.maxIdsPerRequest) {
        const chunk = due.slice(i, i + options.maxIdsPerRequest);
        for (const id of chunk) inFlight.add(id);
        void call(options.method, { threadIds: chunk }).then(
          (result) => {
            // `unpack` is caller code over a wire payload: a throw there must
            // degrade the chunk, never leak its in-flight guard or reject
            // unobserved. `settle` always clears `inFlight` and notifies.
            try {
              settle(chunk, options.unpack(result as TResult));
            } catch {
              settle(chunk, null);
            }
          },
          // A rejection is a cached fact, not a thrown one: the rows keep
          // everything else they draw and lose only this lookup's part.
          () => settle(chunk, null),
        );
      }
    },
    get(threadId) {
      return entries.get(threadId);
    },
    invalidate(threadId) {
      if (inFlight.has(threadId)) invalidatedWhileInFlight.add(threadId);
      const entry = entries.get(threadId);
      // Nothing held and nothing flying: no repaint to trigger.
      if (entry === undefined && !inFlight.has(threadId)) return;
      if (entry !== undefined) entry.expiresAt = 0;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      entries.clear();
      inFlight.clear();
      listeners.clear();
      invalidatedWhileInFlight.clear();
    },
  };
}
