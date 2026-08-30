import { useCallback, useEffect, useReducer, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  DOSSIER_CHANNEL,
  type RowSignal,
  type betterSidebarRpcContract,
} from "../server-contract";

/** §5: `rowSignals` is the 30s-TTL method. */
const SIGNALS_TTL_MS = 30_000;
const ERROR_TTL_MS = 2_000;
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

let call: Call | null = null;
let observer: IntersectionObserver | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** Test seam: module state outlives `cleanup()`, so tests must clear it. */
export function resetRowSignals(): void {
  visible.clear();
  cache.clear();
  listeners.clear();
  inFlight.clear();
  call = null;
  observer?.disconnect();
  observer = null;
  if (batchTimer !== null) clearTimeout(batchTimer);
  batchTimer = null;
}

function notify(threadId: string): void {
  for (const listener of listeners.get(threadId) ?? []) listener();
}

function subscribe(threadId: string, listener: () => void): () => void {
  const set = listeners.get(threadId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(threadId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
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
}

/**
 * §7's B37-B40 ruling: one request covering only the ids currently visible in
 * the viewport. A row that has never intersected contributes no id, so it
 * draws no glyph and costs nothing.
 */
function runBatch(): void {
  const send = call;
  if (send === null) return;
  const due = [...visible].filter((id) => !inFlight.has(id) && isStale(id));
  if (due.length === 0) return;

  for (let i = 0; i < due.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = due.slice(i, i + MAX_IDS_PER_REQUEST);
    for (const id of chunk) inFlight.add(id);
    void send("rowSignals", { threadIds: chunk })
      .then(
        ({ signals }) => {
          const byId = new Map(signals.map((s) => [s.threadId, s]));
          for (const id of chunk) store(id, byId.get(id) ?? null, SIGNALS_TTL_MS);
        },
        // A rejected batch draws no glyphs and retries after the short TTL —
        // row signals are decoration and never surface an error to the row.
        () => {
          for (const id of chunk) store(id, null, ERROR_TTL_MS);
        },
      )
      .then(() => {
        for (const id of chunk) {
          inFlight.delete(id);
          notify(id);
        }
      });
  }
}

function setVisible(threadId: string, isVisible: boolean): void {
  if (isVisible) visible.add(threadId);
  else visible.delete(threadId);
}

function ensureObserver(): IntersectionObserver {
  if (observer !== null) return observer;
  if (typeof IntersectionObserver === "undefined") {
    // Loud rather than silent: without it every row would report invisible and
    // the four signals would quietly never render. jsdom needs a mock.
    throw new Error(
      "better-sidebar: IntersectionObserver is unavailable; row signals cannot be bounded to the viewport.",
    );
  }
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

  useEffect(() => {
    call = rpc.call;
  }, [rpc]);

  useEffect(() => subscribe(threadId, rerender), [threadId]);

  useRealtime(DOSSIER_CHANNEL, (payload) => {
    const invalidated = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof invalidated !== "string") return;
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
        ensureObserver().unobserve(previous);
        observedIds.delete(previous);
        setVisible(threadId, false);
      }
      attachedRef.current = node;
      if (node !== null) {
        observedIds.set(node, threadId);
        ensureObserver().observe(node);
      }
    },
    [threadId],
  );

  return { ref, signal };
}
