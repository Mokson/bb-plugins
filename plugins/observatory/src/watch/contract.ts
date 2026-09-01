// The watch module's wire contract.
//
// Types and zod schemas only, exactly like `src/spend/contract.ts`: the app
// imports the types with `import type` and the server seat implements the
// method names verbatim, so neither half owns the shape alone. Nothing here
// reaches the store or better-sqlite3 - this file is the seam.
//
// Method names use underscores. bb rejects dots in rpc method names and the
// panel addresses these over `POST /api/v1/plugins/observatory/rpc/<method>`.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/**
 * How loudly a signal asks for attention.
 *
 * Three rungs, not five: the inbox sorts by this and a reader can hold three
 * words in their head. It carries no colour on any surface (PRODUCT invariant
 * 34) - it decides order and nothing else.
 */
export const watchSeveritySchema = z.enum(["info", "warn", "high"]);

/** Whether the watcher currently believes a thread is making progress. */
export const watchStateSchema = z.enum(["healthy", "stalled"]);

/**
 * What the agent is doing right now, when it is doing anything. `kind` is the
 * item kind (`tool`, `command`, `read`), `name` its target. Null means the
 * thread has no item in flight, which is what makes silence a stall rather
 * than a long tool call.
 */
export const watchInflightSchema = z
  .object({ kind: z.string(), name: z.string() })
  .strict();

/**
 * One row of the stall monitor.
 *
 * `silentMs` is time since the last item, not since the last turn: a thread
 * can hold one turn open for an hour and still be healthy. `rule` names which
 * of PRODUCT invariant 21's rules fired, and `diagnostic` is the sentence the
 * steer ladder would send - shown even in `observe`, where nothing is sent.
 */
export const watchRowSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    seat: z.string().nullable(),
    state: watchStateSchema,
    silentMs: z.number(),
    inflight: watchInflightSchema.nullable(),
    stage: z.string().nullable(),
    rule: z.string().nullable(),
    diagnostic: z.string().nullable(),
    openedAt: z.string().nullable(),
  })
  .strict();

export const watchListSchema = z
  .object({ watched: z.number(), rows: z.array(watchRowSchema) })
  .strict();

/**
 * One recorded signal.
 *
 * `payload` is deliberately open: each rule carries its own evidence fields
 * and pinning them here would make every new rule a contract change. The
 * surfaces read `evidence`, which is prose the server already composed.
 */
export const watchSignalSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    severity: watchSeveritySchema,
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    evidence: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

/** A signal carrying the thread it belongs to, for the cross-thread list. */
export const watchSignalRowSchema = watchSignalSchema
  .extend({ threadId: z.string() })
  .strict();

/** One rung of the steer ladder that actually fired. */
export const watchActionSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    at: z.string(),
    detail: z.string(),
  })
  .strict();

export const watchExplainInputSchema = z
  .object({ threadId: z.string() })
  .strict();

export const watchExplainSchema = z
  .object({
    threadId: z.string(),
    signals: z.array(watchSignalSchema),
    actions: z.array(watchActionSchema),
  })
  .strict();

export const watchSignalsInputSchema = z
  .object({
    threadId: z.string().optional(),
    open: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const watchSignalsSchema = z
  .object({ rows: z.array(watchSignalRowSchema) })
  .strict();

/** `off` records nothing, `observe` records only, `steer` sends. */
export const watchModeSchema = z.enum(["off", "observe", "steer"]);

/** Which layer decided a threshold, so the panel can offer a reset. */
export const watchSourceSchema = z.enum(["kv", "setting"]);

export const watchSettingsSchema = z
  .object({
    mode: watchModeSchema,
    thresholds: z.record(z.string(), z.number()),
    source: z.record(z.string(), watchSourceSchema),
    /** One line the panel shows after a write, e.g. what `steer` now sends. */
    note: z.string().optional(),
  })
  .strict();

export const watchSettingsGetInputSchema = z.object({}).strict();

export const watchSettingsSetInputSchema = z
  .object({
    mode: watchModeSchema.optional(),
    thresholds: z.record(z.string(), z.number()).optional(),
    /**
     * Threshold keys whose KV override is dropped, so the row falls back to
     * the plugin setting. A distinct field rather than a sentinel value: the
     * panel cannot know what the setting says while KV shadows it, so it can
     * only ask for the override to go away.
     */
    reset: z.array(z.string()).optional(),
  })
  .strict();

/** Which module raised an inbox row. */
export const inboxSourceSchema = z.enum([
  "watch",
  "spend",
  "audit",
  "eval",
  "distillery",
]);

/** What the reader can do about a row. Phase 2 enables only `open`. */
export const inboxActionSchema = z.enum([
  "open",
  "steer",
  "escalate",
  "review",
]);

export const inboxRowSchema = z
  .object({
    id: z.string(),
    source: inboxSourceSchema,
    kind: z.string(),
    title: z.string(),
    subtitle: z.string(),
    threadId: z.string().nullable(),
    severity: watchSeveritySchema,
    openedAt: z.string(),
    actions: z.array(inboxActionSchema),
  })
  .strict();

export const inboxCountsSchema = z
  .object({
    watched: z.number(),
    stalled: z.number(),
    overBudget: z.number(),
    queue: z.number(),
  })
  .strict();

export const inboxInputSchema = z
  .object({ limit: z.number().int().positive().optional() })
  .strict();

export const inboxSchema = z
  .object({ rows: z.array(inboxRowSchema), counts: inboxCountsSchema })
  .strict();

/**
 * What the server publishes on `observatory/signal`. The composer banner and
 * the thread-row status follow it so a closed signal disappears without a
 * reload.
 */
export const WATCH_SIGNAL_CHANNEL = "observatory/signal";

export const watchSignalEventSchema = z
  .object({
    threadId: z.string(),
    kind: z.string(),
    state: z.enum(["open", "closed"]),
    severity: watchSeveritySchema,
    evidence: z.string(),
  })
  .strict();

export type WatchSeverity = z.output<typeof watchSeveritySchema>;
export type WatchState = z.output<typeof watchStateSchema>;
export type WatchInflight = z.output<typeof watchInflightSchema>;
export type WatchRow = z.output<typeof watchRowSchema>;
export type WatchList = z.output<typeof watchListSchema>;
export type WatchSignal = z.output<typeof watchSignalSchema>;
export type WatchSignalRow = z.output<typeof watchSignalRowSchema>;
export type WatchAction = z.output<typeof watchActionSchema>;
export type WatchExplain = z.output<typeof watchExplainSchema>;
export type WatchSignals = z.output<typeof watchSignalsSchema>;
export type WatchMode = z.output<typeof watchModeSchema>;
export type WatchSource = z.output<typeof watchSourceSchema>;
export type WatchSettings = z.output<typeof watchSettingsSchema>;
export type InboxSource = z.output<typeof inboxSourceSchema>;
export type InboxAction = z.output<typeof inboxActionSchema>;
export type InboxRow = z.output<typeof inboxRowSchema>;
export type InboxCounts = z.output<typeof inboxCountsSchema>;
export type Inbox = z.output<typeof inboxSchema>;
export type WatchSignalEvent = z.output<typeof watchSignalEventSchema>;

export const watchContract = defineRpcContract({
  "observatory_watch_list": {
    input: z.object({}).strict(),
    output: watchListSchema,
  },
  "observatory_watch_explain": {
    input: watchExplainInputSchema,
    output: watchExplainSchema,
  },
  "observatory_watch_signals": {
    input: watchSignalsInputSchema,
    output: watchSignalsSchema,
  },
  "observatory_watch_settings_get": {
    input: watchSettingsGetInputSchema,
    output: watchSettingsSchema,
  },
  "observatory_watch_settings_set": {
    input: watchSettingsSetInputSchema,
    output: watchSettingsSchema,
  },
  "observatory_inbox": {
    input: inboxInputSchema,
    output: inboxSchema,
  },
});
