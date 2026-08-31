import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { betterSidebarRpcContract } from "../server-contract";

type Call = ReturnType<typeof useRpc<typeof betterSidebarRpcContract>>["call"];

/**
 * The id of the machine bb runs on, or null until it is known.
 *
 * Module-level and fetched once per page load: the answer is a property of
 * this bb install, not of any thread, so a per-row or per-render request would
 * be pure waste. A failure resolves to null, and a null hides no label.
 */
let hostId: string | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Test seam: the cache is module state and outlives `cleanup()`. */
export function resetLocalHostId(): void {
  hostId = null;
  inFlight = null;
  listeners.clear();
}

function load(call: Call): void {
  if (hostId !== null || inFlight !== null) return;
  inFlight = call("localHost", {})
    .then((result) => {
      hostId = result.hostId;
    })
    .catch(() => {
      // A machine name drawn on every row is the correct degradation.
    })
    .finally(() => {
      inFlight = null;
      for (const listener of listeners) listener();
    });
}

/**
 * `enabled` is B61: the list asks only when a row could actually draw a host
 * name. Disabled, the hook issues no request and returns whatever a previous
 * enabled render already learned.
 */
export function useLocalHostId(enabled: boolean): string | null {
  const { call } = useRpc<typeof betterSidebarRpcContract>();
  const [value, setValue] = useState(hostId);

  useEffect(() => {
    if (!enabled) return;
    const listener = () => setValue(hostId);
    listeners.add(listener);
    load(call);
    return () => {
      listeners.delete(listener);
    };
  }, [call, enabled]);

  return value;
}
