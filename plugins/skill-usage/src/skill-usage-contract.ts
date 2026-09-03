import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const idSchema = z.string().trim().min(1).max(256);

const invocationSchema = z
  .object({
    itemId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    seq: z.number().finite(),
    createdAt: z.number().finite(),
    skill: z.string().min(1).max(512),
    args: z.string().max(4096).nullable(),
    status: z.enum(["completed", "failed", "running"]),
    result: z.string().max(4096).nullable(),
  })
  .strict();

const rollupThreadSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    /** Null when the thread has been deleted between refresh and render. */
    title: z.string().max(512).nullable(),
    count: z.number().finite().nonnegative(),
    lastUsedAt: z.number().finite(),
  })
  .strict();

const rollupRowSchema = z
  .object({
    skill: z.string().min(1).max(512),
    total: z.number().finite().nonnegative(),
    failures: z.number().finite().nonnegative(),
    lastUsedAt: z.number().finite(),
    threads: z.array(rollupThreadSchema),
  })
  .strict();

const indexStatusSchema = z
  .object({
    running: z.boolean(),
    /** Threads walked so far in the current pass. */
    done: z.number().finite().nonnegative(),
    /** Threads in the current pass, 0 before the pass has enumerated them. */
    total: z.number().finite().nonnegative(),
    /** Threads with at least one indexed invocation. */
    indexedThreads: z.number().finite().nonnegative(),
    lastRefreshAt: z.number().finite().nullable(),
    /** Message from the last failed pass, cleared when the next pass starts. */
    error: z.string().max(1024).nullable(),
  })
  .strict();

export const skillUsageRpcContract = defineRpcContract({
  /** Thread scope. Reads events directly, so it is never index-stale. */
  threadInvocations: {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.object({ invocations: z.array(invocationSchema) }).strict(),
  },
  /**
   * Block until the thread emits a Skill-relevant event past `afterSeq`, or
   * the server-side wait times out. The panel loops this to stay live.
   */
  waitThread: {
    input: z
      .object({ threadId: idSchema, afterSeq: z.number().finite().nonnegative() })
      .strict(),
    output: z.object({ changed: z.boolean() }).strict(),
  },
  /**
   * Project scope resolves the project from the panel's own thread, so the
   * frontend never has to know or guess a project id.
   */
  rollup: {
    input: z
      .object({ scope: z.enum(["project", "global"]), threadId: idSchema })
      .strict(),
    output: z.object({ skills: z.array(rollupRowSchema) }).strict(),
  },
  indexStatus: {
    input: z.object({}).strict(),
    output: indexStatusSchema,
  },
  /** Start a catch-up pass, or a full rebuild. No-op while one is running. */
  indexRefresh: {
    input: z.object({ rebuild: z.boolean().optional() }).strict(),
    output: indexStatusSchema,
  },
});

export type SkillUsageRpcContract = typeof skillUsageRpcContract;

/** Realtime channel carrying index progress signals. Payload is the status. */
export const INDEX_CHANNEL = "skill-usage/index";
