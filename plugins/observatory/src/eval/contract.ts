// The eval module's wire contract.
//
// Same discipline as `src/spend/contract.ts`: the panel imports these types
// with `import type` only, the CLI formats the SAME objects, and every read
// method is total — an unparseable case comes back as a row with `valid:
// false` and its error, never as a thrown rpc.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/** The last recorded attempt at a case, for the cases list. */
export const evalLastResultSchema = z
  .object({
    runId: z.string(),
    trial: z.number(),
    status: z.string().nullable(),
  })
  .strict();

export const evalCaseSummarySchema = z
  .object({
    name: z.string(),
    tags: z.array(z.string()),
    path: z.string(),
    valid: z.boolean(),
    /** Null exactly when `valid`. Carries the offending key's path. */
    error: z.string().nullable(),
    lastResult: evalLastResultSchema.nullable(),
  })
  .strict();

export const evalCasesOutputSchema = z
  .object({ cases: z.array(evalCaseSummarySchema) })
  .strict();

export const evalRunSummarySchema = z
  .object({
    id: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    tag: z.string().nullable(),
    stackSha: z.string().nullable(),
    /** The case names SELECTED at run time, frozen against later file edits. */
    cases: z.array(z.string()),
    status: z.string().nullable(),
    gate: z.string().nullable(),
  })
  .strict();

export const evalCaseResultSchema = z
  .object({
    case: z.string(),
    trial: z.number(),
    status: z.string().nullable(),
    threadId: z.string().nullable(),
    artifactsDir: z.string().nullable(),
    /** Opaque to the wire: part 2 owns their shape. */
    assertions: z.unknown().nullable(),
    metrics: z.unknown().nullable(),
  })
  .strict();

export const evalRunsOutputSchema = z
  .object({ runs: z.array(evalRunSummarySchema) })
  .strict();

export const evalRunOutputSchema = z
  .object({
    run: evalRunSummarySchema.nullable(),
    results: z.array(evalCaseResultSchema),
  })
  .strict();

export type EvalCaseSummary = z.output<typeof evalCaseSummarySchema>;
export type EvalRunSummary = z.output<typeof evalRunSummarySchema>;
export type EvalCaseResultView = z.output<typeof evalCaseResultSchema>;
export type EvalCasesView = z.output<typeof evalCasesOutputSchema>;
export type EvalRunsView = z.output<typeof evalRunsOutputSchema>;
export type EvalRunView = z.output<typeof evalRunOutputSchema>;

export const evalContract = defineRpcContract({
  "observatory_eval_cases": {
    input: z.object({}).strict(),
    output: evalCasesOutputSchema,
  },
  "observatory_eval_runs": {
    input: z
      .object({ limit: z.number().int().positive().max(500).default(50) })
      .strict(),
    output: evalRunsOutputSchema,
  },
  "observatory_eval_run": {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: evalRunOutputSchema,
  },
});
