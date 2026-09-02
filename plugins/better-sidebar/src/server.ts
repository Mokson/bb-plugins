import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  betterSidebarRpcContract,
  DOSSIER_CHANNEL,
  type Dossier,
  type RowSignal,
  type ThreadExecution,
  type ThreadLastActivity,
  type ThreadWorkStat,
} from "./server-contract";

type ThreadsApi = BbPluginApi["sdk"]["threads"];
type EventRow = Awaited<ReturnType<ThreadsApi["events"]["list"]>>[number];
type EventType = EventRow["type"];
type TimelineRow = Awaited<ReturnType<ThreadsApi["timeline"]>>["rows"][number];

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

/**
 * B85. One thread's work labels: cumulative tokens off the newest usage
 * event, and the tool-call count off the timeline's work rows. A failure of
 * either read degrades that field to null, never the whole entry.
 *
 * Tool calls are every timeline row that carries a `callId` - tool, command,
 * file change, search and plan-steps rows alike - because that is the set a
 * per-call counter counts. Rows without one (approvals, questions, turns)
 * are not calls. The count covers the timeline window bb serves; a thread
 * whose history is windowed can under-count, which a null never hides.
 */
async function loadWorkStats(
  threads: ThreadsApi,
  threadId: string,
  log?: (message: string) => void,
): Promise<ThreadWorkStat> {
  try {
    // Per-field degradation: a usage read that fails must not cost the tool
    // count, and the reverse. B71.1's one-unreadable-child rule, finer grained.
    let tokens: number | null = null;
    let toolCalls: number | null = null;
    try {
      const usage = await newestEvent(threads, threadId, [
        "thread/tokenUsage/updated",
      ]);
      tokens = usage?.data.tokenUsage.total.totalTokens ?? null;
    } catch {
      tokens = null;
    }
    try {
      const timeline = await threads.timeline({ threadId, segmentLimit: "100" });
      let calls = 0;
      const walk = (rows: readonly unknown[] | null | undefined): void => {
        for (const row of rows ?? []) {
          if (
            typeof row === "object" &&
            row !== null &&
            "kind" in row &&
            row.kind === "work" &&
            "callId" in row
          ) {
            calls += 1;
          }
          // Delegation rows nest their child's rows; turns nest their rows.
          if (typeof row === "object" && row !== null) {
            if ("children" in row && Array.isArray(row.children)) {
              walk(row.children);
            }
            if ("childRows" in row && Array.isArray(row.childRows)) {
              walk(row.childRows);
            }
          }
        }
      };
      walk(timeline.rows as unknown as readonly unknown[]);
      toolCalls = calls;
    } catch (error) {
      log?.(`threadWorkStats: timeline read failed for ${threadId}: ${String(error)}`);
      toolCalls = null;
    }
    return { threadId, tokens, toolCalls };
  } catch {
    return { threadId, tokens: null, toolCalls: null };
  }
}

/**
 * B71.1: one child's model and effort, from the same call `loadDossier` makes.
 *
 * A per-id rejection becomes `execution: null` for that id and nothing more.
 * One unreadable child must not cost the popover its other sixteen rows, and
 * the frontend already draws no metadata line for a null.
 */
async function loadExecution(
  threads: ThreadsApi,
  threadId: string,
): Promise<ThreadExecution> {
  try {
    const execution = await threads.defaultExecutionOptions({ threadId });
    return {
      threadId,
      execution: execution
        ? { model: execution.model, reasoningLevel: execution.reasoningLevel }
        : null,
    };
  } catch {
    return { threadId, execution: null };
  }
}

/**
 * B82: the newest event of ANY type, which is when the thread last did
 * something. No `types` filter, `limit:"1"`, so it is one indexed read.
 *
 * A per-id rejection becomes `at: null` and the row falls back to
 * `thread.updatedAt`, which is what it showed before this existed.
 */
async function loadLastActivity(
  threads: ThreadsApi,
  threadId: string,
): Promise<ThreadLastActivity> {
  try {
    const rows = await threads.events.list({ threadId, order: "desc", limit: "1" });
    return { threadId, at: rows[0]?.createdAt ?? null };
  } catch {
    return { threadId, at: null };
  }
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
    showSecondRow: {
      type: "boolean",
      label: "Show the metadata row under each title",
      description:
        "Off hides it everywhere. On, density and grouping still decide: compact draws none, and grouping by project already says the project.",
      default: true,
    },
    showProjectName: {
      type: "boolean",
      label: "Show the project name on the metadata row",
      default: true,
    },
    showBranch: {
      type: "boolean",
      label: "Show the git branch on the metadata row",
      default: true,
    },
    showModel: {
      type: "boolean",
      label: "Show the model and effort on the metadata row",
      description:
        "The only field on the row that costs a backend lookup. Off, the list asks for no execution options at all.",
      default: true,
    },
    showEffort: {
      type: "boolean",
      label: "Show the effort on the metadata row",
      description:
        "The reasoning level after the dot. Off, the row names the model alone. Needs the model on.",
      default: false,
    },
    showQuickPin: {
      type: "boolean",
      label: "Quick action: pin",
      description: "The pin toggle in the row's hover actions.",
      default: true,
    },
    showQuickMarkRead: {
      type: "boolean",
      label: "Quick action: mark read",
      description:
        "The read toggle in the row's hover actions. Off, it stays reachable from the context and overflow menus.",
      default: false,
    },
    showQuickArchive: {
      type: "boolean",
      label: "Quick action: archive",
      description: "The archive button in the row's hover actions.",
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
    // B71.1: the fan-out is here, inside one round trip, not across the wire.
    threadExecutions: async ({ threadIds }) => ({
      executions: await Promise.all(
        threadIds.map((threadId) => loadExecution(bb.sdk.threads, threadId)),
      ),
    }),
    // B82: the same one-round-trip fan-out, for the ids the list has rendered.
    lastActivity: async ({ threadIds }) => ({
      activity: await Promise.all(
        threadIds.map((threadId) => loadLastActivity(bb.sdk.threads, threadId)),
      ),
    }),
    // B85: tokens and tool calls, fanned out like the executions above.
    threadWorkStats: async ({ threadIds }) => ({
      stats: await Promise.all(
        threadIds.map((threadId) =>
          loadWorkStats(bb.sdk.threads, threadId, (message) =>
            bb.log.warn(message),
          ),
        ),
      ),
    }),
    // A row's host name is worth drawing only when the work runs somewhere
    // else. `primaryHostId` is bb's own machine; a config read that fails
    // degrades to null, which keeps every label rather than hiding one wrongly.
    localHost: async () => {
      try {
        const config = await bb.sdk.system.config();
        return { hostId: config.primaryHostId ?? null };
      } catch (error) {
        bb.log.warn(`localHost: system.config failed: ${String(error)}`);
        return { hostId: null };
      }
    },
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
