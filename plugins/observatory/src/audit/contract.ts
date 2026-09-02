// The audit module's wire contract.
//
// Audit stores nothing of its own: every shape here is materialized from core
// tables on request, which is why there is no snapshot id anywhere in it. The
// one piece of state it keeps is a mute, and a mute lives in `obs_meta` with
// an expiry rather than in a table, because a mute nobody ever revisits is a
// finding that was deleted without saying so.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { spendRangeSchema } from "../spend/contract.js";

export const auditSessionRowSchema = z
  .object({
    threadId: z.string(),
    title: z.string().nullable(),
    seat: z.string().nullable(),
    runFolder: z.string().nullable(),
    turns: z.number(),
    toolCalls: z.number(),
    tokens: z.number(),
    costUsd: z.number().nullable(),
    wallMs: z.number().nullable(),
    providerErrors: z.number(),
    compactions: z.number(),
  })
  .strict();

/** One measure of one session beside the 7-day median of the same measure. */
export const auditMetricSchema = z
  .object({
    metric: z.string(),
    value: z.number().nullable(),
    median: z.number().nullable(),
    /** value/median - 1. Null when either side is unknown or the median is 0. */
    delta: z.number().nullable(),
  })
  .strict();

export const auditVerificationSchema = z
  .object({
    commands: z.number(),
    verificationCommands: z.number(),
    lastVerifiedAt: z.string().nullable(),
    /**
     * False when the ledger holds no command text to pattern-match, which is
     * the normal case: core fingerprints command arguments and drops them. The
     * boundary then falls back to any command item.
     */
    textAvailable: z.boolean(),
  })
  .strict();

export const auditUnverifiedEditSchema = z
  .object({
    itemId: z.string(),
    path: z.string().nullable(),
    at: z.string().nullable(),
  })
  .strict();

export const auditFindingSchema = z
  .object({ code: z.string(), detail: z.string() })
  .strict();

export const auditSessionSchema = z
  .object({
    threadId: z.string().nullable(),
    runFolder: z.string().nullable(),
    threads: z.array(z.string()),
    metrics: z.array(auditMetricSchema),
    verification: auditVerificationSchema,
    unverifiedEdits: z.array(auditUnverifiedEditSchema),
    findings: z.array(auditFindingSchema),
  })
  .strict();

export const auditFailureRowSchema = z
  .object({
    signature: z.string(),
    category: z.string(),
    /**
     * The normalized text the signature is built from: the model for a turn
     * failure, `kind:name` for an item failure. Not the provider's error
     * message — the ledger keeps no column for one.
     */
    subject: z.string(),
    count: z.number(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    threads: z.array(z.string()),
    muted: z.boolean(),
    mutedUntil: z.string().nullable(),
  })
  .strict();

export const auditInsightRowSchema = z
  .object({
    label: z.string(),
    value: z.number(),
    share: z.number(),
    /** True when this row is concentrated enough to be worth acting on. */
    actionable: z.boolean(),
  })
  .strict();

export const auditInsightFacetSchema = z
  .object({
    facet: z.enum(["cost-by-seat", "cost-by-model", "failures-by-signature"]),
    unit: z.enum(["usd", "count"]),
    rows: z.array(auditInsightRowSchema),
  })
  .strict();

export const auditExportSchema = z
  .object({ content: z.string(), filename: z.string() })
  .strict();

export type AuditSessionRow = z.output<typeof auditSessionRowSchema>;
export type AuditMetric = z.output<typeof auditMetricSchema>;
export type AuditVerification = z.output<typeof auditVerificationSchema>;
export type AuditUnverifiedEdit = z.output<typeof auditUnverifiedEditSchema>;
export type AuditFinding = z.output<typeof auditFindingSchema>;
export type AuditSessionView = z.output<typeof auditSessionSchema>;
export type AuditFailureRow = z.output<typeof auditFailureRowSchema>;
export type AuditInsightRow = z.output<typeof auditInsightRowSchema>;
export type AuditInsightFacet = z.output<typeof auditInsightFacetSchema>;
export type AuditExport = z.output<typeof auditExportSchema>;

/** A session is named by its thread or by the run folder that produced it. */
export const auditTargetSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    runFolder: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.threadId) || Boolean(value.runFolder),
    "one of threadId or runFolder is required",
  );

export const auditContract = defineRpcContract({
  "observatory_audit_sessions": {
    input: z.object({ range: spendRangeSchema }).strict(),
    output: z.object({ rows: z.array(auditSessionRowSchema) }).strict(),
  },
  "observatory_audit_session": {
    input: auditTargetSchema,
    output: auditSessionSchema,
  },
  "observatory_audit_failures": {
    input: z
      .object({ range: spendRangeSchema, includeMuted: z.boolean().optional() })
      .strict(),
    output: z.object({ rows: z.array(auditFailureRowSchema) }).strict(),
  },
  "observatory_audit_failure_mute": {
    input: z
      .object({ signature: z.string().min(1), untilIso: z.string().min(1) })
      .strict(),
    output: z.object({ signature: z.string(), untilIso: z.string() }).strict(),
  },
  "observatory_audit_insights": {
    input: z.object({ range: spendRangeSchema }).strict(),
    output: z.object({ facets: z.array(auditInsightFacetSchema) }).strict(),
  },
  "observatory_audit_export": {
    input: z
      .object({
        threadId: z.string().min(1).optional(),
        runFolder: z.string().min(1).optional(),
        format: z.enum(["json", "md"]),
      })
      .strict(),
    output: auditExportSchema,
  },
  /**
   * The agent tool's result, verbatim.
   *
   * A string rather than the pack object: the point of this method is to make
   * the tool's clamped payload checkable from outside a model turn, and a
   * parsed re-serialization would not be the same bytes.
   */
  "observatory_audit_pack": {
    input: auditTargetSchema,
    output: z.object({ result: z.string() }).strict(),
  },
});
