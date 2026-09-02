// The eight watch RPC handlers.
//
// A handler is a thin adapter over the views: it resolves the runtime, or
// fails loudly if watch is not running, and never computes anything the CLI
// would then have to recompute differently. The two manual write handlers
// (steer, escalate) share `runManualSteer` with the CLI for that reason: one
// record-before-send path, two front doors.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  watchContract,
  type SteerResult,
  type WatchSettingsView,
  type WatchMode,
} from "./contract.js";
import type { SteerVerdict } from "./ladder.js";
import { MODE_KV_KEY, THRESHOLDS_KV_KEY } from "./settings.js";
import type { WatchHandle, WatchRuntime } from "./module.js";
import { buildExplain, buildInbox, buildWatchList, toThreadSignalView } from "./views.js";

/**
 * The note shown beside a live `steer` mode.
 *
 * Phase 2's note said steering was not implemented. It now is, so the note
 * carries what a person actually needs before trusting it: two rules measured
 * at zero percent precision are still observe-only, and the evidence for that
 * is a file they can open.
 */
export const STEER_NOTE =
  "steering is live; repeated-identical-tool and burn-no-change stay observe-only until re-measured (evidence/watch-steer/PRECISION.md)";

/** The one line a manual steer or escalation reports back. */
export function steerMessage(
  verdict: SteerVerdict,
  threadId: string,
  targetThreadId: string,
): string {
  switch (verdict) {
    case "steered":
      return `steered ${threadId}`;
    case "escalated":
      return `escalated ${threadId} to ${targetThreadId}`;
    case "queued":
      return `queued a message on ${threadId}`;
    case "mode-off":
      return "watch mode is off; set it to steer first";
    case "observe-only":
      // Only the automatic ladder reaches this verdict now; a manual steer is
      // allowed from observe, so the line must not tell a person to flip the
      // mode they deliberately chose.
      return "watch mode is observe, so the ladder did not send";
    case "unknown-thread":
      return `no ledger row for ${threadId}; it may not be indexed yet`;
    case "inactive-thread":
      return `${threadId} is not running, so there is nothing to steer`;
    case "reserved-thread":
      return `${threadId} is hidden or owned by another module; watch does not steer it`;
    case "quiet-hours":
      return "inside quiet hours";
    case "capped-thread":
      return "this thread has had its hourly steers already";
    case "capped-overall":
      return "the hourly steer budget across all threads is spent";
    case "cooldown":
      return "already steered for this rule inside the last ten minutes";
    case "rule-not-steerable":
      return "this rule is observe-only until its precision is re-measured";
    case "closed-signal":
      return "the signal had already closed";
    case "send-failed":
      return "the send failed; see the action row";
  }
}

const SENT: ReadonlySet<SteerVerdict> = new Set<SteerVerdict>([
  "steered",
  "escalated",
  "queued",
]);

/**
 * The shared body of the two manual RPC handlers and their CLI twins, so the
 * panel button and `bb observatory watch steer` cannot record differently.
 */
export async function runManualSteer(
  runtime: WatchRuntime,
  action: "steer" | "escalate",
  threadId: string,
  note: string | undefined,
  actor: string,
  now: () => number = Date.now,
): Promise<SteerResult> {
  const verdict = await (action === "escalate"
    ? runtime.ladder.escalate(threadId, { note, actor })
    : runtime.ladder.steer(threadId, { note, actor }));
  const context = runtime.queries.steerContext(threadId, now());
  const target =
    action === "escalate"
      ? (context?.parentThreadId ?? context?.rootThreadId ?? threadId)
      : threadId;
  return {
    threadId,
    targetThreadId: SENT.has(verdict) ? target : null,
    verdict,
    sent: SENT.has(verdict),
    message: steerMessage(verdict, threadId, target),
  };
}

export function settingsView(runtime: WatchRuntime): WatchSettingsView {
  const config = runtime.config();
  return {
    mode: config.mode,
    thresholds: config.thresholds,
    source: config.source,
    note: config.mode === "steer" ? STEER_NOTE : null,
  };
}

export function createWatchRpcHandlers(
  bb: BbPluginApi,
  handle: WatchHandle,
  now: () => number = Date.now,
): PluginRpcHandlers<typeof watchContract> {
  function runtime(): WatchRuntime {
    const current = handle.current;
    if (!current) throw new Error("watch module is not running");
    return current;
  }

  return {
    "observatory_watch_list": () => buildWatchList(runtime().queries, now()),
    "observatory_watch_explain": ({ threadId }) =>
      buildExplain(runtime().queries, threadId),
    "observatory_watch_signals": (input) => ({
      rows: runtime()
        .queries.signals(input)
        .map(toThreadSignalView),
    }),
    "observatory_watch_settings_get": () => settingsView(runtime()),
    "observatory_watch_settings_set": async (input) => {
      const current = runtime();
      if (input.mode) {
        await bb.storage.kv.set(MODE_KV_KEY, input.mode satisfies WatchMode);
      }
      if (input.thresholds || input.reset?.length) {
        // Merge, not replace: the panel edits one field at a time, and a
        // replace would silently drop every other override in the same key.
        const next = {
          ...((await bb.storage.kv.get<Record<string, number>>(
            THRESHOLDS_KV_KEY,
          )) ?? {}),
          ...input.thresholds,
        };
        // A reset deletes the override rather than writing the setting's
        // current value: the row has to keep following the setting afterwards,
        // not freeze at whatever it happens to say today.
        for (const key of input.reset ?? []) delete next[key];
        await bb.storage.kv.set(THRESHOLDS_KV_KEY, next);
      }
      await current.refresh();
      return settingsView(current);
    },
    "observatory_inbox": ({ limit }) =>
      buildInbox(runtime().queries, limit ?? 50),
    "observatory_watch_steer": ({ threadId, note }) =>
      runManualSteer(runtime(), "steer", threadId, note, "panel", now),
    "observatory_watch_escalate": ({ threadId, note }) =>
      runManualSteer(runtime(), "escalate", threadId, note, "panel", now),
  };
}
