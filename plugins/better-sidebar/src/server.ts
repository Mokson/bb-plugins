import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  betterSidebarRpcContract,
  completedEntrySchema,
  COMPLETED_KV_KEY,
  DOSSIER_CHANNEL,
  type CompletedEntry,
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
  if (!Number.isFinite(usedTokens) || !Number.isFinite(modelContextWindow)) {
    return null;
  }
  if (modelContextWindow <= 0) return null;
  return Math.min(1, Math.max(0, usedTokens / modelContextWindow));
}

/**
 * Round-2 H1: the SDK types promise shaped numbers and non-empty strings, but
 * the wire can carry anything — a corrupt row, a vendor change. The output
 * schemas are strict, so one corrupt VALUE would reject the whole batch (the
 * row is fine, the payload is not). Every producer below sanitizes at
 * construction instead: finite/nonnegative numbers fall back to null, strings
 * that must be non-empty fall back to a null parent (or a null field where the
 * schema allows one), so one corrupt row degrades alone.
 */
function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The untyped payload of one event row; `{}` when the row is malformed. */
function eventPayload(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null) return {};
  const data = (row as { data?: unknown }).data;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

function nestedValue(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** null for "never ran" and for a corrupt value alike; the row draws neither. */
function sanitizeExecution(
  execution: { model: unknown; reasoningLevel: unknown } | null | undefined,
): ThreadExecution["execution"] {
  if (execution === null || execution === undefined) return null;
  const model = nonEmptyString(execution.model);
  const reasoningLevel = nonEmptyString(execution.reasoningLevel);
  return model !== null && reasoningLevel !== null
    ? { model, reasoningLevel }
    : null;
}

function sanitizeTokenTotals(value: unknown): Dossier["economics"] {
  const usage = nestedValue(eventPayload(value), ["tokenUsage"]);
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const total = record.total;
  if (typeof total !== "object" || total === null) return null;
  const fields = total as Record<string, unknown>;
  const totalTokens = finiteNonNegative(fields.totalTokens);
  const inputTokens = finiteNonNegative(fields.inputTokens);
  const cachedInputTokens = finiteNonNegative(fields.cachedInputTokens);
  const outputTokens = finiteNonNegative(fields.outputTokens);
  const reasoningOutputTokens = finiteNonNegative(
    fields.reasoningOutputTokens,
  );
  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }
  const windowRaw = record.modelContextWindow;
  return {
    total: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    },
    // Nullable in the schema, so a corrupt window degrades the field, not the row.
    modelContextWindow:
      windowRaw === null || windowRaw === undefined
        ? null
        : (finiteNonNegative(windowRaw) ?? null),
  };
}

function sanitizeContextWindow(value: unknown): Dossier["contextWindow"] {
  const usage = nestedValue(eventPayload(value), ["contextWindowUsage"]);
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const usedRaw = record.usedTokens;
  const windowRaw = record.modelContextWindow;
  // Nullable in the schema: corrupt-but-present numbers degrade the field.
  const usedTokens =
    usedRaw === null || usedRaw === undefined
      ? null
      : (finiteNonNegative(usedRaw) ?? null);
  const modelContextWindow =
    windowRaw === null || windowRaw === undefined
      ? null
      : (finiteNonNegative(windowRaw) ?? null);
  // Required by the schema with no null arm: a corrupt flag voids the section.
  if (typeof record.estimated !== "boolean") return null;
  return { usedTokens, modelContextWindow, estimated: record.estimated };
}

/** null for "no fallback" and for a corrupt value alike; the glyph draws neither. */
function sanitizeModelFallback(row: unknown): RowSignal["modelFallback"] {
  if (row === null || row === undefined) return null;
  const payload = eventPayload(row);
  const originalModel = nonEmptyString(payload.originalModel);
  const fallbackModel = nonEmptyString(payload.fallbackModel);
  const reason = nonEmptyString(payload.reason);
  const message = nonEmptyString(payload.message);
  return originalModel !== null &&
    fallbackModel !== null &&
    reason !== null &&
    message !== null
    ? { originalModel, fallbackModel, reason, message }
    : null;
}

/** null for "no goal" (or a clear) and for a corrupt value alike. */
function sanitizeGoal(row: unknown): RowSignal["goal"] {
  if (typeof row !== "object" || row === null) return null;
  if ((row as { type?: unknown }).type !== "thread/goal/updated") return null;
  const payload = eventPayload(row);
  const status = nonEmptyString(payload.status);
  const tokensUsed = finiteNonNegative(payload.tokensUsed);
  if (status === null || tokensUsed === null) return null;
  const budgetRaw = payload.tokenBudget;
  // Nullable in the schema: a corrupt budget degrades the field, not the goal.
  const tokenBudget =
    budgetRaw === null || budgetRaw === undefined
      ? null
      : (finiteNonNegative(budgetRaw) ?? null);
  return { status, tokensUsed, tokenBudget };
}

function sanitizeContextPressure(row: unknown): RowSignal["contextPressure"] {
  if (row === null || row === undefined) return null;
  const usage = nestedValue(eventPayload(row), ["contextWindowUsage"]);
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const used = record.usedTokens;
  const window = record.modelContextWindow;
  if (typeof used !== "number" || typeof window !== "number") return null;
  return pressure(used, window);
}

function isRateLimitBlocked(row: unknown): boolean {
  const status = nestedValue(eventPayload(row), ["rateLimits", "status"]);
  return status === "blocked";
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
      tokens = finiteNonNegative(
        usage?.data.tokenUsage.total.totalTokens ?? null,
      );
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
    // H1: a corrupt model string degrades this id, never the batch.
    return { threadId, execution: sanitizeExecution(execution) };
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
    // H1: a corrupt timestamp falls back to null (the row draws
    // `thread.updatedAt`), never to a rejected batch.
    return { threadId, at: finiteNonNegative(rows[0]?.createdAt ?? null) };
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
    // H1: a corrupt model string degrades this call, never a batch around it.
    execution: sanitizeExecution(execution),
    // B31: no token events is a value, not an error. H1: corrupt values
    // degrade their own section, never the call.
    economics: tokenUsage ? sanitizeTokenTotals(tokenUsage) : null,
    contextWindow: contextUsage ? sanitizeContextWindow(contextUsage) : null,
    fetchedAt: Date.now(),
  };
}

async function loadRowSignal(threads: ThreadsApi, threadId: string): Promise<RowSignal> {
  // One failing read degrades its own field, never the whole row: a bare
  // four-way `Promise.all` rejected this thread's signal on any single
  // failure, and the handler's own `Promise.all` turned that into a rejected
  // batch for every id it covered.
  const [contextUsage, fallback, rateLimits, goal] = await Promise.all([
    newestEvent(threads, threadId, ["thread/contextWindowUsage/updated"]).catch(
      () => null,
    ),
    newestEvent(threads, threadId, ["provider/modelFallback"]).catch(() => null),
    newestEvent(threads, threadId, ["provider/rateLimits/updated"]).catch(
      () => null,
    ),
    newestEvent(threads, threadId, ["thread/goal/updated", "thread/goal/cleared"]).catch(
      () => null,
    ),
  ]);

  return {
    threadId,
    // H1: every field below degrades to its own null on a corrupt value, so
    // one bad row never rejects the batch its siblings share.
    contextPressure: sanitizeContextPressure(contextUsage),
    // B38
    modelFallback: sanitizeModelFallback(fallback),
    // B39 (§7): an extra monochrome glyph, not a sixth indicator state.
    isRateLimitPaused: isRateLimitBlocked(rateLimits),
    // B40: a newer `cleared` wins over an older `updated`.
    goal: sanitizeGoal(goal),
  };
}

/**
 * The per-id loaders above never throw, so the fan-out's only remaining risk
 * is width: 60 ids at once is 60 concurrent SDK reads (240 for rowSignals).
 * Sequential batches of 8 bound that without a dependency. Ids are deduplicated
 * first, so a repeated id costs one read and still answers once per request.
 * An empty list answers empty without touching the SDK.
 */
const FAN_OUT_CONCURRENCY = 8;

/**
 * Round-2 M1: the batch cap above bounds one call, but two calls racing (the
 * list's rowSignals plus its lastActivity on the same scroll) each ran 8
 * loads, doubling the concurrent SDK reads with no shared ceiling. This
 * module-level semaphore caps concurrent per-id LOADS across every in-flight
 * call at the same 8. (One signals load fans out to 4 event reads, so the
 * worst case is still a bounded multiple — the point is one shared ceiling.)
 *
 * Deadlock-free: a load never acquires while holding another slot, every
 * acquisition releases in a `finally`, waiters are served FIFO, and batches
 * stay sequential — so a waiting batch always has running loads draining ahead
 * of it. There is exactly one client per backend (see the no-cache comment on
 * the handlers), which is why a process-wide cap is the right bound.
 */
const GLOBAL_MAX_CONCURRENT_LOADS = 8;
let globalActiveLoads = 0;
const globalLoadWaiters: Array<() => void> = [];

function acquireLoadSlot(): Promise<void> {
  if (globalActiveLoads < GLOBAL_MAX_CONCURRENT_LOADS) {
    globalActiveLoads += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    globalLoadWaiters.push(() => {
      globalActiveLoads += 1;
      resolve();
    });
  });
}

function releaseLoadSlot(): void {
  globalActiveLoads -= 1;
  const next = globalLoadWaiters.shift();
  if (next !== undefined) next();
}

async function collectInBatches<T>(
  threadIds: readonly string[],
  load: (threadId: string) => Promise<T>,
  keyOf: (value: T) => string,
): Promise<T[]> {
  const unique = [...new Set(threadIds)];
  const byId = new Map<string, T>();
  for (let i = 0; i < unique.length; i += FAN_OUT_CONCURRENCY) {
    const batch = await Promise.all(
      unique.slice(i, i + FAN_OUT_CONCURRENCY).map(async (threadId) => {
        await acquireLoadSlot();
        try {
          return await load(threadId);
        } finally {
          releaseLoadSlot();
        }
      }),
    );
    for (const value of batch) byId.set(keyOf(value), value);
  }
  // Round-2 L3: the contract promises one entry per REQUESTED id in request
  // order, but dedupe above loads each id once. Expand back to the input's
  // multiplicity so a repeated id answers once per request, not once total.
  return threadIds.map((threadId) => byId.get(threadId) as T);
}

/**
 * B86: the filed set as stored, validated on the way out.
 *
 * The row is written by this plugin and read by this plugin, but a value that
 * survived an older shape, a hand edit, or a partial write must not blank the
 * sidebar's completion state or crash the list. Anything unparseable reads back
 * as "nothing filed", which is the state the user can see and correct.
 */
async function readCompleted(bb: BbPluginApi): Promise<CompletedEntry[]> {
  try {
    const stored = await bb.storage.kv.get<unknown>(COMPLETED_KV_KEY);
    if (stored === undefined) return [];
    const parsed = completedEntrySchema.array().safeParse(stored);
    if (!parsed.success) {
      bb.log.warn("completedThreads: stored value did not parse; treating as empty");
      return [];
    }
    return parsed.data;
  } catch (error) {
    bb.log.warn(`completedThreads: kv read failed: ${String(error)}`);
    return [];
  }
}

export default function plugin(bb: BbPluginApi) {
  // B59 plus the later slices: fourteen settings, server-backed so they follow the user across clients.
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
    showQuickCompleted: {
      type: "boolean",
      label: "Quick action: mark completed",
      description:
        "The completed toggle in the row's hover actions. Off, it stays reachable from the context and overflow menus.",
      default: true,
    },
    showSubgroups: {
      type: "boolean",
      label: "Show the Working and Completed subgroups",
      description:
        "Files each group's running threads under a WORKING header and its completed threads under a folded COMPLETED header. Off, every thread sits in its group's own rows.",
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
      signals: await collectInBatches(
        threadIds,
        (threadId) => loadRowSignal(bb.sdk.threads, threadId),
        (signal) => signal.threadId,
      ),
    }),
    // B71.1: the fan-out is here, inside one round trip, not across the wire.
    threadExecutions: async ({ threadIds }) => ({
      executions: await collectInBatches(
        threadIds,
        (threadId) => loadExecution(bb.sdk.threads, threadId),
        (entry) => entry.threadId,
      ),
    }),
    // B82: the same one-round-trip fan-out, for the ids the list has rendered.
    lastActivity: async ({ threadIds }) => ({
      activity: await collectInBatches(
        threadIds,
        (threadId) => loadLastActivity(bb.sdk.threads, threadId),
        (entry) => entry.threadId,
      ),
    }),
    // B85: tokens and tool calls, fanned out like the executions above.
    threadWorkStats: async ({ threadIds }) => ({
      stats: await collectInBatches(
        threadIds,
        (threadId) =>
          loadWorkStats(bb.sdk.threads, threadId, (message) =>
            bb.log.warn(message),
          ),
        (entry) => entry.threadId,
      ),
    }),
    // A row's host name is worth drawing only when the work runs somewhere
    // else. `primaryHostId` is bb's own machine; a config read that fails
    // degrades to null, which keeps every label rather than hiding one wrongly.
    // B86: the filed set, read whole on every list mount. One kv row, so the
    // read is one lookup however many threads are in it.
    completedThreads: async () => ({
      entries: await readCompleted(bb),
    }),
    setThreadCompleted: async ({ threadId, completed }) => {
      const current = await readCompleted(bb);
      const next = current.filter((entry) => entry.threadId !== threadId);
      // Re-filing an already filed thread restamps it, which is what the user
      // asked for by picking the item again — and the COMPLETED section orders
      // on that stamp.
      if (completed) next.push({ threadId, completedAt: Date.now() });
      try {
        await bb.storage.kv.set(COMPLETED_KV_KEY, next);
      } catch (error) {
        // The client renders optimistically and reverts on a rejection, so the
        // failure has to reach it rather than being swallowed into a stale-
        // looking success.
        bb.log.warn(`setThreadCompleted: kv write failed: ${String(error)}`);
        throw error;
      }
      return { entries: next };
    },
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
  //
  // No disposer is collected for these subscriptions: the SDK's `PluginEvents`
  // declaration types `on` as returning void, with no `off`. The host drops the
  // plugin's listeners with its scope on reload/disable, so there is nothing
  // for `onDispose` to release here.
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => {
      bb.realtime.publish(DOSSIER_CHANNEL, { threadId: thread.id });
    });
  }

  bb.log.info(`loaded ${bb.pluginId}`);
}
