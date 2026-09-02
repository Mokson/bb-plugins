// The spend module's wire contract.
//
// Same discipline as `src/contract.ts`: the panel imports these types with
// `import type` only, every value it renders arrives over rpc, and the CLI
// formats the SAME objects, so the two surfaces cannot drift.
//
// Nullability is the load-bearing part here. `cacheReadTokens`,
// `cacheWriteTokens` and `costUsd` are nullable on every row because the
// ledger refuses to invent a cache split or a price, and a rollup that summed
// an unknown as zero would turn "unmeasured" into "free" on a cost page.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export const spendRangeSchema = z.enum(["1d", "7d", "30d", "90d"]);
export const spendGroupSchema = z.enum(["lineage", "model", "day"]);

export type SpendRange = z.output<typeof spendRangeSchema>;
export type SpendGroup = z.output<typeof spendGroupSchema>;

export const spendTotalsSchema = z
  .object({
    spendUsd: z.number(),
    cacheSavedUsd: z.number(),
    cacheWriteUsd: z.number(),
    missCostUsd: z.number(),
    /** Distinct models in range whose turns could not be priced. */
    unpricedModels: z.number(),
  })
  .strict();

export const spendRowSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    depth: z.number(),
    parentKey: z.string().optional(),
    kind: z.enum([
      "thread",
      "seat",
      "group",
      "model",
      "day",
      "unparented",
    ]),
    turns: z.number(),
    inputTokens: z.number(),
    /**
     * The sum over the turns whose split IS proven, NULL only when NO turn in
     * the group has one. One unknown descendant used to null the whole
     * aggregate, so in a 47-agent run every real row read `--`; the partial
     * flags below say "this is a floor, not the total" instead.
     */
    cacheReadTokens: z.number().nullable(),
    cacheWriteTokens: z.number().nullable(),
    /** True when SOME turn in this group has an unproven split. */
    cacheReadPartial: z.boolean().optional(),
    cacheWritePartial: z.boolean().optional(),
    outputTokens: z.number(),
    costUsd: z.number().nullable(),
    /** True when any turn's cost came from the catalog rather than the bill. */
    estimated: z.boolean(),
    childCount: z.number().optional(),
  })
  .strict();

export const spendOverviewInputSchema = z
  .object({
    range: spendRangeSchema,
    /**
     * Reserved. The ledger stores no host id today (`obs_thread` has no such
     * column and core is the only writer), so a supplied host does not narrow
     * the result. Kept on the wire so the filter can start working without a
     * contract change.
     */
    host: z.string().optional(),
    provider: z.string().optional(),
    group: spendGroupSchema,
  })
  .strict();

export const spendOverviewSchema = z
  .object({ totals: spendTotalsSchema, rows: z.array(spendRowSchema) })
  .strict();

export const turnRowSchema = z
  .object({
    turnId: z.string(),
    startedAt: z.string(),
    durationMs: z.number().nullable(),
    modelRequested: z.string().nullable(),
    modelReported: z.string().nullable(),
    effort: z.string().nullable(),
    inputTokens: z.number(),
    cacheReadTokens: z.number().nullable(),
    cacheWriteTokens: z.number().nullable(),
    outputTokens: z.number(),
    reasoningTokens: z.number().nullable(),
    costUsd: z.number().nullable(),
    costSource: z.string(),
    splitSource: z.string(),
    flags: z.array(z.string()),
  })
  .strict();

export const spendThreadSchema = z
  .object({
    thread: z
      .object({
        threadId: z.string(),
        title: z.string(),
        provider: z.string(),
        seat: z.string().nullable(),
        tier: z.string().nullable(),
        runFolder: z.string().nullable(),
      })
      .strict(),
    totals: spendTotalsSchema,
    turns: z.array(turnRowSchema),
  })
  .strict();

export const cacheMissCauseSchema = z.enum([
  "compaction",
  "context-cleared",
  "model-switch",
  "idle-expiry",
  "skill-injection",
  "mcp-change",
  "subagent-spawn",
  "first-turn",
  "unknown",
]);

export type CacheMissCause = z.output<typeof cacheMissCauseSchema>;

export const cacheMissRowSchema = z
  .object({
    threadId: z.string(),
    provider: z.string().optional(),
    turnId: z.string(),
    prevTurnId: z.string(),
    at: z.string(),
    priorCacheRead: z.number(),
    cacheRead: z.number(),
    drop: z.number(),
    estimatedUsd: z.number().nullable(),
    cause: cacheMissCauseSchema,
    /** Every correlate observed in the gap, not only the classified one. */
    correlates: z.array(
      z
        .object({ kind: z.string(), detail: z.string(), at: z.string() })
        .strict(),
    ),
    recurrence7d: z.number(),
  })
  .strict();

export const spendTodaySchema = z
  .object({
    spendUsd: z.number(),
    turns: z.number(),
    threads: z.number(),
    updatedAt: z.string(),
  })
  .strict();

export const spendExportSchema = z
  .object({ content: z.string(), filename: z.string() })
  .strict();

// --- absorbed usage-tracker footer strip -----------------------------------
//
// Ported from `bb-plugins/plugins/usage-tracker/server.ts` unchanged in shape:
// the strip's app code is being absorbed as is, so any drift here would break
// it silently.

export const USAGE_PROVIDER_IDS = ["codex", "claudeCode", "cursor"] as const;
export const SIDEBAR_PROVIDER_IDS = ["claudeCode", "codex"] as const;
export const COMPACT_LIMIT_OPTIONS = ["Weekly", "Five-hour"] as const;

const usageCostSchema = z
  .object({
    usedUsdCents: z.number().finite(),
    limitUsdCents: z.number().finite(),
  })
  .strict();

const usageWindowSchema = z
  .object({
    label: z.string(),
    usedPercent: z.number().finite(),
    barPercent: z.number().finite().min(0).max(100),
    resetsAt: z.string().nullable(),
    cost: usageCostSchema.nullable(),
  })
  .strict();

const usageProviderSchema = z
  .object({
    id: z.enum(USAGE_PROVIDER_IDS),
    name: z.string(),
    status: z.enum([
      "ok",
      "not_installed",
      "unauthenticated",
      "expired",
      "error",
    ]),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  })
  .strict();

export const usageSnapshotSchema = z
  .object({
    fetchedAt: z.string(),
    host: z
      .object({ id: z.string().nullable(), name: z.string().nullable() })
      .strict(),
    providers: z.array(usageProviderSchema),
  })
  .strict();

export const usagePreferencesSchema = z
  .object({
    enabledProviderIds: z.array(z.enum(SIDEBAR_PROVIDER_IDS)),
    compactLimit: z.enum(COMPACT_LIMIT_OPTIONS),
  })
  .strict();

export type SpendTotals = z.output<typeof spendTotalsSchema>;
export type SpendRow = z.output<typeof spendRowSchema>;
export type SpendOverview = z.output<typeof spendOverviewSchema>;
export type TurnRow = z.output<typeof turnRowSchema>;
export type SpendThreadView = z.output<typeof spendThreadSchema>;
export type CacheMissRow = z.output<typeof cacheMissRowSchema>;
export type SpendToday = z.output<typeof spendTodaySchema>;
export type SpendExport = z.output<typeof spendExportSchema>;
export type UsageSnapshotView = z.output<typeof usageSnapshotSchema>;
export type UsagePreferencesView = z.output<typeof usagePreferencesSchema>;

export const spendContract = defineRpcContract({
  "observatory_spend_overview": {
    input: spendOverviewInputSchema,
    output: spendOverviewSchema,
  },
  "observatory_spend_thread": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: spendThreadSchema,
  },
  "observatory_spend_cache_misses": {
    input: z
      .object({ range: spendRangeSchema, threadId: z.string().optional() })
      .strict(),
    output: z.object({ rows: z.array(cacheMissRowSchema) }).strict(),
  },
  "observatory_spend_today": {
    input: z.object({}).strict(),
    output: spendTodaySchema,
  },
  "observatory_spend_export": {
    input: z
      .object({
        range: spendRangeSchema,
        group: spendGroupSchema,
        format: z.enum(["md", "json"]),
        // The export must cover the same slice the table on screen shows.
        // Without these the file silently widens to every host and provider,
        // and nothing in it says so.
        host: z.string().optional(),
        provider: z.string().optional(),
      })
      .strict(),
    output: spendExportSchema,
  },
  "observatory_usage": {
    input: z.object({ threadId: z.string().trim().min(1).nullable() }).strict(),
    output: usageSnapshotSchema,
  },
  "observatory_usage_preferences": {
    input: z.null(),
    output: usagePreferencesSchema,
  },
});

// Aliases the panel pages import; same shapes, panel-side names.
export type SpendThread = SpendThreadView;
export type SpendCacheMisses = z.output<typeof spendContract.observatory_spend_cache_misses.output>;
