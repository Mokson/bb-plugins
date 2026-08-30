import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1);

const tokenTotalsSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

/** The resolved model and effort. B29's null is "the thread never ran". */
const executionSchema = z
  .object({ model: z.string(), reasoningLevel: z.string() })
  .nullable();

export const dossierSchema = z.object({
  threadId: z.string(),
  /** null when the thread never resolved execution options (never ran). */
  execution: executionSchema,
  /** null when the provider reports no token usage. B31's no-data case. */
  economics: z
    .object({
      total: tokenTotalsSchema,
      modelContextWindow: z.number().nullable(),
    })
    .nullable(),
  contextWindow: z
    .object({
      usedTokens: z.number().nullable(),
      modelContextWindow: z.number().nullable(),
      estimated: z.boolean(),
    })
    .nullable(),
  /** Epoch ms the backend produced this payload; drives the frontend TTL. */
  fetchedAt: z.number(),
});

export const rowSignalSchema = z.object({
  threadId: z.string(),
  /** B37: usedTokens / modelContextWindow, or null when either is missing. */
  contextPressure: z.number().nullable(),
  /** B38 */
  modelFallback: z
    .object({
      originalModel: z.string(),
      fallbackModel: z.string(),
      reason: z.string(),
      message: z.string(),
    })
    .nullable(),
  /** B39: true when the newest provider/rateLimits/updated event parks the thread. */
  isRateLimitPaused: z.boolean(),
  /** B40 */
  goal: z
    .object({
      status: z.string(),
      tokensUsed: z.number(),
      tokenBudget: z.number().nullable(),
    })
    .nullable(),
});

/** B71.1: one entry per requested id, in request order. */
export const threadExecutionSchema = z.object({
  threadId: z.string(),
  /** null when the thread never ran, and also when its lookup failed. */
  execution: executionSchema,
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
});

export const DOSSIER_CHANNEL = "thread-dossier";

/** The `threadDossier` result. Slice 4's `DossierState.data` is `Dossier | null`. */
export type Dossier = z.infer<typeof dossierSchema>;
/** One entry of the `rowSignals` result. */
export type RowSignal = z.infer<typeof rowSignalSchema>;
/** One entry of the `threadExecutions` result. */
export type ThreadExecution = z.infer<typeof threadExecutionSchema>;
