// The watch module: two triggers, one engine.
//
// Trigger one is core's drain hook, so a thread is re-evaluated the moment new
// events land — no second `thread:changed` subscription, which would double
// the push stream and still race the drain. Trigger two is a `*/1` sweep over
// active threads, because the time-based rules (silence, active-no-turn) fire
// on the ABSENCE of events and nothing will ever wake them otherwise.
//
// Both call the same synchronous `evaluateThread`. That synchronicity is the
// concurrency argument: better-sqlite3 does not yield, so a drain-triggered
// evaluation and a sweep-triggered one cannot interleave on one thread. The
// only await in this file is the config refresh, which happens BEFORE the
// sweep rather than inside it.
import type { Database } from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defineModule, type ModuleContext, type ObservatoryModule } from "../module.js";
import { ObservatoryStore } from "../core/store.js";
import type { Ingest } from "../core/ingest.js";
import { createEngine, type WatchEngine } from "./engine.js";
import { createLadder, type Ladder } from "./ladder.js";
import { WatchQueries } from "./queries.js";
import { createTrajectory, type Trajectory } from "./trajectory.js";
import { readWatchConfig, type WatchConfig } from "./settings.js";

export type SettingsReader = () => Promise<
  Record<string, string | boolean | undefined>
>;

/** What the CLI, the RPC handlers and the agent tool read. Null until the
 * module's setup completes, which is exactly what those surfaces must report. */
export interface WatchRuntime {
  queries: WatchQueries;
  engine: WatchEngine;
  /** Exposed so the notification caps can be exercised without manufacturing
   * one rule episode per publish. */
  ladder: Ladder;
  trajectory: Trajectory;
  /** The config as of the last refresh. */
  config(): WatchConfig;
  /** Re-read settings and KV. The RPC settings writer calls this after a set. */
  refresh(): Promise<WatchConfig>;
}

export interface WatchHandle {
  current: WatchRuntime | null;
}

/** The config watch falls back to before its first refresh lands. */
function bootConfig(): WatchConfig {
  return {
    mode: "observe",
    enabled: {
      "silence-no-inflight": true,
      "repeated-identical-tool": true,
      "read-edit-read": true,
      "active-no-turn": true,
      "burn-no-change": true,
      "retry-storm": true,
      "tree-budget": true,
    },
    thresholds: {},
    source: {},
    quietHours: null,
  };
}

export interface WatchRuntimeOptions {
  bb: BbPluginApi;
  db: Database;
  settings: SettingsReader;
  now?: () => number;
}

/**
 * Build the runtime without any bb.background wiring, so tests drive the
 * engine directly and the module setup below stays a wiring function with
 * nothing to get wrong.
 */
export function createWatchRuntime(
  options: WatchRuntimeOptions,
): WatchRuntime {
  const now = options.now ?? Date.now;
  const store = new ObservatoryStore(options.db);
  const queries = new WatchQueries(options.db);
  let config = bootConfig();

  const ladder = createLadder({
    store,
    publish: (channel, payload) => options.bb.realtime.publish(channel, payload),
    config: () => ({ mode: config.mode, quietHours: config.quietHours }),
    now,
    log: options.bb.log,
  });

  const engine = createEngine({
    store,
    queries,
    ladder,
    config: () => config,
    now,
  });

  return {
    queries,
    engine,
    ladder,
    trajectory: createTrajectory({ db: options.db }),
    config: () => config,
    async refresh(): Promise<WatchConfig> {
      config = await readWatchConfig(options.bb, await options.settings());
      return config;
    },
  };
}

export interface WatchModuleOptions {
  handle: WatchHandle;
  /** Core's ingest, for the drain hook. Null when core is disabled. */
  ingest(): Ingest | null;
  settings: SettingsReader;
  now?: () => number;
}

export function createWatchModule(
  options: WatchModuleOptions,
): ObservatoryModule {
  return defineModule({
    id: "watch",
    async setup(ctx: ModuleContext) {
      const runtime = createWatchRuntime({
        bb: ctx.bb,
        db: ctx.db(),
        settings: options.settings,
        now: options.now,
      });
      await runtime.refresh();
      options.handle.current = runtime;

      const ingest = options.ingest();
      if (ingest) {
        // The listener is synchronous and wrapped by the module breaker, so a
        // rule that throws costs watch its breaker count and never the drain.
        const unsubscribe = ingest.onDrained((threadId, ingested) => {
          if (ingested === 0) return;
          try {
            runtime.engine.evaluateThread(threadId);
          } catch (error) {
            ctx.bb.log.error(
              `[watch] evaluate ${threadId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        });
        // Teardown: a reload that left this attached would evaluate against a
        // closed database handle on the next drain.
        ctx.bb.onDispose(unsubscribe);
      } else {
        ctx.bb.log.warn(
          "[watch] core ingest absent; only the minute sweep will evaluate",
        );
      }

      ctx.bb.background.schedule(
        "watch-sweep",
        "*/1 * * * *",
        ctx.job("watch-sweep", async () => {
          if (!(await ctx.enabled())) return;
          // Refresh first: the sweep is the one place a KV threshold change
          // becomes effective without anyone calling the settings RPC.
          await runtime.refresh();
          runtime.engine.sweep();
        }),
      );

      ctx.bb.log.info(`[watch] observing in mode ${runtime.config().mode}`);
    },
  });
}
