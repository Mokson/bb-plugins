import { useEffect, useReducer, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { betterSidebarRpcContract } from "../server-contract";

/**
 * B82. A row's label has minute resolution (`useNow` quantizes to the minute),
 * so re-reading a thread's newest event more often than that buys nothing.
 */
const READY_TTL_MS = 30_000;
/** A rejected batch retries sooner, so a backend blip costs one label, briefly. */
const ERROR_TTL_MS = 5_000;
/** The contract caps one request at 60 ids; a longer list chunks. */
const MAX_IDS_PER_REQUEST = 60;

type Call = ReturnType<typeof useRpc<typeof betterSidebarRpcContract>>["call"];

interface Entry {
  expiresAt: number;
  /** null is both "this thread has no events" and "this id's lookup failed". */
  at: number | null;
}

/** Module-level, as `useThreadExecutions`'s is: every row reads one map. */
const cache = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

/** Test seam: the cache outlives `cleanup()`, so tests must clear it. */
export function resetLastActivityCache(): void {
  cache.clear();
  inFlight.clear();
  listeners.clear();
}

function isFresh(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && entry.expiresAt > Date.now();
}

function store(threadId: string, at: number | null, failed: boolean): void {
  cache.set(threadId, {
    at,
    expiresAt: Date.now() + (failed ? ERROR_TTL_MS : READY_TTL_MS),
  });
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function ensure(threadIds: readonly string[], call: Call): void {
  const due = threadIds.filter((id) => !inFlight.has(id) && !isFresh(cache.get(id)));
  if (due.length === 0) return;

  for (let i = 0; i < due.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = due.slice(i, i + MAX_IDS_PER_REQUEST);
    for (const id of chunk) inFlight.add(id);
    void call("lastActivity", { threadIds: chunk }).then(
      (result) => {
        const returned = new Map(result.activity.map((row) => [row.threadId, row.at]));
        for (const id of chunk) store(id, returned.get(id) ?? null, false);
        for (const id of chunk) inFlight.delete(id);
        notify();
      },
      // A rejection is a cached fact, not a thrown one: every row keeps its
      // `thread.updatedAt` label rather than losing its time column.
      () => {
        for (const id of chunk) store(id, null, true);
        for (const id of chunk) inFlight.delete(id);
        notify();
      },
    );
  }
}

/**
 * B82. When each of these threads last did anything, in one batched round trip.
 *
 * The list owns this call, not the row: one request for every rendered id beats
 * one request per row, and the answer is a `Map` the rows read from. A missing
 * key means "not resolved yet", so a row falls back to `thread.updatedAt` and
 * never renders an empty time column.
 */
export function useLastActivity(
  threadIds: readonly string[],
): ReadonlyMap<string, number> {
  const rpc = useRpc<typeof betterSidebarRpcContract>();
  const callRef = useRef(rpc.call);
  callRef.current = rpc.call;

  const [, rerender] = useReducer((v: number) => v + 1, 0);

  useEffect(() => {
    const listener = () => rerender();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Unconditional, as the sibling hooks' are: the TTL runs on the clock, not
  // on the deps, so an expiry has to be noticed by a later render.
  useEffect(() => {
    ensure(threadIds, callRef.current);
  });

  const resolved = new Map<string, number>();
  for (const id of threadIds) {
    const entry = cache.get(id);
    if (isFresh(entry) && entry.at !== null) resolved.set(id, entry.at);
  }
  return resolved;
}
