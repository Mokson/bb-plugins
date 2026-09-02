// The distillery module: one daily scan, no automatic drafting.
//
// Scanning is free and idempotent, so it runs on a schedule. Drafting SPENDS,
// so it never runs on a timer: a batch is spawned only when a person asks, by
// `bb observatory distill draft` or the panel. That asymmetry is deliberate —
// an unattended loop that both mines and pays is how a $10 monthly budget
// becomes a surprise, and the queue is worth nothing if nobody reads it.
import type { Database } from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  defineModule,
  type ModuleContext,
  type ObservatoryModule,
} from "../module.js";
import { DistilleryRuntime, type DistilleryHandle } from "./queue.js";
import { readDistilleryConfig, type DistilleryConfig } from "./settings.js";

export type SettingsReader = () => Promise<
  Record<string, string | boolean | undefined>
>;

export interface DistilleryRuntimeFactoryOptions {
  bb: BbPluginApi;
  db: Database;
  settings: SettingsReader;
  now?: () => Date;
}

/**
 * Build the runtime with no scheduling attached, so tests drive scan, cluster
 * and apply directly and the module setup below stays pure wiring.
 */
export function createDistilleryRuntime(
  options: DistilleryRuntimeFactoryOptions,
): { runtime: DistilleryRuntime; refresh(): Promise<DistilleryConfig> } {
  let config = readDistilleryConfig({});
  const runtime = new DistilleryRuntime({
    bb: options.bb,
    db: options.db,
    config: () => config,
    now: options.now,
  });
  return {
    runtime,
    async refresh(): Promise<DistilleryConfig> {
      config = readDistilleryConfig(await options.settings());
      return config;
    },
  };
}

export interface DistilleryModuleOptions {
  handle: DistilleryHandle;
  settings: SettingsReader;
  now?: () => Date;
}

export function createDistilleryModule(
  options: DistilleryModuleOptions,
): ObservatoryModule {
  return defineModule({
    id: "distillery",
    async setup(ctx: ModuleContext) {
      const { runtime, refresh } = createDistilleryRuntime({
        bb: ctx.bb,
        db: ctx.db(),
        settings: options.settings,
        now: options.now,
      });
      await refresh();
      options.handle.current = runtime;

      // Daily, not per-drain: the sources are files a run writes at its END
      // (the ledger flush, the retro, the review artifact), so re-mining them
      // on every event drain would be the same scan hundreds of times over
      // artifacts that had not changed.
      ctx.bb.background.schedule(
        "distillery-scan",
        "17 4 * * *",
        ctx.job("distillery-scan", async () => {
          if (!(await ctx.enabled())) return;
          await refresh();
          const counts = runtime.scan();
          ctx.bb.log.info(
            `[distillery] scanned ${counts.scanned}, stored ${counts.inserted}, ` +
              `${counts.qualifying} of ${counts.clusters} clusters qualify`,
          );
        }),
      );

      // Teardown: the handle outlives this setup only through the registry, so
      // a reload that left it pointing at a runtime over a closed database
      // would fail every CLI call until the process restarted.
      ctx.bb.onDispose(() => {
        options.handle.current = null;
      });

      ctx.bb.log.info("[distillery] correction mining registered");
    },
  });
}
