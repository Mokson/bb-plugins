// What a case actually cost, read from the ledger the core module writes.
//
// The numbers come from `obs_turn`, `obs_item` and `obs_thread` rather than
// from the SDK, for one reason: a deliver run is a TREE. The orchestrator's
// own usage is a fraction of the bill, and the subagents it spawns are where
// the tokens go. `root_thread_id` is the only place that tree is already
// joined, so a budget read that ignored it would let a case spend ten times
// its ceiling and report a tenth of it.
//
// Every column is summed with COALESCE: a turn still in flight has null
// tokens, and a budget check must treat that as zero rather than as null.
import type { Database } from "better-sqlite3";

export interface TreeMetrics {
  /** Turns across the spawned thread and every descendant. */
  turns: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  /** Turns whose `error_category` is set; `no_provider_errors` reads this. */
  providerErrors: number;
  /** Threads under the spawned one, excluding it. */
  subthreads: number;
  /** Set by the runner from its own clock, not from the ledger. */
  wallMs: number;
}

interface SumRow {
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
  cost_usd: number | null;
  provider_errors: number | null;
}

export const EMPTY_METRICS: TreeMetrics = {
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  costUsd: 0,
  providerErrors: 0,
  subthreads: 0,
  wallMs: 0,
};

/**
 * Sum one thread tree. `root_thread_id` carries the root for descendants and
 * for the root itself once core has seen it, but a thread whose first turn
 * landed before core resolved the tree still has a null root, so the thread's
 * own id is matched directly as well.
 */
export function treeMetrics(db: Database, threadId: string, wallMs = 0): TreeMetrics {
  const sums = db
    .prepare<[string, string], SumRow>(
      `SELECT COUNT(*)                          AS turns,
              SUM(COALESCE(tool_calls, 0))      AS tool_calls,
              SUM(COALESCE(input_tokens, 0) + COALESCE(cached_input_tokens, 0)
                  + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)
                  + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0))
                                                AS tokens,
              SUM(COALESCE(cost_usd, 0))        AS cost_usd,
              SUM(CASE WHEN error_category IS NOT NULL THEN 1 ELSE 0 END)
                                                AS provider_errors
         FROM obs_turn
        WHERE thread_id = ? OR root_thread_id = ?`,
    )
    .get(threadId, threadId);
  const subthreads = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM obs_thread
        WHERE root_thread_id = ? AND thread_id <> ?`,
    )
    .get(threadId, threadId);
  return {
    turns: sums?.turns ?? 0,
    toolCalls: sums?.tool_calls ?? 0,
    tokens: sums?.tokens ?? 0,
    costUsd: sums?.cost_usd ?? 0,
    providerErrors: sums?.provider_errors ?? 0,
    subthreads: subthreads?.n ?? 0,
    wallMs,
  };
}
