// The watch module's wire contract.
//
// Panel and CLI render the SAME objects, the way `observatory_status` already
// does, so a stall the CLI reports and a stall the inbox shows cannot drift.
// Types only on the app side: nothing here is imported for its runtime value
// by the bundle.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/**
 * Rule ids. These are also `obs_signal.kind` values and the first segment of
 * every dedupe key, so renaming one orphans its open episodes — append
 * instead.
 */
export const RULE_IDS = [
  "silence-no-inflight",
  "repeated-identical-tool",
  "read-edit-read",
  "active-no-turn",
  "burn-no-change",
  "retry-storm",
  "tree-budget",
] as const;

export const ruleIdSchema = z.enum(RULE_IDS);
export type RuleId = (typeof RULE_IDS)[number];

/**
 * Narrow a stored `obs_signal.kind` back to a rule id, or null.
 *
 * The column is plain text and signals are kept forever, so a row written by a
 * build whose rule has since been renamed is a real shape a reader must
 * survive. Parsing at the boundary keeps that a null in the view instead of a
 * failed output validation at the wire.
 */
export function parseRuleId(value: string): RuleId | null {
  return (RULE_IDS as readonly string[]).includes(value)
    ? (value as RuleId)
    : null;
}

export const WATCH_MODES = ["off", "observe", "steer"] as const;
export const watchModeSchema = z.enum(WATCH_MODES);
export type WatchMode = (typeof WATCH_MODES)[number];

export const severitySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.output<typeof severitySchema>;

/**
 * Narrow a stored `obs_signal.severity` back to the union, defaulting to
 * `warn`. Same reason as `parseRuleId`: the column is nullable text, and a
 * reader must not assert its way into a wire validation failure.
 */
export function parseSeverity(value: string | null): Severity {
  return value === "critical" || value === "warn" || value === "info"
    ? value
    : "warn";
}

/** The module that opened a row. Only watch and spend exist; the rest are
 * declared so the inbox ranking never needs widening when they land. */
export const inboxSourceSchema = z.enum([
  "watch",
  "spend",
  "audit",
  "eval",
  "distillery",
]);
export type InboxSource = z.output<typeof inboxSourceSchema>;

export const inboxActionSchema = z.enum([
  "open",
  "steer",
  "escalate",
  "review",
]);
export type InboxAction = z.output<typeof inboxActionSchema>;

export const signalViewSchema = z
  .object({
    id: z.number(),
    kind: z.string(),
    severity: severitySchema,
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    /** One human line naming the numbers that opened it. */
    evidence: z.string(),
    payload: z.unknown(),
  })
  .strict();

export const threadSignalViewSchema = signalViewSchema
  .extend({ threadId: z.string().nullable() })
  .strict();

export const watchRowSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    seat: z.string().nullable(),
    state: z.enum(["healthy", "stalled"]),
    /** Wall time since the thread's most recent turn or item timestamp. */
    silentMs: z.number(),
    inflight: z
      .object({ kind: z.string(), name: z.string() })
      .strict()
      .nullable(),
    /** Deliver pipeline stage, from the seat the title names. Null off-pipeline. */
    stage: z.string().nullable(),
    /** The highest-severity open rule, or null when healthy. */
    rule: ruleIdSchema.nullable(),
    diagnostic: z.string().nullable(),
    openedAt: z.string().nullable(),
  })
  .strict();

export const inboxRowSchema = z
  .object({
    id: z.string(),
    source: inboxSourceSchema,
    kind: z.string(),
    title: z.string(),
    /** The evidence line. */
    subtitle: z.string(),
    threadId: z.string().nullable(),
    severity: severitySchema,
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

export const watchSettingsSchema = z
  .object({
    mode: watchModeSchema,
    thresholds: z.record(z.string(), z.number()),
    /** Which layer decided each threshold, plus `mode`. */
    source: z.record(z.string(), z.enum(["kv", "setting"])),
    /** Set when the stored mode does more than this phase honours. */
    note: z.string().nullable(),
  })
  .strict();

export type SignalView = z.output<typeof signalViewSchema>;
export type ThreadSignalView = z.output<typeof threadSignalViewSchema>;
export type WatchRow = z.output<typeof watchRowSchema>;
export type InboxRow = z.output<typeof inboxRowSchema>;
export type InboxCounts = z.output<typeof inboxCountsSchema>;
export type WatchSettingsView = z.output<typeof watchSettingsSchema>;

export const watchContract = defineRpcContract({
  "observatory_watch_list": {
    input: z.object({}).strict(),
    output: z
      .object({ watched: z.number(), rows: z.array(watchRowSchema) })
      .strict(),
  },
  "observatory_watch_explain": {
    input: z.object({ threadId: z.string() }).strict(),
    output: z
      .object({
        threadId: z.string(),
        signals: z.array(signalViewSchema),
        actions: z.array(
          z
            .object({
              id: z.number(),
              action: z.string(),
              at: z.string(),
              detail: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  "observatory_watch_signals": {
    input: z
      .object({
        threadId: z.string().optional(),
        open: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .strict(),
    output: z.object({ rows: z.array(threadSignalViewSchema) }).strict(),
  },
  "observatory_watch_settings_get": {
    input: z.object({}).strict(),
    output: watchSettingsSchema,
  },
  "observatory_watch_settings_set": {
    input: z
      .object({
        mode: watchModeSchema.optional(),
        thresholds: z.record(z.string(), z.number()).optional(),
      })
      .strict(),
    output: watchSettingsSchema,
  },
  "observatory_inbox": {
    input: z
      .object({ limit: z.number().int().positive().max(200).optional() })
      .strict(),
    output: z
      .object({ rows: z.array(inboxRowSchema), counts: inboxCountsSchema })
      .strict(),
  },
});

/** The realtime channel the app's thread-row status listener subscribes to. */
export const SIGNAL_CHANNEL = "observatory/signal";

export const signalBroadcastSchema = z
  .object({
    threadId: z.string(),
    kind: ruleIdSchema,
    state: z.enum(["open", "closed"]),
    severity: severitySchema,
    evidence: z.string(),
  })
  .strict();

export type SignalBroadcast = z.output<typeof signalBroadcastSchema>;
