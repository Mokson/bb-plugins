// The wire contract the panel imports with `import type` only. Nothing here
// reaches the app bundle at runtime: every value the panel shows arrives over
// rpc, and the CLI's `status` renders the SAME object, so the two surfaces
// cannot drift.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

export const moduleStateSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    /** Which layer decided `enabled`. */
    source: z.enum(["kv", "setting", "default"]),
    failures: z.number(),
    tripped: z.boolean(),
    lastError: z.string().nullable(),
  })
  .strict();

export const storeCountsSchema = z
  .object({
    threads: z.number(),
    turns: z.number(),
    items: z.number(),
    openSignals: z.number(),
    actions: z.number(),
  })
  .strict();

export const settingSummarySchema = z
  .object({ key: z.string(), value: z.string() })
  .strict();

export const statusSchema = z
  .object({
    pluginId: z.string(),
    phase: z.string(),
    modules: z.array(moduleStateSchema),
    counts: storeCountsSchema,
    settings: z.array(settingSummarySchema),
    generatedAt: z.string(),
  })
  .strict();

export type ModuleState = z.output<typeof moduleStateSchema>;
export type StoreCountsView = z.output<typeof storeCountsSchema>;
export type StatusView = z.output<typeof statusSchema>;

export const observatoryContract = defineRpcContract({
  "observatory_status": {
    input: z.object({}).strict(),
    output: statusSchema,
  },
});
