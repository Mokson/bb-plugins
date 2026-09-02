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

/**
 * What a manual steer or escalation reports back.
 *
 * `verdict` is the ladder's own vocabulary, written verbatim into
 * `obs_action.result` too, so the one-line confirmation the page shows and the
 * row an auditor reads say the same word. `message` is that word rendered for
 * a person; the page does not compose its own, or the two would drift.
 */
export const steerResultSchema = z
  .object({
    threadId: z.string(),
    /** The thread the message actually went to. Differs on an escalation. */
    targetThreadId: z.string().nullable(),
    verdict: z.string(),
    sent: z.boolean(),
    message: z.string(),
  })
  .strict();

export type SteerResult = z.output<typeof steerResultSchema>;

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
        /**
         * Threshold keys whose KV override is dropped, so the row falls back
         * to the plugin setting. A distinct field rather than a sentinel
         * value: the panel cannot know what the setting says while KV shadows
         * it, so it can only ask for the override to go away.
         */
        reset: z.array(z.string()).optional(),
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
  /**
   * A person steering one thread by hand, from the Stalls page or the command
   * palette. The CLI reaches the same ladder method, so the two surfaces
   * cannot record differently.
   */
  "observatory_watch_steer": {
    input: z
      .object({ threadId: z.string(), note: z.string().optional() })
      .strict(),
    output: steerResultSchema,
  },
  "observatory_watch_escalate": {
    input: z
      .object({ threadId: z.string(), note: z.string().optional() })
      .strict(),
    output: steerResultSchema,
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

/**
 * Rung 3's channel. One channel, not one per thread: TECH decision 6 rules out
 * channel-scoped subscriptions, so a subscriber filters on `threadId` itself.
 */
export const ESCALATION_CHANNEL = "observatory/escalation";

export const escalationBroadcastSchema = z
  .object({
    /** The thread the evidence is about. */
    threadId: z.string(),
    /** The thread the steer went to: the parent, or the root. */
    targetThreadId: z.string(),
    rootThreadId: z.string(),
    /** Null for a manual escalation, which names no rule. */
    kind: ruleIdSchema.nullable(),
    severity: severitySchema,
    evidence: z.string(),
    at: z.string(),
  })
  .strict();

export type EscalationBroadcast = z.output<typeof escalationBroadcastSchema>;

// App-side names.
//
// The panel was written against a second draft of this file that used a
// `Watch`-prefixed vocabulary. The shapes above stayed the source of truth;
// these are the same schemas and the same types under the names the app
// imports, so there is exactly one contract and no adapter layer between the
// two halves.

export const WATCH_SIGNAL_CHANNEL = SIGNAL_CHANNEL;
export const WATCH_ESCALATION_CHANNEL = ESCALATION_CHANNEL;

export type WatchSeverity = Severity;
export type WatchSignal = SignalView;
export type WatchSignalRow = ThreadSignalView;
export type WatchSignalEvent = SignalBroadcast;
export type WatchSettings = WatchSettingsView;
/** Which layer decided a threshold, so the panel can offer a reset. */
export type WatchSource = WatchSettingsView["source"][string];

type Method<K extends keyof typeof watchContract> = z.output<
  (typeof watchContract)[K]["output"]
>;
export type WatchList = Method<"observatory_watch_list">;
export type WatchExplain = Method<"observatory_watch_explain">;
export type WatchSignals = Method<"observatory_watch_signals">;
export type Inbox = Method<"observatory_inbox">;
