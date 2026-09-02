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
import {
  createLadder,
  ruleOfDetail,
  type Ladder,
  type ThreadContext,
} from "./ladder.js";
import { WatchQueries } from "./queries.js";
import { createTrajectory, type Trajectory } from "./trajectory.js";
import { buildPremiseReminder, readLedger } from "./premise.js";
import { readWatchConfig, type WatchConfig } from "./settings.js";
import { RULE_IDS, type RuleId } from "./contract.js";

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
  /**
   * Send the post-compaction premise reminder if this thread has compacted
   * since the last one. Returns what it did, for the test and the log.
   *
   * Driven from the drain rather than from a `thread/compacted` subscription:
   * core already writes `obs_turn.compacted`, and a second subscription would
   * double the push stream for one bit of information watch can read.
   */
  remindPremise(threadId: string): Promise<PremiseOutcome>;
}

/** Why the premise reminder did or did not send. */
export type PremiseOutcome =
  | "sent"
  | "disabled"
  | "no-compaction"
  | "already-reminded"
  | "no-run-folder"
  | "no-ledger"
  | "nothing-to-say"
  | "refused";

export interface WatchHandle {
  current: WatchRuntime | null;
}

/**
 * The config watch falls back to before its first refresh lands. Every rule on,
 * derived from `RULE_IDS` rather than restated: a rule added to the union must
 * not need a second edit here to be evaluated.
 */
function bootConfig(): WatchConfig {
  return {
    mode: "observe",
    enabled: Object.fromEntries(
      RULE_IDS.map((rule) => [rule, true]),
    ) as Record<RuleId, boolean>,
    thresholds: {},
    source: {},
    quietHours: null,
    premiseReminder: false,
  };
}

/** Meta key holding the last compaction this thread was reminded about. */
export function premiseWatermarkKey(threadId: string): string {
  return `watch:premise:${threadId}`;
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

  /** The ladder's view of a thread, resolved from the ledger watch already has. */
  function threadContext(threadId: string): ThreadContext | null {
    const fact = queries.steerContext(threadId, now());
    if (!fact) return null;
    return {
      threadId: fact.threadId,
      title: fact.title,
      status: fact.status,
      visibility: fact.visibility,
      origin: fact.origin,
      parentThreadId: fact.parentThreadId,
      rootThreadId: fact.rootThreadId,
      silentMs: fact.silentMs,
    };
  }

  const ladder = createLadder({
    store,
    publish: (channel, payload) => options.bb.realtime.publish(channel, payload),
    config: () => ({ mode: config.mode, quietHours: config.quietHours }),
    now,
    log: options.bb.log,
    thread: threadContext,
    steeredRules: (threadId, since) =>
      queries.steerHistory(threadId, since).map((row) => ruleOfDetail(row.detail)),
    steerCounts: (threadId, since) => queries.steerCounts(threadId, since),
    // The single place in this plugin that touches a running thread. `mode`
    // and `input` are the SDK's `sendMessageRequestSchema` shape; the text is
    // a plain text input because a steer carries no attachments.
    send: (args) =>
      options.bb.sdk.threads.send({
        threadId: args.threadId,
        mode: args.mode,
        input: [{ type: "text", text: args.text, mentions: [] }],
      }),
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
    async remindPremise(threadId): Promise<PremiseOutcome> {
      if (!config.premiseReminder) return "disabled";
      const turnId = queries.lastCompactedTurnId(threadId);
      if (turnId === null) return "no-compaction";
      // The watermark is read AND written through the durable meta table, so
      // "exactly one message per compaction" survives a plugin reload. An
      // in-memory set would re-send every reminder after a crash loop.
      const key = premiseWatermarkKey(threadId);
      if (store.getMeta(key) === turnId) return "already-reminded";

      const fact = queries.steerContext(threadId, now());
      if (!fact?.runFolder) return "no-run-folder";
      const ledger = readLedger(fact.runFolder);
      if (ledger === null) return "no-ledger";
      const text = buildPremiseReminder(fact.runFolder, ledger);
      if (text === null) return "nothing-to-say";

      // Written BEFORE the send is awaited, for the same reason the ladder
      // records before it sends: a reminder that reached the thread and left
      // no watermark would be sent again on the next drain.
      store.setMeta(key, turnId);
      const verdict = await ladder.queue(threadId, text, "premise-reminder");
      return verdict === "queued" ? "sent" : "refused";
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

      // `ctx.enabled()` is async and the drain listener is synchronous, so the
      // toggle is cached here and refreshed by the sweep. Without it the
      // listener would keep evaluating and publishing for a module the sweep
      // has already stopped running.
      let moduleEnabled = await ctx.enabled();

      const ingest = options.ingest();
      if (ingest) {
        // The listener is synchronous and wrapped by the module breaker, so a
        // rule that throws costs watch its breaker count and never the drain.
        const unsubscribe = ingest.onDrained((threadId, ingested) => {
          if (ingested === 0 || !moduleEnabled) return;
          try {
            runtime.engine.evaluateThread(threadId);
          } catch (error) {
            ctx.bb.log.error(
              `[watch] evaluate ${threadId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          // The premise reminder is async and the listener is not, so it runs
          // AFTER the synchronous evaluation rather than interleaved with it —
          // that ordering is what keeps the engine's no-interleave argument
          // true — and it carries its own error path, because a rejection
          // escaping a sync listener would surface as an unhandled rejection
          // with no thread id attached.
          void runtime.remindPremise(threadId).catch((error: unknown) => {
            ctx.bb.log.error(
              `[watch] premise reminder ${threadId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
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
          moduleEnabled = await ctx.enabled();
          if (!moduleEnabled) return;
          // Refresh first: the sweep is the one place a KV threshold change
          // becomes effective without anyone calling the settings RPC.
          await runtime.refresh();
          runtime.engine.sweep();
        }),
      );

      // Teardown for the ladder's send chain. A reload that dropped it would
      // leave a scheduled steer running against a disposed database handle
      // when its `catch` went to record the failure.
      ctx.bb.onDispose(() => runtime.ladder.settled());

      ctx.bb.log.info(`[watch] observing in mode ${runtime.config().mode}`);
    },
  });
}
