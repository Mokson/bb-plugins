import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1).max(256);

const tokenTotalsSchema = z.object({
  totalTokens: z.number().finite().nonnegative(),
  inputTokens: z.number().finite().nonnegative(),
  cachedInputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  reasoningOutputTokens: z.number().finite().nonnegative(),
});

/** The resolved model and effort. B29's null is "the thread never ran". */
const executionSchema = z
  .object({ model: z.string().min(1), reasoningLevel: z.string().min(1) })
  .nullable();

export const dossierSchema = z.object({
  threadId: threadIdSchema,
  /** null when the thread never resolved execution options (never ran). */
  execution: executionSchema,
  /** null when the provider reports no token usage. B31's no-data case. */
  economics: z
    .object({
      total: tokenTotalsSchema,
      modelContextWindow: z.number().finite().nonnegative().nullable(),
    })
    .nullable(),
  contextWindow: z
    .object({
      usedTokens: z.number().finite().nonnegative().nullable(),
      modelContextWindow: z.number().finite().nonnegative().nullable(),
      estimated: z.boolean(),
    })
    .nullable(),
  /** Epoch ms the backend produced this payload; drives the frontend TTL. */
  fetchedAt: z.number().finite().nonnegative(),
});

export const rowSignalSchema = z.object({
  threadId: threadIdSchema,
  /** B37: usedTokens / modelContextWindow, or null when either is missing. */
  contextPressure: z.number().finite().min(0).max(1).nullable(),
  /** B38 */
  modelFallback: z
    .object({
      originalModel: z.string().min(1),
      fallbackModel: z.string().min(1),
      reason: z.string().min(1),
      message: z.string().min(1),
    })
    .nullable(),
  /** B39: true when the newest provider/rateLimits/updated event parks the thread. */
  isRateLimitPaused: z.boolean(),
  /** B40 */
  goal: z
    .object({
      status: z.string().min(1),
      tokensUsed: z.number().finite().nonnegative(),
      tokenBudget: z.number().finite().nonnegative().nullable(),
    })
    .nullable(),
});

/** B71.1: one entry per requested id, in request order. */
export const threadExecutionSchema = z.object({
  threadId: threadIdSchema,
  /** null when the thread never ran, and also when its lookup failed. */
  execution: executionSchema,
});

/** B82: one entry per requested id. `at` is null when the thread has no events. */
export const threadLastActivitySchema = z.object({
  threadId: threadIdSchema,
  /** Epoch ms of the thread's newest event, of any type. */
  at: z.number().finite().nonnegative().nullable(),
});

/** B85: the t3-style work labels for one thread. Both fields degrade to null. */
export const threadWorkStatSchema = z.object({
  threadId: threadIdSchema,
  /** Cumulative total tokens from the newest usage event; null when none. */
  tokens: z.number().finite().nonnegative().nullable(),
  /** Tool-call count from the timeline's work rows; null when the read failed. */
  toolCalls: z.number().finite().nonnegative().nullable(),
});

export const betterSidebarRpcContract = defineRpcContract({
  /** One hovered thread's dossier. B31 returns nulls, never throws. */
  threadDossier: {
    input: z.object({ threadId: threadIdSchema }),
    output: dossierSchema,
  },
  /** Row glyph signals for the ids currently VISIBLE IN THE VIEWPORT only. */
  rowSignals: {
    input: z.object({ threadIds: z.array(threadIdSchema).max(60) }),
    output: z.object({ signals: z.array(rowSignalSchema) }),
  },
  /**
   * B71.1: model and effort for every child in one open popover, in ONE round
   * trip. The parent of this very feature has seventeen children, so a call
   * per child was rejected; the fan-out lives inside the handler.
   */
  threadExecutions: {
    input: z.object({ threadIds: z.array(threadIdSchema).max(60) }),
    output: z.object({ executions: z.array(threadExecutionSchema) }),
  },
  /**
   * B82: when each thread last did anything, for the row's relative time.
   *
   * `thread.updatedAt` is a record write, not activity: it moves when the user
   * sends a message or the thread is archived, and a bulk write stamps every
   * thread at once. Measured on a running thread, `updatedAt` sat 111s behind
   * the newest event while the agent worked. The newest event row is the
   * activity, so the row reads that instead.
   */
  lastActivity: {
    input: z.object({ threadIds: z.array(threadIdSchema).max(60) }),
    output: z.object({ activity: z.array(threadLastActivitySchema) }),
  },
  /**
   * B85: tokens and tool calls for every child in one open popover, in one
   * round trip. Same fan-out shape as `threadExecutions`; same nulls-not-
   * throws degradation per id.
   */
  threadWorkStats: {
    input: z.object({ threadIds: z.array(threadIdSchema).max(60) }),
    output: z.object({ stats: z.array(threadWorkStatSchema) }),
  },
  /**
   * The machine bb itself runs on, so a row can drop a host name that says
   * nothing. The app SDK exposes each thread's host but no identity for the
   * current one, so the answer has to come from the backend's
   * `system.config().primaryHostId`.
   *
   * Null when bb reports no primary host, which is also the safe answer: a
   * null matches no thread's host id, so every row keeps its label.
   */
  localHost: {
    input: z.object({}),
    output: z.object({ hostId: z.string().nullable() }),
  },
});

export const DOSSIER_CHANNEL = "better-sidebar:dossier";

/** The `threadDossier` result. Slice 4's `DossierState.data` is `Dossier | null`. */
export type Dossier = z.infer<typeof dossierSchema>;
/** One entry of the `rowSignals` result. */
export type RowSignal = z.infer<typeof rowSignalSchema>;
/** One entry of the `threadExecutions` result. */
export type ThreadExecution = z.infer<typeof threadExecutionSchema>;
/** One entry of the `lastActivity` result. */
export type ThreadLastActivity = z.infer<typeof threadLastActivitySchema>;
/** One entry of the `threadWorkStats` result. */
export type ThreadWorkStat = z.infer<typeof threadWorkStatSchema>;
