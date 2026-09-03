import { useEffect, useReducer, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { createBatchCache, unpackValidated } from "../lib/batch-cache";
import {
  DOSSIER_CHANNEL,
  threadLastActivitySchema,
  type ThreadLastActivity,
  type betterSidebarRpcContract,
} from "../server-contract";

const cache = createBatchCache<number | null, { activity: ThreadLastActivity[] }, "lastActivity">({
  method: "lastActivity",
  /**
   * B82. A row's label has minute resolution (`useNow` quantizes to the
   * minute), so re-reading a thread's newest event more often buys nothing.
   */
  readyTtlMs: 30_000,
  errorTtlMs: 5_000,
  maxIdsPerRequest: 60,
  // Round-2 M5: a corrupt-but-formed element degrades to null (the row falls
  // back to `thread.updatedAt`) instead of rejecting the batch.
  unpack: (result) =>
    unpackValidated(
      (result as { activity?: unknown }).activity,
      threadLastActivitySchema,
      (row) => ({ threadId: row.threadId, value: row.at }),
      null,
    ),
  // null is both "this thread has no events" and "this id's lookup failed";
  // the row falls back to `thread.updatedAt` for either.
  missing: null,
});

export const resetLastActivityCache = cache.reset;

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
  useEffect(() => cache.subscribe(rerender), []);

  // Round-2 M4: per-id TTL-bypass on the dossier channel, mirroring
  // useDossier/useRowSignals. Without this a thread that finishes a turn kept
  // its stale time label for the rest of the 30s TTL.
  useRealtime(DOSSIER_CHANNEL, (payload) => {
    const invalidated = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof invalidated !== "string") return;
    cache.invalidate(invalidated);
  });

  // Unconditional, as the sibling hooks' are: the TTL runs on the clock, not
  // on the deps, so an expiry has to be noticed by a later render.
  useEffect(() => {
    cache.ensure(threadIds, callRef.current);
  });

  const resolved = new Map<string, number>();
  for (const id of threadIds) {
    const at = cache.get(id)?.value;
    if (at !== undefined && at !== null) resolved.set(id, at);
  }
  return resolved;
}
