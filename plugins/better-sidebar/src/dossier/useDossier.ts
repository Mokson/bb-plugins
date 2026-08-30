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
 * the map during the first paint, with no request at all (B27).
 */
const cache = new Map<string, Entry>();

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
  cache.set(threadId, entry);
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

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // `ensure` never rejects — every rejection is folded into the entry.
    void ensure(threadId, callRef.current).then(() => {
      if (!cancelled) rerender();
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, threadId, version]);

  const retry = () => {
    cache.delete(threadId);
    bumpVersion();
  };

  if (!enabled) return { status: "idle", data: null, error: null, retry };

  const entry = cache.get(threadId);
  const settled = isFresh(entry) ? entry.result : null;
  if (settled === null) {
    return { status: "loading", data: null, error: null, retry };
  }
  return settled.status === "ready"
    ? { status: "ready", data: settled.data, error: null, retry }
    : { status: "error", data: null, error: settled.error, retry };
}
