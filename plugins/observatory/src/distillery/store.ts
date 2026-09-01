// The distillery module's three tables, behind one writer.
//
// The point of the class is the `Redacted` parameter on `insertCorrection`:
// there is no path into `corrections.preview_redacted` that takes a plain
// string, so the redaction invariant is enforced by the type system at every
// call site rather than by remembering to call `redact()` at each of them.
// The runtime assertion behind it exists for the one caller a cast could
// sneak past, and for the test that spies on inserts.
import type { Database, Statement } from "better-sqlite3";
import {
  hasUnredacted,
  parseCounts,
  serializeCounts,
  type Redacted,
} from "./redact.js";
import type {
  ClusterView,
  CorrectionView,
  DraftState,
  DraftView,
  Rung,
  SignalSource,
} from "./contract.js";
import { signalSourceSchema } from "./contract.js";

/** A correction as the scanners produce it, before it has an id. */
export interface CorrectionInput {
  source: SignalSource;
  signature: string;
  causeClass: string | null;
  preview: Redacted;
  runFolder: string | null;
  threadId: string | null;
  /** ISO timestamp of the underlying event. */
  at: string;
  confidence: number;
}

export interface DraftInput {
  id: string;
  clusterId: string;
  state: DraftState;
  homeFile: string | null;
  rung: Rung | null;
  patchUnifiedDiff: string | null;
  ruleText: string | null;
  successSignal: string | null;
  rationale: string | null;
  evidenceIds: readonly number[];
  recurrence: number;
  threadId: string | null;
}

interface CorrectionRow {
  id: number;
  source: string;
  signature: string;
  cause_class: string | null;
  preview_redacted: string;
  redaction_counts: string | null;
  run_folder: string | null;
  thread_id: string | null;
  at: string;
  confidence: number;
  cluster_id: string | null;
}

interface ClusterRow {
  id: string;
  signature: string;
  cause_class: string | null;
  size: number;
  runs: number;
  first_at: string | null;
  last_at: string | null;
  status: string;
}

interface DraftRow {
  id: string;
  cluster_id: string;
  state: string;
  home_file: string | null;
  rung: number | null;
  patch_unified_diff: string | null;
  rule_text: string | null;
  success_signal: string | null;
  rationale: string | null;
  evidence_ids: string | null;
  recurrence: number;
  created_at: string;
  updated_at: string;
  applied_path: string | null;
  thread_id: string | null;
}

function toCorrectionView(row: CorrectionRow): CorrectionView {
  const parsed = signalSourceSchema.safeParse(row.source);
  return {
    id: row.id,
    // A row written by a build whose source has since been renamed is a real
    // shape a reader must survive; falling back keeps that a visible row
    // rather than a failed output validation at the wire.
    source: parsed.success ? parsed.data : "transcript",
    signature: row.signature,
    causeClass: row.cause_class,
    preview: row.preview_redacted,
    redactionCounts: parseCounts(row.redaction_counts) as Record<string, number>,
    runFolder: row.run_folder,
    threadId: row.thread_id,
    at: row.at,
    confidence: row.confidence,
    clusterId: row.cluster_id,
  };
}

function toClusterView(row: ClusterRow): ClusterView {
  return {
    id: row.id,
    signature: row.signature,
    causeClass: row.cause_class,
    size: row.size,
    runs: row.runs,
    firstAt: row.first_at ?? "",
    lastAt: row.last_at ?? "",
    status: row.status,
  };
}

function toDraftView(row: DraftRow): DraftView {
  let evidenceIds: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.evidence_ids ?? "[]");
    if (Array.isArray(parsed)) {
      evidenceIds = parsed.filter((n): n is number => typeof n === "number");
    }
  } catch {
    evidenceIds = [];
  }
  const rung =
    row.rung !== null && row.rung >= 1 && row.rung <= 6
      ? (row.rung as Rung)
      : null;
  return {
    id: row.id,
    clusterId: row.cluster_id,
    state: row.state as DraftState,
    homeFile: row.home_file,
    rung,
    patchUnifiedDiff: row.patch_unified_diff,
    ruleText: row.rule_text,
    successSignal: row.success_signal,
    rationale: row.rationale,
    evidenceIds,
    recurrence: row.recurrence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedPath: row.applied_path,
    threadId: row.thread_id,
  };
}

export class DistilleryStore {
  private readonly insertCorrectionStmt: Statement;
  private readonly upsertClusterStmt: Statement;

  constructor(readonly db: Database) {
    // `OR IGNORE` against `corrections_identity`: re-scanning a ledger must be
    // a no-op, not a duplicate row that inflates a cluster's size and pushes
    // it over the drafting threshold on its own.
    this.insertCorrectionStmt = db.prepare(
      `INSERT OR IGNORE INTO corrections
         (source, signature, cause_class, preview_redacted, redaction_counts,
          run_folder, thread_id, at, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.upsertClusterStmt = db.prepare(
      `INSERT INTO correction_clusters
         (id, signature, cause_class, size, runs, first_at, last_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         signature = excluded.signature,
         cause_class = excluded.cause_class,
         size = excluded.size,
         runs = excluded.runs,
         first_at = excluded.first_at,
         last_at = excluded.last_at`,
    );
  }

  /**
   * Insert one mined correction. Returns its id, or null when the identity
   * index rejected it as already known.
   *
   * The assertion is deliberately a throw and not a silent re-redact: a
   * preview that reached here unmasked means a scanner skipped `redact`, and
   * quietly fixing it would hide the defect while the next scanner repeats it.
   */
  insertCorrection(input: CorrectionInput): number | null {
    if (hasUnredacted(input.preview.text)) {
      throw new Error(
        `[distillery] refusing to store an unredacted preview from ${input.source}`,
      );
    }
    const result = this.insertCorrectionStmt.run(
      input.source,
      input.signature,
      input.causeClass,
      input.preview.text,
      serializeCounts(input.preview.counts),
      input.runFolder,
      input.threadId,
      input.at,
      input.confidence,
    );
    return result.changes === 0 ? null : Number(result.lastInsertRowid);
  }

  corrections(clusterId?: string): CorrectionView[] {
    const rows = clusterId
      ? this.db
          .prepare<[string], CorrectionRow>(
            "SELECT * FROM corrections WHERE cluster_id = ? ORDER BY at",
          )
          .all(clusterId)
      : this.db
          .prepare<[], CorrectionRow>("SELECT * FROM corrections ORDER BY at")
          .all();
    return rows.map(toCorrectionView);
  }

  correctionsByIds(ids: readonly number[]): CorrectionView[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare<number[], CorrectionRow>(
        `SELECT * FROM corrections WHERE id IN (${placeholders}) ORDER BY at`,
      )
      .all(...ids)
      .map(toCorrectionView);
  }

  assignCluster(correctionIds: readonly number[], clusterId: string): void {
    if (correctionIds.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE corrections SET cluster_id = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const id of correctionIds) stmt.run(clusterId, id);
    })();
  }

  upsertCluster(view: Omit<ClusterView, "status"> & { status?: string }): void {
    this.upsertClusterStmt.run(
      view.id,
      view.signature,
      view.causeClass,
      view.size,
      view.runs,
      view.firstAt,
      view.lastAt,
      view.status ?? "open",
    );
  }

  clusters(): ClusterView[] {
    return this.db
      .prepare<[], ClusterRow>(
        "SELECT * FROM correction_clusters ORDER BY size DESC, runs DESC, id",
      )
      .all()
      .map(toClusterView);
  }

  cluster(id: string): ClusterView | null {
    const row = this.db
      .prepare<[string], ClusterRow>(
        "SELECT * FROM correction_clusters WHERE id = ?",
      )
      .get(id);
    return row ? toClusterView(row) : null;
  }

  insertDraft(input: DraftInput, now: string): DraftView {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO drafts
           (id, cluster_id, state, home_file, rung, patch_unified_diff,
            rule_text, success_signal, rationale, evidence_ids, recurrence,
            created_at, updated_at, applied_path, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.clusterId,
        input.state,
        input.homeFile,
        input.rung,
        input.patchUnifiedDiff,
        input.ruleText,
        input.successSignal,
        input.rationale,
        JSON.stringify([...input.evidenceIds]),
        input.recurrence,
        now,
        now,
        input.threadId,
      );
    const draft = this.draft(input.id);
    if (!draft) throw new Error(`[distillery] draft ${input.id} vanished`);
    return draft;
  }

  draft(id: string): DraftView | null {
    const row = this.db
      .prepare<[string], DraftRow>("SELECT * FROM drafts WHERE id = ?")
      .get(id);
    return row ? toDraftView(row) : null;
  }

  drafts(state?: DraftState, limit = 50): DraftView[] {
    const rows = state
      ? this.db
          .prepare<[string, number], DraftRow>(
            "SELECT * FROM drafts WHERE state = ? ORDER BY recurrence DESC, created_at DESC LIMIT ?",
          )
          .all(state, limit)
      : this.db
          .prepare<[number], DraftRow>(
            "SELECT * FROM drafts ORDER BY recurrence DESC, created_at DESC LIMIT ?",
          )
          .all(limit);
    return rows.map(toDraftView);
  }

  draftForCluster(clusterId: string): DraftView | null {
    const row = this.db
      .prepare<[string], DraftRow>(
        "SELECT * FROM drafts WHERE cluster_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(clusterId);
    return row ? toDraftView(row) : null;
  }

  counts(): Record<DraftState, number> {
    const base: Record<DraftState, number> = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      edited: 0,
      applied: 0,
    };
    for (const row of this.db
      .prepare<[], { state: string; n: number }>(
        "SELECT state, COUNT(*) AS n FROM drafts GROUP BY state",
      )
      .all()) {
      if (row.state in base) base[row.state as DraftState] = row.n;
    }
    return base;
  }

  updateDraft(
    id: string,
    patch: Partial<
      Pick<
        DraftView,
        | "state"
        | "homeFile"
        | "rung"
        | "patchUnifiedDiff"
        | "ruleText"
        | "appliedPath"
      >
    >,
    now: string,
  ): DraftView | null {
    const columns: Record<string, string> = {
      state: "state",
      homeFile: "home_file",
      rung: "rung",
      patchUnifiedDiff: "patch_unified_diff",
      ruleText: "rule_text",
      appliedPath: "applied_path",
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return this.draft(id);
    sets.push("updated_at = ?");
    values.push(now, id);
    this.db
      .prepare(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.draft(id);
  }

  snooze(draftId: string, until: string): void {
    this.db
      .prepare(
        `INSERT INTO draft_snoozes (draft_id, until) VALUES (?, ?)
         ON CONFLICT(draft_id) DO UPDATE SET until = excluded.until`,
      )
      .run(draftId, until);
  }

  /** Draft ids whose snooze has not yet expired at `now`. */
  snoozedIds(now: string): Set<string> {
    return new Set(
      this.db
        .prepare<[string], { draft_id: string }>(
          "SELECT draft_id FROM draft_snoozes WHERE until > ?",
        )
        .all(now)
        .map((row) => row.draft_id),
    );
  }
}
