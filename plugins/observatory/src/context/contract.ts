// The context module's wire contract.
//
// Same discipline as `src/spend/contract.ts`: the panel imports these types
// with `import type` only, the CLI formats the SAME objects, and every number
// that could not be measured is `null` rather than zero. An estimate is
// labelled as one — `estTokens` is always a model of the prefix, never a
// count, and `calibrationError` is how wrong that model was last time it was
// checked against a provider's own `cache_write`.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/** The four things that make up the prefix of every request in a project. */
export const contextSurfaceSchema = z.enum([
  "instruction",
  "skill",
  "mcp",
  "plugin-tool",
]);

export type ContextSurface = z.output<typeof contextSurfaceSchema>;

export const contextBlockSchema = z
  .object({
    surface: contextSurfaceSchema,
    /** Absolute path for a file-backed block, null for a synthesized one. */
    path: z.string().nullable(),
    name: z.string(),
    bytes: z.number(),
    estTokens: z.number(),
    hash: z.string(),
    /** The block name this one overlaps past the duplicate threshold. */
    duplicateOf: z.string().nullable(),
    dead: z.boolean(),
  })
  .strict();

export const contextSnapshotSchema = z
  .object({
    id: z.number(),
    projectId: z.string().nullable(),
    cwd: z.string(),
    takenAt: z.string(),
    provider: z.string().nullable(),
    totalEstTokens: z.number(),
    /** Multiplier applied to raw chars/3.6, learned from `cache_write`. */
    calibrationFactor: z.number().nullable(),
    /** Relative error of the last prediction. Null when never checked. */
    calibrationError: z.number().nullable(),
  })
  .strict();

export const contextDuplicateSchema = z
  .object({
    a: z.string(),
    b: z.string(),
    /** Shared 8-word shingles over the smaller block's shingles. */
    overlap: z.number(),
    recoverableTokens: z.number(),
  })
  .strict();

export const contextDeadSkillSchema = z
  .object({ name: z.string(), path: z.string().nullable(), bytes: z.number() })
  .strict();

export const contextCompositionSchema = z
  .object({
    surface: contextSurfaceSchema,
    estTokens: z.number(),
    share: z.number(),
  })
  .strict();

export const contextViewSchema = z
  .object({
    snapshot: contextSnapshotSchema,
    blocks: z.array(contextBlockSchema),
    duplicates: z.array(contextDuplicateSchema),
    dead: z.array(contextDeadSkillSchema),
    composition: z.array(contextCompositionSchema),
  })
  .strict();

export const contextThreadSchema = z
  .object({
    threadId: z.string(),
    contextUsed: z.number().nullable(),
    contextWindow: z.number().nullable(),
    /** Share of the used window that is conversation, not prefix. */
    historyShare: z.number().nullable(),
    /** Share of this thread's items that returned tool output. */
    toolResultShare: z.number().nullable(),
    compactionEstimateTokens: z.number().nullable(),
    snapshotId: z.number().nullable(),
  })
  .strict();

export type ContextBlock = z.output<typeof contextBlockSchema>;
export type ContextSnapshot = z.output<typeof contextSnapshotSchema>;
export type ContextDuplicate = z.output<typeof contextDuplicateSchema>;
export type ContextDeadSkill = z.output<typeof contextDeadSkillSchema>;
export type ContextComposition = z.output<typeof contextCompositionSchema>;
export type ContextView = z.output<typeof contextViewSchema>;
export type ContextThreadView = z.output<typeof contextThreadSchema>;

export const contextContract = defineRpcContract({
  "observatory_context_snapshot": {
    input: z
      .object({
        cwd: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        /** Rescan the filesystem instead of serving the newest snapshot. */
        refresh: z.boolean().optional(),
      })
      .strict(),
    output: contextViewSchema,
  },
  "observatory_context_thread": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: contextThreadSchema,
  },
});
