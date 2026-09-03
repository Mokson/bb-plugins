import { useCallback, useEffect, useReducer, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  DOSSIER_CHANNEL,
  rowSignalSchema,
  type RowSignal,
  type betterSidebarRpcContract,
} from "../server-contract";

/** §5: `rowSignals` is the 30s-TTL method. */
const SIGNALS_TTL_MS = 30_000;
const ERROR_TTL_MS = 2_000;
/** How often a stationary viewport re-checks its own signals for staleness. */
const REFRESH_INTERVAL_MS = SIGNALS_TTL_MS / 2;
/** The contract caps one request at 60 ids; a larger visible set chunks. */
const MAX_IDS_PER_REQUEST = 60;
/**
 * One scroll gesture flips many rows at once. Coalescing into a single task
 * turns that into one request rather than one per row.
 */
const BATCH_DELAY_MS = 50;

type Call = ReturnType<typeof useRpc<typeof betterSidebarRpcContract>>["call"];

interface CacheEntry {
  signal: RowSignal | null;
  expiresAt: number;
}

const visible = new Set<string>();
const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Set<string>();
const observedIds = new WeakMap<Element, string>();
/**
 * Round-2 H2: one epoch per id, bumped on every invalidation. A batch sent
 * before the bump settles after it; without the epoch that stale settle
 * overwrites the invalidation and the refetch it scheduled never happens (the
 * in-flight guard filters the id out of the next `runBatch`). Settles from an
 * older epoch store nothing and schedule their own refetch instead.
 */
const epochs = new Map<string, number>();
/**
 * Round-2 M2: the same FIFO cap-200 as useDossier's. The visible set bounds
 * the hot ids, but a long session scrolling hundreds of threads must not grow
 * this without bound; the oldest entry goes on insert past the cap.
 */
const MAX_SIGNAL_CACHE_ENTRIES = 200;

let callRef: { current: Call | null } = { current: null };
let observer: IntersectionObserver | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Test seam: module state outlives `cleanup()`, so tests must clear it. */
export function resetRowSignals(): void {
  visible.clear();
  cache.clear();
  listeners.clear();
  inFlight.clear();
  epochs.clear();
  callRef.current = null;
  observer?.disconnect();
  observer = null;
  if (batchTimer !== null) clearTimeout(batchTimer);
  batchTimer = null;
  stopRefresh();
}

/**
 * The visible set only changes on scroll and the invalidation channel only
 * fires on a turn boundary, so a list nobody touches had no path back to
 * `runBatch` at all: every glyph aged past the 30s TTL and never returned.
 * One interval for the whole list closes that, and it only runs while some
 * row is actually subscribed.
 */
function startRefresh(): void {
  if (refreshTimer !== null || typeof setInterval !== "function") return;
  // Half the TTL, so an entry that lapses is picked up within one tick of
  // going stale rather than up to a full window later. `runBatch` filters on
  // staleness, so the extra ticks cost one array scan and send nothing.
  refreshTimer = setInterval(runBatch, REFRESH_INTERVAL_MS);
}

function stopRefresh(): void {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
}

function notify(threadId: string): void {
  for (const listener of listeners.get(threadId) ?? []) listener();
}

function subscribe(threadId: string, listener: () => void): () => void {
  const set = listeners.get(threadId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(threadId, set);
  startRefresh();
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
    if (listeners.size === 0) stopRefresh();
  };
}

function isStale(threadId: string): boolean {
  const entry = cache.get(threadId);
  return entry === undefined || entry.expiresAt <= Date.now();
}

function scheduleBatch(): void {
  if (batchTimer !== null) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    runBatch();
  }, BATCH_DELAY_MS);
}

function store(threadId: string, signal: RowSignal | null, ttl: number): void {
  cache.set(threadId, { signal, expiresAt: Date.now() + ttl });
  while (cache.size > MAX_SIGNAL_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * §7's B37-B40 ruling: one request covering only the ids currently visible in
 * the viewport. A row that has never intersected contributes no id, so it
 * draws no glyph and costs nothing.
 */
function runBatch(): void {
  const send = callRef.current;
  if (send === null) return;
  const due = [...visible].filter((id) => !inFlight.has(id) && isStale(id));
  if (due.length === 0) return;

  for (let i = 0; i < due.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = due.slice(i, i + MAX_IDS_PER_REQUEST);
    for (const id of chunk) inFlight.add(id);
    // H2: the epoch each id was sent at. An invalidation that lands before the
    // settle bumps it, and the handlers below recognise their own staleness.
    const sentAt = new Map(chunk.map((id) => [id, epochs.get(id) ?? 0]));
    const isCurrent = (id: string): boolean =>
      (epochs.get(id) ?? 0) === (sentAt.get(id) ?? 0);
    // A superseded settle cleared nothing yet (the guard clears in `finish`
    // below), so the refetch it owes has to be scheduled — otherwise the id
    // sits stale until the refresh interval notices.
    const refetchSuperseded = (): void => {
      if (chunk.some((id) => !isCurrent(id) && visible.has(id))) {
        scheduleBatch();
      }
    };
    // Passed as both fulfilment and rejection handler, so the guard is
    // cleared and listeners repaint even when the mapping above throws.
    const finish = () => {
      for (const id of chunk) {
        inFlight.delete(id);
        notify(id);
      }
    };
    void send("rowSignals", { threadIds: chunk })
      .then(
        (result) => {
          // The wire payload is caller-shaped: a throw in the mapping
          // degrades the chunk, never its in-flight guard.
          try {
            // Round-2 M5: validate each element against the schema at the
            // unpack site. A corrupt-but-formed entry (tokensUsed: "1000")
            // degrades to null instead of reaching goalRingProgress as NaN.
            const raw = (result as { signals?: unknown }).signals;
            const list = Array.isArray(raw) ? raw : [];
            const byId = new Map<string, RowSignal>();
            for (const entry of list) {
              const parsed = rowSignalSchema.safeParse(entry);
              if (parsed.success) byId.set(parsed.data.threadId, parsed.data);
            }
            for (const id of chunk) {
              // H2: an invalidation that landed mid-flight wins — this settle
              // stores nothing for the id, and the refetch is scheduled below.
              if (!isCurrent(id)) continue;
              store(id, byId.get(id) ?? null, SIGNALS_TTL_MS);
            }
          } catch {
            for (const id of chunk) {
              if (!isCurrent(id)) continue;
              store(id, null, ERROR_TTL_MS);
            }
          }
          refetchSuperseded();
        },
        // A rejected batch draws no glyphs and retries after the short TTL —
        // row signals are decoration and never surface an error to the row.
        () => {
          for (const id of chunk) {
            if (!isCurrent(id)) continue;
            store(id, null, ERROR_TTL_MS);
          }
          refetchSuperseded();
        },
      )
      .then(finish, finish);
  }
}

function setVisible(threadId: string, isVisible: boolean): void {
  if (isVisible) visible.add(threadId);
  else visible.delete(threadId);
}

function ensureObserver(): IntersectionObserver | null {
  if (observer !== null) return observer;
  // This runs inside a React ref callback, so throwing here unmounts the tree
  // and blanks the whole sidebar — the very outcome `ListStates` exists to
  // prevent. Degrading to "no signals" costs four decorative glyphs; the rows,
  // their titles and B44's shortcut targets all survive.
  if (typeof IntersectionObserver === "undefined") return null;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const threadId = observedIds.get(entry.target);
      if (threadId !== undefined) setVisible(threadId, entry.isIntersecting);
    }
    scheduleBatch();
  });
  return observer;
}

/** The cached signal for one thread, without observing anything. */
export function useSignalValue(threadId: string): RowSignal | null {
  const [, rerender] = useReducer((v: number) => v + 1, 0);
  const rpc = useRpc<typeof betterSidebarRpcContract>();

  // Assigned during render, like useLastActivity's callRef: the module-level
  // holder always carries the latest mounted hook's call, never the one an
  // effect happened to install last. `runBatch` fires from timers, so it
  // cannot take a per-hook ref directly.
  callRef.current = rpc.call;

  useEffect(() => subscribe(threadId, rerender), [threadId]);

  useRealtime(DOSSIER_CHANNEL, (payload) => {
    const invalidated = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof invalidated !== "string") return;
    // H2: bump first, so a batch sent before this event recognises its own
    // settle as stale and stores nothing. The settle schedules the refetch
    // once the guard clears; the immediate schedule below covers the idle case.
    epochs.set(invalidated, (epochs.get(invalidated) ?? 0) + 1);
    cache.delete(invalidated);
    notify(invalidated);
    if (visible.has(invalidated)) scheduleBatch();
  });

  const entry = cache.get(threadId);
  return entry !== undefined && entry.expiresAt > Date.now() ? entry.signal : null;
}

/**
 * B37-B40. Attach `ref` to the row's signal cluster: the shared
 * `IntersectionObserver` adds the thread to the fetched set while it is on
 * screen and removes it when it scrolls away.
 */
export function useRowSignal(threadId: string): {
  ref: (node: Element | null) => void;
  signal: RowSignal | null;
} {
  const signal = useSignalValue(threadId);
  const attachedRef = useRef<Element | null>(null);

  const ref = useCallback(
    (node: Element | null) => {
      const previous = attachedRef.current;
      if (previous !== null) {
        ensureObserver()?.unobserve(previous);
        observedIds.delete(previous);
        setVisible(threadId, false);
      }
      attachedRef.current = node;
      if (node !== null) {
        observedIds.set(node, threadId);
        ensureObserver()?.observe(node);
      }
    },
    [threadId],
  );

  return { ref, signal };
}
