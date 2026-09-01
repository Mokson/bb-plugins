// The six watch RPC handlers.
//
// A handler is a thin adapter over the views: it resolves the runtime, or
// fails loudly if watch is not running, and never computes anything the CLI
// would then have to recompute differently.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  watchContract,
  type WatchSettingsView,
  type WatchMode,
} from "./contract.js";
import { MODE_KV_KEY, THRESHOLDS_KV_KEY } from "./settings.js";
import type { WatchHandle, WatchRuntime } from "./module.js";
import { buildExplain, buildInbox, buildWatchList, toThreadSignalView } from "./views.js";

/** Phase 2 stores `steer` but behaves as `observe`; the note says so out loud
 * rather than letting a person believe steering is live. */
export const STEER_NOTE =
  "mode stored as steer; this build observes only — the ladder lands in phase 3";

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
      if (input.thresholds) {
        // Merge, not replace: the panel edits one field at a time, and a
        // replace would silently drop every other override in the same key.
        const existing =
          (await bb.storage.kv.get<Record<string, number>>(
            THRESHOLDS_KV_KEY,
          )) ?? {};
        await bb.storage.kv.set(THRESHOLDS_KV_KEY, {
          ...existing,
          ...input.thresholds,
        });
      }
      await current.refresh();
      return settingsView(current);
    },
    "observatory_inbox": ({ limit }) =>
      buildInbox(runtime().queries, limit ?? 50),
  };
}
