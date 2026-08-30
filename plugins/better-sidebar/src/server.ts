import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  betterSidebarRpcContract,
  DOSSIER_CHANNEL,
  type Dossier,
  type RowSignal,
} from "./server-contract";

/** TECH.md §5: threadDossier absorbs the re-hover burst; rowSignals a scroll. */
const DOSSIER_TTL_MS = 10_000;
const SIGNALS_TTL_MS = 30_000;

type ThreadsApi = BbPluginApi["sdk"]["threads"];
type EventRow = Awaited<ReturnType<ThreadsApi["events"]["list"]>>[number];
type EventType = EventRow["type"];

/** A TTL cache over in-flight promises, so a burst of hovers is one SDK read. */
class TtlCache<T> {
  readonly #entries = new Map<string, { promise: Promise<T>; expiresAt: number }>();
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    this.#entries.delete(key);

    const promise = load();
    const entry = { promise, expiresAt: Date.now() + this.#ttlMs };
    this.#entries.set(key, entry);
    // A failure is the caller's to surface (ruling 10); it is never cached, so
    // the next call retries. The catch only keeps the rejection from detaching.
    promise.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return promise;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

/**
 * The newest event row of the given types, or null when the thread has none.
 * One `events.list` call per signal with `limit:"1"` — TECH.md §5's ruling 9:
 * `limit` caps the whole filtered list, so a combined read silently drops an
 * older-but-still-current row of a low-traffic type.
 */
async function newestEvent<T extends EventType>(
  threads: ThreadsApi,
  threadId: string,
  types: readonly [T, ...T[]],
): Promise<Extract<EventRow, { type: T }> | null> {
  const rows = await threads.events.list({
    threadId,
    types,
    order: "desc",
    limit: "1",
  });
  // SAFETY: `types` filters the query server-side, so every returned row's
  // `type` is one of `T`. `ThreadEventRow` is a union the compiler cannot
  // narrow from the argument, so the discriminant is re-stated here.
  return (rows[0] as Extract<EventRow, { type: T }> | undefined) ?? null;
}

/** B37: the fraction of the model's context window in use, when both are known. */
function pressure(
  usedTokens: number | null,
  modelContextWindow: number | null,
): number | null {
  if (usedTokens === null || modelContextWindow === null) return null;
  if (modelContextWindow <= 0) return null;
  return usedTokens / modelContextWindow;
}

async function loadDossier(threads: ThreadsApi, threadId: string): Promise<Dossier> {
  const [execution, tokenUsage, contextUsage] = await Promise.all([
    threads.defaultExecutionOptions({ threadId }),
    newestEvent(threads, threadId, ["thread/tokenUsage/updated"]),
    newestEvent(threads, threadId, ["thread/contextWindowUsage/updated"]),
  ]);

  return {
    threadId,
    // B29 (§7): both lines are omitted together when options never resolved.
    execution: execution
      ? { model: execution.model, reasoningLevel: execution.reasoningLevel }
      : null,
    // B31: no token events is a value, not an error.
    economics: tokenUsage
      ? {
          total: tokenUsage.data.tokenUsage.total,
          modelContextWindow: tokenUsage.data.tokenUsage.modelContextWindow,
        }
      : null,
    contextWindow: contextUsage
      ? {
          usedTokens: contextUsage.data.contextWindowUsage.usedTokens,
          modelContextWindow: contextUsage.data.contextWindowUsage.modelContextWindow,
          estimated: contextUsage.data.contextWindowUsage.estimated,
        }
      : null,
    fetchedAt: Date.now(),
  };
}

async function loadRowSignal(threads: ThreadsApi, threadId: string): Promise<RowSignal> {
  const [contextUsage, fallback, rateLimits, goal] = await Promise.all([
    newestEvent(threads, threadId, ["thread/contextWindowUsage/updated"]),
    newestEvent(threads, threadId, ["provider/modelFallback"]),
    newestEvent(threads, threadId, ["provider/rateLimits/updated"]),
    newestEvent(threads, threadId, ["thread/goal/updated", "thread/goal/cleared"]),
  ]);

  return {
    threadId,
    contextPressure: contextUsage
      ? pressure(
          contextUsage.data.contextWindowUsage.usedTokens,
          contextUsage.data.contextWindowUsage.modelContextWindow,
        )
      : null,
    // B38
    modelFallback: fallback
      ? {
          originalModel: fallback.data.originalModel,
          fallbackModel: fallback.data.fallbackModel,
          reason: fallback.data.reason,
          message: fallback.data.message,
        }
      : null,
    // B39 (§7): an extra monochrome glyph, not a sixth indicator state.
    isRateLimitPaused: rateLimits?.data.rateLimits.status === "blocked",
    // B40: a newer `cleared` wins over an older `updated`.
    goal:
      goal?.type === "thread/goal/updated"
        ? {
            status: goal.data.status,
            tokensUsed: goal.data.tokensUsed,
            tokenBudget: goal.data.tokenBudget,
          }
        : null,
  };
}

export default function plugin(bb: BbPluginApi) {
  // Caches live per load, so a reload starts cold and nothing outlives dispose.
  const dossierCache = new TtlCache<Dossier>(DOSSIER_TTL_MS);
  const signalsCache = new TtlCache<RowSignal>(SIGNALS_TTL_MS);

  // B48-B50
  bb.settings.define({
    groupBy: {
      type: "select",
      label: "Group by",
      options: ["date", "project", "none"],
      default: "date",
    },
    secondRow: {
      type: "select",
      label: "Second row",
      options: ["auto", "always", "never"],
      default: "auto",
    },
    tooltip: {
      type: "select",
      label: "Hover card",
      options: ["rich", "minimal", "off"],
      default: "rich",
    },
  });

  bb.rpc.register(betterSidebarRpcContract, {
    // `bb.sdk.threads` is read per call, not captured: a disposed handle must
    // throw PluginContextStaleError rather than reach a dead runtime.
    threadDossier: ({ threadId }) =>
      dossierCache.get(threadId, () => loadDossier(bb.sdk.threads, threadId)),
    rowSignals: async ({ threadIds }) => ({
      signals: await Promise.all(
        threadIds.map((threadId) =>
          signalsCache.get(threadId, () => loadRowSignal(bb.sdk.threads, threadId)),
        ),
      ),
    }),
  });

  // B28, re-worded by §7: `thread/tokenUsage/updated` is not subscribable, but
  // `thread.idle` fires exactly when that turn's last usage event has landed.
  for (const event of ["thread.active", "thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      dossierCache.delete(thread.id);
      signalsCache.delete(thread.id);
      bb.realtime.publish(DOSSIER_CHANNEL, { threadId: thread.id });
    });
  }

  // A deleted thread has no row left to refresh: evict, do not publish.
  bb.events.on("thread.deleted", ({ thread }) => {
    dossierCache.delete(thread.id);
    signalsCache.delete(thread.id);
  });

  bb.log.info(`loaded ${bb.pluginId}`);
}
