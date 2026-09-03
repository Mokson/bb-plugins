import { useEffect, useReducer, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { createBatchCache, unpackValidated } from "../lib/batch-cache";
import {
  DOSSIER_CHANNEL,
  threadExecutionSchema,
  type ThreadExecution,
  type betterSidebarRpcContract,
} from "../server-contract";

type Execution = ThreadExecution["execution"];

const cache = createBatchCache<
  Execution,
  { executions: ThreadExecution[] },
  "threadExecutions"
>({
  method: "threadExecutions",
  /** B71.4: a resolved execution is reusable for this long, as the dossier is. */
  readyTtlMs: 10_000,
  errorTtlMs: 2_000,
  /** The contract caps one request at 60 ids; a larger set of children chunks. */
  maxIdsPerRequest: 60,
  // Round-2 M5: a corrupt-but-formed element degrades to null (the row drops
  // its metadata line) instead of rejecting the batch.
  unpack: (result) =>
    unpackValidated(
      (result as { executions?: unknown }).executions,
      threadExecutionSchema,
      (entry) => ({ threadId: entry.threadId, value: entry.execution }),
      null,
    ),
  // null is both "this thread never ran" and "this id's lookup failed"; B71.3
  // keeps the rows' titles and glyphs either way and drops the metadata line.
  missing: null,
});

export const resetThreadExecutionsCache = cache.reset;

export interface ThreadExecutionsState {
  status: "idle" | "loading" | "ready" | "error";
  /** Keyed by thread id. A missing key means "not resolved", never "no model". */
  executions: ReadonlyMap<string, Execution>;
}

/**
 * B71.2-B71.4. Model and effort for a set of thread ids, fetched in one batch
 * and only while `enabled`.
 *
 * `enabled` is the popover's OPEN state, not hover intent. Closed is nearly
 * every chip nearly all of the time, and closed issues no call at all. The
 * CACHE is module-level so re-opening inside the TTL paints with no request;
 * the OPEN state is not (B58.9), so split panes open independently.
 */
export function useThreadExecutions(
  threadIds: readonly string[],
  enabled: boolean,
): ThreadExecutionsState {
  const rpc = useRpc<typeof betterSidebarRpcContract>();
  const callRef = useRef(rpc.call);
  callRef.current = rpc.call;

  const [, rerender] = useReducer((v: number) => v + 1, 0);

  // A batch another chip issued settles here too, so a pane that requested
  // nothing still repaints when the ids it shares become available.
  useEffect(() => (enabled ? cache.subscribe(rerender) : undefined), [enabled]);

  // Round-2 M4: per-id TTL-bypass on the dossier channel, mirroring
  // useDossier/useRowSignals. `ensure` below stays the only fetcher: the
  // invalidation expires the id, the notify repaints, and the unconditional
  // effect refetches it while every other id keeps its cached value.
  useRealtime(DOSSIER_CHANNEL, (payload) => {
    const invalidated = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof invalidated !== "string") return;
    cache.invalidate(invalidated);
  });

  // Deliberately unconditional, as `useDossier`'s is: the TTL runs on the
  // clock, not on the deps. `ensure` returns after one filter pass when every
  // id is already fresh, so an extra render costs a map lookup per id.
  useEffect(() => {
    if (!enabled) return;
    cache.ensure(threadIds, callRef.current);
  });

  if (!enabled) return { status: "idle", executions: new Map() };

  const executions = new Map<string, Execution>();
  let pending = false;
  let failed = false;
  for (const id of threadIds) {
    const entry = cache.get(id);
    if (entry === undefined) {
      pending = true;
      continue;
    }
    if (entry.failed) failed = true;
    else executions.set(id, entry.value);
  }

  // Loading wins over error while anything is still outstanding, so a partly
  // failed set does not settle early and then move again.
  if (pending) return { status: "loading", executions };
  if (failed) return { status: "error", executions };
  return { status: "ready", executions };
}
