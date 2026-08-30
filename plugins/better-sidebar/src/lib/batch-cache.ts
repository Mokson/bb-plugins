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
  /** The entry for one id, or undefined when it is unresolved or expired. */
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

export function createBatchCache<TValue, TResult, TMethod extends string>(
  options: BatchCacheOptions<TValue, TResult, TMethod>,
): BatchCache<TValue, TMethod> {
  const entries = new Map<string, BatchCacheEntry<TValue> & { expiresAt: number }>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();

  const store = (threadId: string, value: TValue, failed: boolean): void => {
    entries.set(threadId, {
      value,
      failed,
      expiresAt: Date.now() + (failed ? options.errorTtlMs : options.readyTtlMs),
    });
  };

  const settle = (chunk: readonly string[], values: ReadonlyMap<string, TValue> | null) => {
    for (const id of chunk) {
      // An id the backend omitted is still resolved: it has no value.
      store(id, values?.get(id) ?? options.missing, values === null);
      inFlight.delete(id);
    }
    for (const listener of [...listeners]) listener();
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
          (result) => settle(chunk, options.unpack(result as TResult)),
          // A rejection is a cached fact, not a thrown one: the rows keep
          // everything else they draw and lose only this lookup's part.
          () => settle(chunk, null),
        );
      }
    },
    get(threadId) {
      const entry = entries.get(threadId);
      return entry !== undefined && entry.expiresAt > Date.now() ? entry : undefined;
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
    },
  };
}
