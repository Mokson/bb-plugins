import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1).max(256);

/**
 * Workspace-relative path. Strict at the boundary: no absolute paths, no
 * `..` segments, no null bytes, no backslashes. The server additionally
 * confines every host call beneath the thread workspace root.
 */
const relPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0"), {
    message: "must be a relative path",
  })
  .refine((p) => !p.split("/").includes(".."), {
    message: "must not contain .. segments",
  });

const entrySchema = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(["file", "directory"]),
});

const changedFileSchema = z.object({
  path: z.string().min(1).max(1024),
  additions: z.number().finite().nonnegative(),
  deletions: z.number().finite().nonnegative(),
});

export const filesRpcContract = defineRpcContract({
  tree: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z
      .object({
        root: z.string().min(1),
        entries: z.array(entrySchema),
        truncated: z.boolean(),
      })
      .strict(),
  },
  read: {
    input: z.object({ threadId: threadIdSchema, path: relPathSchema }).strict(),
    output: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        sha256: z.string().nullable(),
        sizeBytes: z.number().finite().nonnegative().nullable(),
        truncated: z.boolean(),
      })
      .strict(),
  },
  save: {
    input: z
      .object({
        threadId: threadIdSchema,
        path: relPathSchema,
        content: z.string().max(5 * 1024 * 1024),
        expectedSha256: z.string().min(1).max(256).nullish(),
      })
      .strict(),
    output: z
      .object({
        outcome: z.enum(["written", "conflict"]),
        sha256: z.string().nullable(),
        currentSha256: z.string().nullable(),
      })
      .strict(),
  },
  search: {
    input: z
      .object({
        threadId: threadIdSchema,
        query: z.string().trim().min(1).max(256),
      })
      .strict(),
    output: z
      .object({ paths: z.array(z.string().min(1).max(1024)) })
      .strict(),
  },
  changed: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z
      .object({
        files: z.array(changedFileSchema),
        unavailable: z.boolean(),
      })
      .strict(),
  },
  media: {
    input: z.object({ threadId: threadIdSchema, path: relPathSchema }).strict(),
    output: z
      .object({
        available: z.boolean(),
        imageUrl: z.string().nullable(),
        sizeBytes: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
  },
});

export type FilesRpcContract = typeof filesRpcContract;
