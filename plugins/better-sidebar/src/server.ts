import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  betterSidebarRpcContract,
  DOSSIER_CHANNEL,
  type Dossier,
  type RowSignal,
} from "./server-contract";

type ThreadsApi = BbPluginApi["sdk"]["threads"];
type EventRow = Awaited<ReturnType<ThreadsApi["events"]["list"]>>[number];
type EventType = EventRow["type"];

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
  // B59: seven settings, server-backed so they follow the user across clients.
  bb.settings.define({
    groupBy: {
      type: "select",
      label: "Group by",
      options: ["date", "project", "host", "status", "none"],
      default: "date",
    },
    density: {
      type: "select",
      label: "Density",
      description:
        "compact hides row 2, the hover card and the signal glyphs, and makes no backend request. detailed adds row 2 in every group mode and the signal glyphs.",
      options: ["compact", "default", "detailed"],
      default: "default",
    },
    showPrChip: {
      type: "boolean",
      label: "Show the pull-request chip",
      description: "Off also skips the per-row pull-request subscription.",
      default: true,
    },
    showProviderGlyph: {
      type: "boolean",
      label: "Show the provider logo",
      default: true,
    },
    showRelativeTime: {
      type: "boolean",
      label: "Show the relative time",
      default: true,
    },
    showArchivedChildren: {
      type: "boolean",
      label: "Show archived child threads",
      description: "Archived children of an expanded parent.",
      default: true,
    },
    showHeaderChip: {
      type: "boolean",
      label: "Show the child-threads chip in the thread header",
      default: true,
    },
  });

  // These handlers do not cache. The frontend already caches both methods at
  // the same TTLs, with in-flight de-duplication, and there is exactly one
  // client per backend — so a backend copy absorbs nothing a single client can
  // notice, while adding a second invalidation surface that can silently
  // disagree with the first. One cache, on the side that serves the hover.
  bb.rpc.register(betterSidebarRpcContract, {
    // `bb.sdk.threads` is read per call, not captured: a disposed handle must
    // throw PluginContextStaleError rather than reach a dead runtime.
    threadDossier: ({ threadId }) => loadDossier(bb.sdk.threads, threadId),
    rowSignals: async ({ threadIds }) => ({
      signals: await Promise.all(
        threadIds.map((threadId) => loadRowSignal(bb.sdk.threads, threadId)),
      ),
    }),
  });

  // B28, re-worded by §7: `thread/tokenUsage/updated` is not subscribable, but
  // `thread.idle` fires exactly when that turn's last usage event has landed —
  // which is why it, and not `thread.active`, is the moment to invalidate.
  // `thread.active` fires at the START of a turn, when no new usage data exists
  // yet; publishing there only doubles every visible row's refetch per turn.
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      bb.realtime.publish(DOSSIER_CHANNEL, { threadId: thread.id });
    });
  }

  bb.log.info(`loaded ${bb.pluginId}`);
}
