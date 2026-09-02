// The distillery module's wire contract.
//
// Panel, CLI and the agent tool render the SAME objects, the way
// `observatory_status` and the watch module already do, so a queue the CLI
// prints and a queue the panel shows cannot drift.
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/**
 * Where a correction came from, ordered by precision: a ledger nudge is
 * pre-tagged by a human at the moment of the failure, a transcript inference
 * is a guess from rules. The order is load-bearing — `confidence` defaults
 * and the queue's ranking both read it — so append rather than reorder.
 */
export const SIGNAL_SOURCES = [
  "ledger-nudge",
  "ledger-gate",
  "ledger-decision",
  "review-finding",
  "qa-fail",
  "retro-candidate",
  "retro-finding",
  "obs-signal",
  "transcript",
] as const;

export const signalSourceSchema = z.enum(SIGNAL_SOURCES);
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/**
 * The retro taxonomy (retro skill `references/schema.md`). Ledger nudges
 * arrive pre-tagged, so this is a VALIDATION list, not a parsing one.
 *
 * Real ledgers carry tags outside it (see `normalizeCauseClass`), which is
 * why `cause_class` is stored as free text and this list only decides whether
 * a tag is canonical.
 */
export const CAUSE_CLASSES = [
  "shaped-wrong",
  "built-wrong",
  "verified-wrong",
  "env-friction",
  "instruction-miss",
  "agent-skip",
  "tooling-gap",
  "platform-drift",
  "over-verification",
  "discovery-cost",
  "over-production",
] as const;

export type CauseClass = (typeof CAUSE_CLASSES)[number];

export function isCanonicalCauseClass(value: string): value is CauseClass {
  return (CAUSE_CLASSES as readonly string[]).includes(value);
}

/** Draft lifecycle. Mirrors the `drafts.state` CHECK constraint exactly. */
export const DRAFT_STATES = [
  "pending",
  "accepted",
  "rejected",
  "edited",
  "applied",
] as const;

export const draftStateSchema = z.enum(DRAFT_STATES);
export type DraftState = (typeof DRAFT_STATES)[number];

/**
 * The gc.md mechanism ladder, 1..6, as the DRAFT stores it.
 *
 * gc.md numbers them 2.1 through 2.6 and orders them weakest-carrier-first
 * (prose is 2.1). Distillery inverts nothing: rung 1 IS prose, and the
 * recurrence cap in `apply.ts` reads exactly that. Keeping the spec's own
 * numbering means a draft's rung can be cited straight into a gc pass.
 */
export const RUNGS = {
  1: "harness text (craft.md rule or route/reference edit)",
  2: "skill fix in the bundle source",
  3: "repo lint, check, or CI rule whose message instructs the agent",
  4: "template or packet change in handoffs.md",
  5: "check in scripts/verify-stack.sh",
  6: "repo ops binding, a persisted operations line",
} as const;

export const rungSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type Rung = z.output<typeof rungSchema>;

/** The weakest rung. gc.md 3a forbids re-adopting a recurring row here. */
export const PROSE_RUNG: Rung = 1;

export const correctionViewSchema = z
  .object({
    id: z.number(),
    source: signalSourceSchema,
    signature: z.string(),
    causeClass: z.string().nullable(),
    /** Already redacted. There is no unredacted field on this wire. */
    preview: z.string(),
    redactionCounts: z.record(z.string(), z.number()),
    runFolder: z.string().nullable(),
    threadId: z.string().nullable(),
    at: z.string(),
    confidence: z.number(),
    clusterId: z.string().nullable(),
  })
  .strict();

export const clusterViewSchema = z
  .object({
    id: z.string(),
    signature: z.string(),
    causeClass: z.string().nullable(),
    size: z.number(),
    /** Distinct run folders. The second half of the drafting threshold. */
    runs: z.number(),
    firstAt: z.string(),
    lastAt: z.string(),
    status: z.string(),
  })
  .strict();

export const draftViewSchema = z
  .object({
    id: z.string(),
    clusterId: z.string(),
    state: draftStateSchema,
    homeFile: z.string().nullable(),
    rung: rungSchema.nullable(),
    patchUnifiedDiff: z.string().nullable(),
    ruleText: z.string().nullable(),
    successSignal: z.string().nullable(),
    rationale: z.string().nullable(),
    evidenceIds: z.array(z.number()),
    recurrence: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    appliedPath: z.string().nullable(),
    threadId: z.string().nullable(),
  })
  .strict();

export const topClusterSchema = z
  .object({
    signature: z.string(),
    cause_class: z.string().nullable(),
    size: z.number(),
    runs: z.number(),
  })
  .strict();

export type CorrectionView = z.output<typeof correctionViewSchema>;
export type ClusterView = z.output<typeof clusterViewSchema>;
export type DraftView = z.output<typeof draftViewSchema>;
export type TopCluster = z.output<typeof topClusterSchema>;

export const distillStatusSchema = z
  .object({
    pending: z.number(),
    accepted: z.number(),
    applied: z.number(),
    rejected: z.number(),
    clusters: z.number(),
    topClusters: z.array(topClusterSchema),
    /** Spend by this month's `[distillery]` drafting threads. */
    monthSpendUsd: z.number(),
    budgetUsd: z.number(),
  })
  .strict();

export type DistillStatus = z.output<typeof distillStatusSchema>;

export const draftEditSchema = z
  .object({
    rule_text: z.string().optional(),
    patch_unified_diff: z.string().optional(),
    home_file: z.string().optional(),
    rung: rungSchema.optional(),
  })
  .strict();

export type DraftEdit = z.output<typeof draftEditSchema>;

export const distillActionSchema = z.enum([
  "accept",
  "reject",
  "edit",
  "snooze",
  "apply",
]);
export type DistillAction = z.output<typeof distillActionSchema>;

export const scanCountsSchema = z
  .object({
    /** New corrections per source. Sources that found nothing are absent. */
    bySource: z.partialRecord(signalSourceSchema, z.number()),
    scanned: z.number(),
    inserted: z.number(),
    clusters: z.number(),
    /** Clusters at or over the drafting threshold. */
    qualifying: z.number(),
  })
  .strict();

export type ScanCounts = z.output<typeof scanCountsSchema>;

export const distilleryContract = defineRpcContract({
  "observatory_distill_status": {
    input: z.object({}).strict(),
    output: distillStatusSchema,
  },
  "observatory_distill_queue": {
    input: z
      .object({
        state: draftStateSchema.optional(),
        limit: z.number().int().positive().max(200).optional(),
      })
      .strict(),
    output: z
      .object({
        rows: z.array(
          z
            .object({
              draft: draftViewSchema,
              cluster: clusterViewSchema.nullable(),
              /** Redacted previews of the cited evidence. */
              evidence: z.array(correctionViewSchema),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  "observatory_distill_draft": {
    input: z.object({ id: z.string() }).strict(),
    output: z
      .object({
        draft: draftViewSchema,
        cluster: clusterViewSchema.nullable(),
        evidence: z.array(correctionViewSchema),
      })
      .strict(),
  },
  "observatory_distill_act": {
    input: z
      .object({
        id: z.string(),
        action: distillActionSchema,
        edit: draftEditSchema.optional(),
        snoozeUntil: z.string().optional(),
      })
      .strict(),
    output: z
      .object({
        draft: draftViewSchema,
        /** Set when the action was refused; the draft is then unchanged. */
        blocked: z.string().nullable(),
        writtenPath: z.string().nullable(),
      })
      .strict(),
  },
  "observatory_distill_scan": {
    input: z.object({ runFolder: z.string().optional() }).strict(),
    output: scanCountsSchema,
  },
  "observatory_distill_draft_batch": {
    input: z.object({}).strict(),
    output: z
      .object({
        threadId: z.string().nullable(),
        clusters: z.array(z.string()),
        /** Set when no batch was spawned, naming why. */
        skipped: z.string().nullable(),
      })
      .strict(),
  },
});
