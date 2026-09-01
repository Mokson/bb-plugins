// The spend module's wire contract.
//
// Types and zod schemas only. The app imports the types with `import type`
// and the server seat implements the method names verbatim, so neither side
// owns the shape alone. Nothing here reaches for the store, the ledger, or
// better-sqlite3: this file is the seam, not a participant.
//
// Method names use underscores. bb rejects dots in rpc method names and the
// panel addresses these over `POST /api/v1/plugins/observatory/rpc/<method>`.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/** The windows the overview offers. Widest last; `1d` is the default. */
export const spendRangeSchema = z.enum(["1d", "7d", "30d", "90d"]);

/** How the overview folds rows. Lineage is the thread/seat tree. */
export const spendGroupSchema = z.enum(["lineage", "model", "day"]);

/**
 * What a row stands for. `unparented` is a real bucket, not an error: turns
 * whose thread never resolved a parent still cost money and must total.
 */
export const spendRowKindSchema = z.enum([
  "thread",
  "seat",
  "group",
  "model",
  "day",
  "unparented",
]);

/**
 * The four hero numbers plus the unpriced-model count.
 *
 * `cacheSavedUsd` is what the cache read cost instead of a fresh prefix;
 * `missCostUsd` is what the misses charged. They are reported separately
 * because netting them hides which one moved.
 */
export const spendTotalsSchema = z
  .object({
    spendUsd: z.number(),
    cacheSavedUsd: z.number(),
    cacheWriteUsd: z.number(),
    missCostUsd: z.number(),
    unpricedModels: z.number(),
  })
  .strict();

/**
 * One overview row. The tree arrives flat: `depth` and `parentKey` carry the
 * shape so the server owns ordering and the panel owns only collapse state.
 *
 * `cacheReadTokens` and `cacheWriteTokens` are nullable and stay null when no
 * provider log row matched (PRODUCT invariant 2). Null renders `--`; it never
 * renders `0`.
 */
export const spendRowSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    depth: z.number().int().min(0),
    parentKey: z.string().optional(),
    kind: spendRowKindSchema,
    turns: z.number(),
    inputTokens: z.number(),
    cacheReadTokens: z.number().nullable(),
    cacheWriteTokens: z.number().nullable(),
    outputTokens: z.number(),
    costUsd: z.number().nullable(),
    /** True renders the number with a superscript `e` (invariant 27). */
    estimated: z.boolean(),
    childCount: z.number().optional(),
  })
  .strict();

export const spendOverviewInputSchema = z
  .object({
    range: spendRangeSchema,
    host: z.string().optional(),
    provider: z.string().optional(),
    group: spendGroupSchema,
  })
  .strict();

export const spendOverviewSchema = z
  .object({ totals: spendTotalsSchema, rows: z.array(spendRowSchema) })
  .strict();

/** Where a turn's cache read/write split came from. */
export const splitSourceSchema = z.enum([
  "log-exact",
  "log-window",
  "sidechain",
  "unavailable",
]);

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
    splitSource: splitSourceSchema,
    flags: z.array(z.string()),
  })
  .strict();

export const spendThreadHeaderSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    provider: z.string(),
    seat: z.string().nullable(),
    tier: z.string().nullable(),
    runFolder: z.string().nullable(),
  })
  .strict();

export const spendThreadInputSchema = z
  .object({ threadId: z.string() })
  .strict();

export const spendThreadSchema = z
  .object({
    thread: spendThreadHeaderSchema,
    totals: spendTotalsSchema,
    turns: z.array(turnRowSchema),
  })
  .strict();

/**
 * The classified cause, in the fixed precedence of PRODUCT invariant 18. The
 * drilldown still lists every correlate observed, so `cause` narrows the story
 * without hiding it.
 */
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

export const cacheMissCorrelateSchema = z
  .object({ kind: z.string(), detail: z.string(), at: z.string() })
  .strict();

export const cacheMissRowSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    prevTurnId: z.string(),
    at: z.string(),
    priorCacheRead: z.number(),
    cacheRead: z.number(),
    drop: z.number(),
    estimatedUsd: z.number().nullable(),
    cause: cacheMissCauseSchema,
    /**
     * Additive, and optional so a server that omits it still validates. The
     * drilldown's no-transcript line names the provider that owed the
     * transcript; without it the line can only say "unknown".
     */
    provider: z.string().optional(),
    correlates: z.array(cacheMissCorrelateSchema),
    recurrence7d: z.number(),
  })
  .strict();

export const spendCacheMissesInputSchema = z
  .object({ range: spendRangeSchema, threadId: z.string().optional() })
  .strict();

export const spendCacheMissesSchema = z
  .object({ rows: z.array(cacheMissRowSchema) })
  .strict();

/** The footer strip's one number, kept separate so the strip stays cheap. */
export const spendTodaySchema = z
  .object({
    spendUsd: z.number(),
    turns: z.number(),
    threads: z.number(),
    updatedAt: z.string(),
  })
  .strict();

export const spendExportInputSchema = z
  .object({
    range: spendRangeSchema,
    group: spendGroupSchema,
    format: z.enum(["md", "json"]),
  })
  .strict();

export const spendExportSchema = z
  .object({ content: z.string(), filename: z.string() })
  .strict();

export type SpendRange = z.output<typeof spendRangeSchema>;
export type SpendGroup = z.output<typeof spendGroupSchema>;
export type SpendRowKind = z.output<typeof spendRowKindSchema>;
export type SpendTotals = z.output<typeof spendTotalsSchema>;
export type SpendRow = z.output<typeof spendRowSchema>;
export type SpendOverview = z.output<typeof spendOverviewSchema>;
export type SplitSource = z.output<typeof splitSourceSchema>;
export type TurnRow = z.output<typeof turnRowSchema>;
export type SpendThreadHeader = z.output<typeof spendThreadHeaderSchema>;
export type SpendThread = z.output<typeof spendThreadSchema>;
export type CacheMissCause = z.output<typeof cacheMissCauseSchema>;
export type CacheMissCorrelate = z.output<typeof cacheMissCorrelateSchema>;
export type CacheMissRow = z.output<typeof cacheMissRowSchema>;
export type SpendCacheMisses = z.output<typeof spendCacheMissesSchema>;
export type SpendToday = z.output<typeof spendTodaySchema>;
export type SpendExport = z.output<typeof spendExportSchema>;

export const spendContract = defineRpcContract({
  observatory_spend_overview: {
    input: spendOverviewInputSchema,
    output: spendOverviewSchema,
  },
  observatory_spend_thread: {
    input: spendThreadInputSchema,
    output: spendThreadSchema,
  },
  observatory_spend_cache_misses: {
    input: spendCacheMissesInputSchema,
    output: spendCacheMissesSchema,
  },
  observatory_spend_today: {
    input: z.object({}).strict(),
    output: spendTodaySchema,
  },
  observatory_spend_export: {
    input: spendExportInputSchema,
    output: spendExportSchema,
  },
});
