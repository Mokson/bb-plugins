// One manual steer, over `fetch`.
//
// The Stalls page uses `useWatchSteer`, which goes through `useRpc`. The
// command palette cannot: its `run` callback is not a component, so no hook is
// available to it. This is the same endpoint by the same shape the thread-row
// content script already talks to, kept in its own file so the palette
// registration in `app.tsx` stays a registration.
import type { SteerResult } from "../../../watch/contract.js";

const RPC_BASE = "/api/v1/plugins/observatory/rpc";

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
}

/**
 * Steer one thread. Returns the server's own confirmation line, or null when
 * the call did not reach a verdict — the caller has no surface to render an
 * error into, and inventing one here would put a second wording of "watch mode
 * is observe" in the codebase.
 */
export async function steerThread(
  threadId: string,
  action: "steer" | "escalate" = "steer",
): Promise<string | null> {
  try {
    const response = await fetch(`${RPC_BASE}/observatory_watch_${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    if (!response.ok) return null;
    const envelope = (await response.json()) as RpcEnvelope<SteerResult>;
    return envelope.ok ? (envelope.result?.message ?? null) : null;
  } catch {
    // A failed fetch is a disconnected panel, not a steer that half happened:
    // the ladder records before it sends, so nothing was written either.
    return null;
  }
}
