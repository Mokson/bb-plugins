// Reads and writes over the three eval tables.
//
// Statements are inline rather than prepared at construction: eval writes
// once per run, not once per turn, so the ingest path's prepare-once
// discipline would buy nothing and cost a class.
//
// `case` is a SQL keyword, so every reference to that column is quoted.
import type { Database } from "better-sqlite3";

export interface EvalRunRow {
  id: string;
  started_at: string | null;
  finished_at: string | null;
  tag: string | null;
  stack_sha: string | null;
  cases_json: string | null;
  status: string | null;
  gate: string | null;
}

export interface EvalCaseResultRow {
  run_id: string;
  case: string;
  trial: number;
  status: string | null;
  assertions_json: string | null;
  metrics_json: string | null;
  thread_id: string | null;
  artifacts_dir: string | null;
}

export interface EvalBaselineRow {
  case: string;
  run_id: string | null;
  metrics_json: string | null;
  promoted_at: string | null;
}

export class EvalStore {
  constructor(readonly db: Database) {}

  /** Insert a run. Replaces on id so a re-run of the same id is not a crash. */
  insertRun(row: EvalRunRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_run
           (id, started_at, finished_at, tag, stack_sha, cases_json, status, gate)
         VALUES (@id, @started_at, @finished_at, @tag, @stack_sha, @cases_json,
                 @status, @gate)`,
      )
      .run(row);
  }

  run(runId: string): EvalRunRow | null {
    return (
      this.db
        .prepare<[string], EvalRunRow>("SELECT * FROM eval_run WHERE id = ?")
        .get(runId) ?? null
    );
  }

  /** Newest first: the question is almost always "what happened last". */
  runs(limit: number): EvalRunRow[] {
    return this.db
      .prepare<[number], EvalRunRow>(
        "SELECT * FROM eval_run ORDER BY started_at DESC, id DESC LIMIT ?",
      )
      .all(limit);
  }

  upsertCaseResult(row: EvalCaseResultRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_case_result
           (run_id, "case", trial, status, assertions_json, metrics_json,
            thread_id, artifacts_dir)
         VALUES (@run_id, @case, @trial, @status, @assertions_json,
                 @metrics_json, @thread_id, @artifacts_dir)`,
      )
      .run(row);
  }

  caseResults(runId: string): EvalCaseResultRow[] {
    return this.db
      .prepare<[string], EvalCaseResultRow>(
        `SELECT run_id, "case" AS "case", trial, status, assertions_json,
                metrics_json, thread_id, artifacts_dir
           FROM eval_case_result WHERE run_id = ? ORDER BY "case", trial`,
      )
      .all(runId);
  }

  /**
   * The newest result per case, used to annotate `eval list`. Ordered by the
   * RUN's start rather than the result's, because a result carries no clock.
   */
  latestResultPerCase(): Map<string, EvalCaseResultRow> {
    const rows = this.db
      .prepare<[], EvalCaseResultRow>(
        `SELECT r.run_id, r."case" AS "case", r.trial, r.status,
                r.assertions_json, r.metrics_json, r.thread_id, r.artifacts_dir
           FROM eval_case_result r
           JOIN eval_run u ON u.id = r.run_id
          ORDER BY u.started_at ASC, r.trial ASC`,
      )
      .all();
    // Last write wins, and the scan is oldest-first, so the map ends holding
    // the newest row per case.
    return new Map(rows.map((row) => [row.case, row]));
  }

  /** Move a run to its final state without rewriting the columns it froze. */
  finishRun(runId: string, finishedAt: string, status: string, gate: string | null): void {
    this.db
      .prepare("UPDATE eval_run SET finished_at = ?, status = ?, gate = ? WHERE id = ?")
      .run(finishedAt, status, gate, runId);
  }

  /** Mark a run cancelled. An in-flight runner reads this between sweeps. */
  cancelRun(runId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE eval_run SET status = 'cancelled', finished_at = ? WHERE id = ?",
      )
      .run(at, runId);
  }

  /**
   * Whether this plugin spawned the thread. The stop guard reads this rather
   * than a process-local set, so a cancel from a later process is bound by
   * the same ownership record. PRODUCT.md invariant 1.
   */
  ownsThread(threadId: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM eval_case_result WHERE thread_id = ?",
      )
      .get(threadId);
    return (row?.n ?? 0) > 0;
  }

  /** Every thread a run spawned, in case order. `eval cancel` stops these. */
  runThreadIds(runId: string): string[] {
    return this.db
      .prepare<[string], { thread_id: string }>(
        `SELECT thread_id FROM eval_case_result
          WHERE run_id = ? AND thread_id IS NOT NULL ORDER BY "case", trial`,
      )
      .all(runId)
      .map((row) => row.thread_id);
  }

  /**
   * The ONLY write to `eval_baseline` in the plugin. It is named for its
   * caller so that a grep for baseline writes lands on `baseline.ts` and
   * nowhere else.
   */
  promoteBaselineRow(row: EvalBaselineRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO eval_baseline ("case", run_id, metrics_json, promoted_at)
         VALUES (@case, @run_id, @metrics_json, @promoted_at)`,
      )
      .run(row);
  }

  baselines(): Map<string, EvalBaselineRow> {
    const rows = this.db
      .prepare<[], EvalBaselineRow>(
        `SELECT "case" AS "case", run_id, metrics_json, promoted_at
           FROM eval_baseline`,
      )
      .all();
    return new Map(rows.map((row) => [row.case, row]));
  }
}
