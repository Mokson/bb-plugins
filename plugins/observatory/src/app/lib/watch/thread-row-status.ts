// The sidebar thread-row status for open watch signals.
//
// This runs as a content script, not a React component, because
// `experimental_setThreadRowStatus` is only reachable from the content-script
// context. That has one consequence worth stating plainly: `useRealtime` is a
// hook and there is no non-hook realtime API in the SDK, so this surface
// cannot subscribe to `observatory/signal`. It hydrates once from
// `observatory_watch_signals({open:true})` and then re-reads on a short
// interval. The observable behaviour is the same as following realtime, up to
// one poll of latency; the deviation is here rather than hidden.
//
// It talks to the rpc endpoint with `fetch`, the same way the absorbed sidebar
// strip does, since `useRpc` is likewise a hook.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import type { WatchSignalRow } from "../../../watch/contract.js";

const RPC_URL = "/api/v1/plugins/observatory/rpc/observatory_watch_signals";
const POLL_MS = 15_000;

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
}

/**
 * Which label an open signal earns on the thread row.
 *
 * Two words, because the row has space for two and the reader only needs to
 * know which of the two kinds of trouble this is. Budget breaches read "over
 * budget"; every other rule is a stall of some flavour.
 */
export function statusLabelForKind(kind: string): "stalled" | "over budget" {
  return /budget/i.test(kind) ? "over budget" : "stalled";
}

/**
 * One label per thread, highest-priority first.
 *
 * "over budget" wins a tie: a thread that is both stalled and over budget is
 * costing money either way, and the budget is the one with a hard number
 * attached.
 */
export function labelsByThread(
  rows: readonly WatchSignalRow[],
): Map<string, "stalled" | "over budget"> {
  const labels = new Map<string, "stalled" | "over budget">();
  for (const row of rows) {
    if (row.closedAt !== null) continue;
    // A signal can be recorded without a thread (a tree-wide budget breach is
    // the live case). There is no row to decorate, so it is skipped rather
    // than collapsed onto a placeholder id.
    const threadId = row.threadId;
    if (threadId === null) continue;
    const label = statusLabelForKind(row.kind);
    if (label === "over budget" || !labels.has(threadId)) {
      labels.set(threadId, label);
    }
  }
  return labels;
}

async function readOpenSignals(
  signal: AbortSignal,
): Promise<WatchSignalRow[] | null> {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open: true }),
      signal,
    });
    if (!response.ok) return null;
    const envelope = (await response.json()) as RpcEnvelope<{
      rows: WatchSignalRow[];
    }>;
    if (!envelope.ok || envelope.result === undefined) return null;
    return envelope.result.rows;
  } catch {
    // Aborted, offline, or the watch module is not registered yet. Either way
    // the right move is to leave the last known statuses alone and retry.
    return null;
  }
}

/**
 * Keep the thread rows decorated for as long as this frontend generation
 * lives. Returns a disposer that clears every status this script set.
 */
export function mountThreadRowStatus(
  context: PluginContentScriptContext,
): () => void {
  const setStatus = context.experimental_setThreadRowStatus;
  // Feature detection, as the SDK asks: on a client without the experimental
  // surface this script is a no-op rather than a crash.
  if (setStatus === undefined) return () => {};

  const decorated = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearAll = () => {
    for (const threadId of decorated) setStatus(threadId, null);
    decorated.clear();
  };

  const refresh = async () => {
    const rows = await readOpenSignals(context.signal);
    if (rows === null || context.signal.aborted) return;
    const wanted = labelsByThread(rows);

    for (const threadId of decorated) {
      if (!wanted.has(threadId)) setStatus(threadId, null);
    }
    for (const [threadId, label] of wanted) {
      setStatus(threadId, {
        icon: label === "over budget" ? "CircleDollarSign" : "Clock",
        label,
      });
    }
    decorated.clear();
    for (const threadId of wanted.keys()) decorated.add(threadId);
  };

  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);

  const onAbort = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  context.signal.addEventListener("abort", onAbort, { once: true });

  return () => {
    context.signal.removeEventListener("abort", onAbort);
    if (timer !== null) clearInterval(timer);
    timer = null;
    clearAll();
  };
}
