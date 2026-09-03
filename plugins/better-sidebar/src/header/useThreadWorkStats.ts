import { useEffect, useReducer, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { createBatchCache, unpackValidated } from "../lib/batch-cache";
import {
  threadWorkStatSchema,
  type ThreadWorkStat,
  type betterSidebarRpcContract,
} from "../server-contract";

/**
 * B85. Tokens and tool calls per child, the same batched shape
 * `useThreadExecutions` uses: module-level cache, one round trip per open,
 * fetched only while the popover is open (and off at density compact, the
 * B72.1 gate the chip applies to both calls).
 */
export interface WorkStat {
  tokens: number | null;
  toolCalls: number | null;
}

const cache = createBatchCache<
  WorkStat | null,
  { stats: ThreadWorkStat[] },
  "threadWorkStats"
>({
  method: "threadWorkStats",
  // Same reuse window as an execution: the popover re-opening inside it
  // paints with no request.
  readyTtlMs: 10_000,
  errorTtlMs: 2_000,
  maxIdsPerRequest: 60,
  // Round-2 M5: a corrupt-but-formed element degrades to null (the labels are
  // skipped) instead of rejecting the batch.
  unpack: (result) =>
    unpackValidated(
      (result as { stats?: unknown }).stats,
      threadWorkStatSchema,
      (entry) => ({
        threadId: entry.threadId,
        value: { tokens: entry.tokens, toolCalls: entry.toolCalls },
      }),
      null,
    ),
  // A failed lookup draws no labels; it never blanks the row.
  missing: null,
});

export const resetThreadWorkStatsCache = cache.reset;

export interface ThreadWorkStatsState {
  status: "idle" | "loading" | "ready" | "error";
  /** Keyed by thread id. A missing key means "not resolved". */
  stats: ReadonlyMap<string, WorkStat>;
}

export function useThreadWorkStats(
  threadIds: readonly string[],
  enabled: boolean,
): ThreadWorkStatsState {
  const rpc = useRpc<typeof betterSidebarRpcContract>();
  const callRef = useRef(rpc.call);
  callRef.current = rpc.call;

  const [, rerender] = useReducer((v: number) => v + 1, 0);

  useEffect(() => (enabled ? cache.subscribe(rerender) : undefined), [enabled]);

  useEffect(() => {
    if (!enabled) return;
    cache.ensure(threadIds, callRef.current);
  });

  if (!enabled) return { status: "idle", stats: new Map() };

  const stats = new Map<string, WorkStat>();
  let pending = false;
  let failed = false;
  for (const id of threadIds) {
    const entry = cache.get(id);
    if (entry === undefined) {
      pending = true;
      continue;
    }
    if (entry.failed) failed = true;
    else if (entry.value !== null) stats.set(id, entry.value);
  }

  if (pending) return { status: "loading", stats };
  if (failed) return { status: "error", stats };
  return { status: "ready", stats };
}
