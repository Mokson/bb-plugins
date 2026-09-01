// The log-indexing seam.
//
// Log parsing is filesystem work on the machine that ran the agent, so it
// belongs in the `bb.host` worker. Everything above it talks to this
// interface, and phase 1 plus every test uses `LocalHostClient`, which
// implements it in-process. That keeps the indexer testable without a daemon
// and keeps the remote-host case a swap of one object.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export const indexBatchInputSchema = z
  .object({
    /** Absolute log roots to scan. */
    roots: z.array(z.string()),
    /** Resume point per file path: bytes already indexed. */
    cursors: z.record(z.string(), z.number()).default({}),
    /** Upper bound on rows returned in one call. */
    limit: z.number().int().positive().default(500),
  })
  .strict();

export const logRowSchema = z
  .object({
    logKey: z.string(),
    provider: z.string(),
    providerThreadId: z.string().nullable(),
    ts: z.string(),
    path: z.string(),
    indexedBytes: z.number(),
  })
  .strict();

export const indexBatchOutputSchema = z
  .object({
    rows: z.array(logRowSchema),
    /** False when more rows remain behind the returned cursors. */
    done: z.boolean(),
  })
  .strict();

export const pingOutputSchema = z.object({ ok: z.literal(true) }).strict();

/** The contract both the host worker and `LocalHostClient` implement. */
export const hostContract = defineRpcContract({
  ping: { input: z.object({}).strict(), output: pingOutputSchema },
  indexBatch: {
    input: indexBatchInputSchema,
    output: indexBatchOutputSchema,
  },
});

export type IndexBatchInput = z.input<typeof indexBatchInputSchema>;
export type IndexBatchOutput = z.output<typeof indexBatchOutputSchema>;
export type LogRow = z.output<typeof logRowSchema>;

export interface HostClient {
  ping(): Promise<{ ok: true }>;
  indexBatch(input: IndexBatchInput): Promise<IndexBatchOutput>;
}

/**
 * The in-process implementation. Phase 0 parses nothing: it answers the shape
 * so the seam is exercised end to end, and phase 1 fills in the parsers behind
 * this same interface.
 */
export class LocalHostClient implements HostClient {
  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async indexBatch(_input: IndexBatchInput): Promise<IndexBatchOutput> {
    return { rows: [], done: true };
  }
}
