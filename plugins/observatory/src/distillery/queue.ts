// The review queue: the one object CLI, RPC and the agent tool all read.
//
// Everything a surface needs is a method here, so the CLI cannot compute a
// count one way while the panel computes it another. The module's state is
// exactly the three tables plus the config; nothing is cached, because a scan
// on a cron and a person acting in the panel would otherwise race a stale copy.
import type { Database } from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { applyDraft, applyBlockReason } from "./apply.js";
import {
  clusterCorrections,
  topClusters,
  type Cluster,
} from "./cluster.js";
import {
  monthSpendUsd,
  runDraftBatch,
  selectBatch,
  dedupeCorpus,
  type DraftBatchResult,
} from "./draft.js";
import { knownRunFolders, scanAll } from "./signals.js";
import { DistilleryStore } from "./store.js";
import type { DistilleryConfig } from "./settings.js";
import type {
  ClusterView,
  CorrectionView,
  DistillStatus,
  DraftEdit,
  DraftState,
  DraftView,
  ScanCounts,
} from "./contract.js";

export interface QueueRow {
  draft: DraftView;
  cluster: ClusterView | null;
  evidence: CorrectionView[];
}

export interface ActResult {
  draft: DraftView;
  blocked: string | null;
  writtenPath: string | null;
}

export interface DistilleryRuntimeOptions {
  bb: BbPluginApi;
  db: Database;
  config(): DistilleryConfig;
  now?: () => Date;
}

export class DistilleryRuntime {
  readonly store: DistilleryStore;
  private readonly now: () => Date;

  constructor(private readonly options: DistilleryRuntimeOptions) {
    this.store = new DistilleryStore(options.db);
    this.now = options.now ?? (() => new Date());
  }

  runFolders(): string[] {
    return knownRunFolders(this.options.db);
  }

  /**
   * Mine every source, store what is new, and rebuild the clusters.
   *
   * Clusters are recomputed from scratch rather than incrementally updated: a
   * cluster's identity is a hash of its normalized signature, so recomputing
   * is idempotent and an incremental path would only add a way for `size` to
   * drift from the rows it counts.
   */
  scan(runFolder?: string): ScanCounts {
    const folders = runFolder ? [runFolder] : this.runFolders();
    const { corrections, bySource } = scanAll(
      {
        runFolders: folders,
        db: this.options.db,
        now: () => this.now().toISOString(),
      },
      this.options.bb.log,
    );

    let inserted = 0;
    for (const item of corrections) {
      // `insertCorrection` is the redaction chokepoint; a scanner that skipped
      // `redact` throws here rather than writing.
      if (this.store.insertCorrection(item) !== null) inserted += 1;
    }

    const clusters = this.rebuildClusters();
    return {
      bySource,
      scanned: corrections.length,
      inserted,
      clusters: clusters.length,
      qualifying: clusters.filter((cluster) => cluster.qualifies).length,
    };
  }

  /** Recompute clusters over every stored correction and persist them. */
  rebuildClusters(): Cluster[] {
    const clusters = clusterCorrections(this.store.corrections());
    // One transaction for the whole rebuild, not one per cluster: a real scan
    // produces dozens of clusters, and the rebuild is also the only window in
    // which `correction_clusters` disagrees with the rows it counts. Committing
    // once keeps that window closed to any concurrent reader.
    this.options.db.transaction(() => {
      for (const cluster of clusters) {
        this.store.upsertCluster(cluster);
        this.store.assignCluster(
          cluster.members.map((member) => member.id),
          cluster.id,
        );
      }
    })();
    return clusters;
  }

  clusters(): Cluster[] {
    return clusterCorrections(this.store.corrections());
  }

  status(): DistillStatus {
    const counts = this.store.counts();
    const clusters = this.clusters();
    return {
      pending: counts.pending,
      accepted: counts.accepted,
      applied: counts.applied,
      rejected: counts.rejected,
      clusters: clusters.length,
      topClusters: topClusters(clusters),
      monthSpendUsd: monthSpendUsd(this.options.db, this.now()),
      budgetUsd: this.options.config().monthlyBudgetUsd,
    };
  }

  queue(state?: DraftState, limit = 50): QueueRow[] {
    const snoozed = this.store.snoozedIds(this.now().toISOString());
    return this.store
      .drafts(state, limit)
      .filter((draft) => !snoozed.has(draft.id))
      .map((draft) => this.row(draft));
  }

  row(draft: DraftView): QueueRow {
    return {
      draft,
      cluster: this.store.cluster(draft.clusterId),
      evidence: this.store.correctionsByIds(draft.evidenceIds),
    };
  }

  draft(id: string): QueueRow | null {
    const draft = this.store.draft(id);
    return draft ? this.row(draft) : null;
  }

  /** What a draft batch WOULD carry, without spawning anything. */
  pendingBatch(): Cluster[] {
    const config = this.options.config();
    return selectBatch(
      this.clusters(),
      this.store,
      dedupeCorpus(config.improvementsDir, this.runFolders()),
    );
  }

  async draftBatch(): Promise<DraftBatchResult> {
    return runDraftBatch(
      {
        bb: this.options.bb,
        db: this.options.db,
        store: this.store,
        config: this.options.config(),
        runFolders: this.runFolders(),
        now: this.now,
      },
      this.clusters(),
    );
  }

  /**
   * Accept, reject, edit, snooze or apply one draft.
   *
   * A refusal returns the draft UNCHANGED with `blocked` set, rather than
   * throwing: the recurrence cap is a routine outcome a person has to read and
   * act on, not an exceptional condition.
   */
  act(input: {
    id: string;
    action: "accept" | "reject" | "edit" | "snooze" | "apply";
    edit?: DraftEdit;
    snoozeUntil?: string;
  }): ActResult {
    const existing = this.store.draft(input.id);
    if (!existing) throw new Error(`no draft ${input.id}`);
    const iso = this.now().toISOString();

    switch (input.action) {
      case "accept":
        return this.done(
          this.store.updateDraft(input.id, { state: "accepted" }, iso),
        );

      case "reject":
        return this.done(
          this.store.updateDraft(input.id, { state: "rejected" }, iso),
        );

      case "snooze": {
        // Snooze does not touch `state`: a snoozed draft is still pending, it
        // is only hidden until its date.
        this.store.snooze(
          input.id,
          input.snoozeUntil ?? this.inDays(7).toISOString(),
        );
        return this.done(existing);
      }

      case "edit": {
        const edit = input.edit ?? {};
        return this.done(
          this.store.updateDraft(
            input.id,
            {
              state: "edited",
              ...(edit.rule_text !== undefined
                ? { ruleText: edit.rule_text }
                : {}),
              ...(edit.patch_unified_diff !== undefined
                ? { patchUnifiedDiff: edit.patch_unified_diff }
                : {}),
              ...(edit.home_file !== undefined
                ? { homeFile: edit.home_file }
                : {}),
              ...(edit.rung !== undefined ? { rung: edit.rung } : {}),
            },
            iso,
          ),
        );
      }

      case "apply": {
        const blocked = applyBlockReason(existing);
        if (blocked) {
          return { draft: existing, blocked, writtenPath: null };
        }
        const config = this.options.config();
        const result = applyDraft(
          {
            improvementsDir: config.improvementsDir,
            appendFindings: config.appendFindings,
            now: this.now,
          },
          existing,
          this.store.cluster(existing.clusterId),
          this.store.correctionsByIds(existing.evidenceIds),
        );
        if (result.blocked || !result.writtenPath) {
          return {
            draft: existing,
            blocked: result.blocked,
            writtenPath: null,
          };
        }
        const updated = this.store.updateDraft(
          input.id,
          { state: "applied", appliedPath: result.writtenPath },
          iso,
        );
        return {
          draft: updated ?? existing,
          blocked: null,
          writtenPath: result.writtenPath,
        };
      }
    }
  }

  private done(draft: DraftView | null): ActResult {
    if (!draft) throw new Error("draft vanished mid-update");
    return { draft, blocked: null, writtenPath: null };
  }

  private inDays(days: number): Date {
    return new Date(this.now().getTime() + days * 24 * 60 * 60 * 1000);
  }
}

export interface DistilleryHandle {
  current: DistilleryRuntime | null;
}
