import { useEffect, useReducer, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ThreadExecution, betterSidebarRpcContract } from "../server-contract";

/** B71.4: a resolved execution is reusable for this long, as the dossier is. */
const READY_TTL_MS = 10_000;
/**
 * A rejected batch is cached far more briefly, so a backend that is down costs
 * one request per 2s rather than one per re-open.
 */
const ERROR_TTL_MS = 2_000;
/** The contract caps one request at 60 ids; a larger set of children chunks. */
const MAX_IDS_PER_REQUEST = 60;

type Call = ReturnType<typeof useRpc<typeof betterSidebarRpcContract>>["call"];
type Execution = ThreadExecution["execution"];

interface Entry {
  expiresAt: number;
  /** null is both "this thread never ran" and "this id's lookup failed". */
  execution: Execution;
  /** True when the batch carrying this id rejected as a whole. */
  failed: boolean;
}

export interface ThreadExecutionsState {
  status: "idle" | "loading" | "ready" | "error";
  /** Keyed by thread id. A missing key means "not resolved", never "no model". */
  executions: ReadonlyMap<string, Execution>;
}

/**
 * Module-level, so re-opening the popover inside the TTL renders from the map
 * during the first paint with no request at all (B71.4).
 *
 * The CACHE is module-level; the popover's OPEN state is not (B58.9). A split
 * layout mounts one chip per pane, and they must open independently while
 * still sharing one set of resolved executions.
 */
const cache = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

/** Test seam: the cache outlives `cleanup()`, so tests must clear it. */
export function resetThreadExecutionsCache(): void {
  cache.clear();
  inFlight.clear();
  listeners.clear();
}

function isFresh(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && entry.expiresAt > Date.now();
}

function store(threadId: string, execution: Execution, failed: boolean): void {
  cache.set(threadId, {
    execution,
    failed,
    expiresAt: Date.now() + (failed ? ERROR_TTL_MS : READY_TTL_MS),
  });
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * B71.1. One request for every id this open still needs, and none for the ids
 * a concurrent chip already has in flight.
 */
function ensure(threadIds: readonly string[], call: Call): void {
  const due = threadIds.filter(
    (id) => !inFlight.has(id) && !isFresh(cache.get(id)),
  );
  if (due.length === 0) return;

  for (let i = 0; i < due.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = due.slice(i, i + MAX_IDS_PER_REQUEST);
    for (const id of chunk) inFlight.add(id);
    void call("threadExecutions", { threadIds: chunk }).then(
      (result) => {
        const returned = new Map(
          result.executions.map((entry) => [entry.threadId, entry.execution]),
        );
        // An id the backend omitted is still resolved: it has no execution.
        for (const id of chunk) store(id, returned.get(id) ?? null, false);
        for (const id of chunk) inFlight.delete(id);
        notify();
      },
      // B71.3: a rejection is a cached fact, not a thrown one. The rows keep
      // their titles and glyphs and simply lose the metadata line.
      () => {
        for (const id of chunk) store(id, null, true);
        for (const id of chunk) inFlight.delete(id);
        notify();
      },
    );
  }
}

/**
 * B71.2-B71.4. Model and effort for a set of thread ids, fetched in one batch
 * and only while `enabled`.
 *
 * `enabled` is the popover's OPEN state, not hover intent. Closed is nearly
 * every chip nearly all of the time, and closed issues no call at all.
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
  useEffect(() => {
    if (!enabled) return;
    const listener = () => rerender();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);

  // Deliberately unconditional, as `useDossier`'s is: the TTL runs on the
  // clock, not on the deps. `ensure` returns after one filter pass when every
  // id is already fresh, so an extra render costs a map lookup per id.
  useEffect(() => {
    if (!enabled) return;
    ensure(threadIds, callRef.current);
  });

  if (!enabled) return { status: "idle", executions: new Map() };

  const executions = new Map<string, Execution>();
  let pending = false;
  let failed = false;
  for (const id of threadIds) {
    const entry = cache.get(id);
    if (!isFresh(entry)) {
      pending = true;
      continue;
    }
    if (entry.failed) failed = true;
    else executions.set(id, entry.execution);
  }

  // Loading wins over error while anything is still outstanding, so a partly
  // failed set does not settle early and then move again.
  if (pending) return { status: "loading", executions };
  if (failed) return { status: "error", executions };
  return { status: "ready", executions };
}
