import { useEffect, useReducer, useRef } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  DOSSIER_CHANNEL,
  type Dossier,
  type betterSidebarRpcContract,
} from "../server-contract";

/** B28: a resolved dossier is reusable for this long. */
const READY_TTL_MS = 10_000;
/**
 * A rejection is cached far more briefly, so a backend that is down costs one
 * request per 2s rather than one per hover per row.
 */
const ERROR_TTL_MS = 2_000;

export interface DossierState {
  status: "idle" | "loading" | "ready" | "error";
  /** Populated only when `status === "ready"`. */
  data: Dossier | null;
  /** Populated only when `status === "error"`. */
  error: string | null;
  retry: () => void;
}

type Settled =
  | { status: "ready"; data: Dossier }
  | { status: "error"; error: string };

interface Entry {
  expiresAt: number;
  promise: Promise<void>;
  result: Settled | null;
}

type Call = ReturnType<typeof useRpc<typeof betterSidebarRpcContract>>["call"];

/**
 * Module-level so a second hover of the same row inside the TTL renders from
 * the map during the first paint, with no request at all (B27). Capped, so a
 * long session hovering hundreds of distinct threads cannot grow it without
 * bound; the oldest entry goes on insert past the cap.
 */
const cache = new Map<string, Entry>();
const MAX_DOSSIER_CACHE_ENTRIES = 200;

/** Test seam: the caches outlive a `cleanup()`, so tests must clear them. */
export function resetDossierCache(): void {
  cache.clear();
}

function isFresh(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && entry.expiresAt > Date.now();
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Could not load thread details.";
}

/**
 * One in-flight request per thread, retried exactly once. A persistent failure
 * therefore costs two rpc calls per TTL window, never one per re-render.
 */
function ensure(threadId: string, call: Call): Promise<void> {
  const existing = cache.get(threadId);
  if (isFresh(existing)) return existing.promise;

  const entry: Entry = {
    // In-flight counts as fresh, so concurrent hovers share this one request.
    expiresAt: Date.now() + READY_TTL_MS,
    promise: Promise.resolve(),
    result: null,
  };
  entry.promise = call("threadDossier", { threadId })
    .catch(() => call("threadDossier", { threadId }))
    .then(
      (data) => {
        entry.result = { status: "ready", data };
        entry.expiresAt = Date.now() + READY_TTL_MS;
      },
      (error: unknown) => {
        entry.result = { status: "error", error: messageOf(error) };
        entry.expiresAt = Date.now() + ERROR_TTL_MS;
      },
    );
  cache.delete(threadId);
  cache.set(threadId, entry);
  // FIFO, deliberately not LRU: hover order is effectively random, entries
  // live and die by their TTLs, and a re-hover re-inserts at the young end —
  // recency tracking would buy nothing. The delete-before-set above is what
  // keeps a re-hovered id young AND the size honest: without it a re-insert
  // kept its old (oldest) position, so the cap below could evict the entry
  // just stored and let the map escape past it.
  while (cache.size > MAX_DOSSIER_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return entry.promise;
}

/**
 * B26-B28. `enabled` is the hover-intent gate: while it is false no request is
 * ever issued, which is what keeps a 50-thread mount at zero dossier calls.
 */
export function useDossier(threadId: string, enabled: boolean): DossierState {
  const rpc = useRpc<typeof betterSidebarRpcContract>();
  const callRef = useRef(rpc.call);
  callRef.current = rpc.call;

  const [version, bumpVersion] = useReducer((v: number) => v + 1, 0);
  const [, rerender] = useReducer((v: number) => v + 1, 0);

  useRealtime(DOSSIER_CHANNEL, (payload) => {
    const invalidated = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof invalidated !== "string") return;
    cache.delete(invalidated);
    if (invalidated === threadId) bumpVersion();
  });

  // The last value this hook actually served, so an entry that ages out while
  // the popover is still open keeps rendering rather than reverting to a
  // skeleton it can never leave. Cleared when the thread or the version
  // changes, because neither value describes the new request.
  const servedRef = useRef<{ threadId: string; version: number; settled: Settled } | null>(
    null,
  );

  // Deliberately unconditional: a settled-and-fresh entry returns early, so
  // this costs one map lookup per render. Gating it on `[enabled, threadId,
  // version]` is what made expiry unrecoverable — the TTL runs on the clock,
  // not on the deps, so nothing ever re-triggered the fetch while the popover
  // stayed open. `useNow`'s minute tick alone was enough to strand it.
  useEffect(() => {
    if (!enabled) return;
    const current = cache.get(threadId);
    if (isFresh(current) && current.result !== null) return;
    let cancelled = false;
    // `ensure` never rejects — every rejection is folded into the entry.
    void ensure(threadId, callRef.current).then(() => {
      if (!cancelled) rerender();
    });
    return () => {
      cancelled = true;
    };
  });

  const retry = () => {
    cache.delete(threadId);
    servedRef.current = null;
    bumpVersion();
  };

  if (!enabled) return { status: "idle", data: null, error: null, retry };

  const entry = cache.get(threadId);
  const fresh = isFresh(entry) ? entry.result : null;
  const served = servedRef.current;
  const settled =
    fresh ??
    (served !== null && served.threadId === threadId && served.version === version
      ? served.settled
      : null);
  if (settled === null) {
    return { status: "loading", data: null, error: null, retry };
  }
  if (fresh !== null) servedRef.current = { threadId, version, settled: fresh };
  return settled.status === "ready"
    ? { status: "ready", data: settled.data, error: null, retry }
    : { status: "error", data: null, error: settled.error, retry };
}
