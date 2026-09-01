// The module wrapper: one plugin, seven modules, one blast radius each.
//
// A module never touches `bb` directly for the three things that can take the
// plugin down — running work, deciding whether it is on, and reaching the
// database. It gets them from this context, so a module that throws costs its
// own breaker and nothing else. Core is exempt from tripping: it is the only
// writer of the ledger every other module reads, and a disabled core would
// silently starve them rather than fail loudly.
import type { Database } from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const CORE_MODULE_ID = "core";

/** Consecutive failures that trip a module's breaker. */
export const BREAKER_LIMIT = 5;

export type ModuleId =
  | "core"
  | "spend"
  | "watch"
  | "context"
  | "audit"
  | "eval"
  | "distillery";

/**
 * The setting that turns a module on. Underscores, not dots: bb refuses a
 * setting key that is not letters, digits, "-" or "_".
 */
export function moduleEnabledSettingKey(id: string): string {
  return `modules_${id}_enabled`;
}

/**
 * The kv override key. Same name as the setting: kv is already namespaced per
 * plugin, so a second prefix would only make the two harder to line up. The
 * override outranks the setting because settings need a plugin reload and the
 * panel must be able to stop a misbehaving module now.
 */
export function moduleEnabledKvKey(id: string): string {
  return moduleEnabledSettingKey(id);
}

export interface BreakerState {
  /** Consecutive failures since the last success. */
  failures: number;
  tripped: boolean;
  lastError: string | null;
}

export interface ModuleContext {
  readonly bb: BbPluginApi;
  readonly id: string;
  /** The plugin database, already migrated by the host factory. */
  db(): Database;
  /**
   * Wrap one unit of module work. The returned function never throws: a
   * failure is logged with the module tag, counted, and swallowed, so a
   * module's cron or service cannot abort the plugin.
   */
  job<T>(name: string, fn: () => T | Promise<T>): () => Promise<T | undefined>;
  /** The kv override when set, else the setting, else false. */
  enabled(): Promise<boolean>;
  breaker(): BreakerState;
}

export interface ObservatoryModule {
  readonly id: ModuleId;
  setup(ctx: ModuleContext): void | Promise<void>;
}

export function defineModule(module: ObservatoryModule): ObservatoryModule {
  return module;
}

export interface ModuleRegistryOptions {
  bb: BbPluginApi;
  db(): Database;
  /** Effective setting values, re-read per call so a reload is not needed. */
  settings(): Promise<Record<string, string | boolean | undefined>>;
}

/**
 * Owns every module's breaker and hands each module its context. One registry
 * per plugin load; disposal is the host's (the contexts hold no timers).
 */
export class ModuleRegistry {
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly options: ModuleRegistryOptions) {}

  breaker(id: string): BreakerState {
    let state = this.breakers.get(id);
    if (!state) {
      state = { failures: 0, tripped: false, lastError: null };
      this.breakers.set(id, state);
    }
    return state;
  }

  /** Every module seen so far, in registration order. */
  breakerStates(): Array<BreakerState & { id: string }> {
    return [...this.breakers].map(([id, state]) => ({ id, ...state }));
  }

  context(id: string): ModuleContext {
    const { bb, db, settings } = this.options;
    const breaker = this.breaker(id);
    const isCore = id === CORE_MODULE_ID;
    return {
      bb,
      id,
      db,
      breaker: () => ({ ...breaker }),
      job<T>(name: string, fn: () => T | Promise<T>) {
        return async (): Promise<T | undefined> => {
          try {
            const result = await fn();
            // A success clears the count, so five failures must be
            // CONSECUTIVE to trip; an intermittent job never trips.
            breaker.failures = 0;
            breaker.lastError = null;
            return result;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            breaker.failures += 1;
            breaker.lastError = message;
            bb.log.error(`[${id}] ${name} failed: ${message}`);
            if (
              !isCore &&
              !breaker.tripped &&
              breaker.failures >= BREAKER_LIMIT
            ) {
              breaker.tripped = true;
              bb.status.needsConfiguration(
                `observatory: module ${id} disabled after ${BREAKER_LIMIT} failures: ${message}`,
              );
            }
            return undefined;
          }
        };
      },
      async enabled(): Promise<boolean> {
        if (breaker.tripped) return false;
        const override = await bb.storage.kv.get<boolean>(
          moduleEnabledKvKey(id),
        );
        if (typeof override === "boolean") return override;
        const value = (await settings())[moduleEnabledSettingKey(id)];
        return value === true;
      },
    };
  }

  async register(modules: readonly ObservatoryModule[]): Promise<void> {
    for (const module of modules) {
      const ctx = this.context(module.id);
      // Setup itself runs through the breaker: a module that throws while
      // registering must not stop the modules after it.
      await ctx.job("setup", () => module.setup(ctx))();
    }
  }
}
