// Baseline promotion.
//
// PRODUCT.md invariant 5: an eval baseline changes ONLY through
// `bb observatory eval baseline promote <run>`. No run, gate, or cron writes
// `eval_baseline`. That is why promotion lives in its own module with an
// explicit run id argument rather than as a flag on the runner, and why the
// only writing method on `EvalStore` for this table is `promoteBaselineRow`.
//
// A failing trial is never promoted. Promoting a red run would make the next
// gate compare against the failure and call the regression normal, which is
// the one way a baseline can do active harm.
import type { TreeMetrics } from "./metrics.js";
import type { EvalStore } from "./store.js";

export interface PromoteInput {
  store: EvalStore;
  runId: string;
  /** Restrict promotion to these case names; absent promotes every result. */
  cases?: readonly string[];
  promotedAt: string;
}

export interface PromoteReport {
  /** Case names whose baseline moved. */
  promoted: readonly string[];
  /** Case names skipped, each with why. */
  skipped: ReadonlyArray<{ case: string; reason: string }>;
}

function parseMetrics(json: string | null): Partial<TreeMetrics> | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as Partial<TreeMetrics>;
  } catch {
    return null;
  }
}

export function promoteBaseline(input: PromoteInput): PromoteReport {
  const run = input.store.run(input.runId);
  if (run === null) {
    return { promoted: [], skipped: [{ case: "<run>", reason: `no such run: ${input.runId}` }] };
  }
  const wanted = input.cases === undefined ? null : new Set(input.cases);
  const promoted: string[] = [];
  const skipped: Array<{ case: string; reason: string }> = [];

  const byCase = new Map<string, ReturnType<EvalStore["caseResults"]>>();
  for (const row of input.store.caseResults(input.runId)) {
    if (wanted !== null && !wanted.has(row.case)) continue;
    const list = byCase.get(row.case) ?? [];
    list.push(row);
    byCase.set(row.case, list);
  }
  if (byCase.size === 0) {
    return {
      promoted,
      skipped: [{ case: "<run>", reason: `run ${input.runId} recorded no matching results` }],
    };
  }

  for (const [name, trials] of byCase) {
    if (!trials.every((row) => row.status === "pass")) {
      skipped.push({ case: name, reason: "not every trial passed" });
      continue;
    }
    // The WORST passing trial becomes the baseline. Promoting the best one
    // would make the very next run look like a regression against a number
    // the stack only reached once.
    const worst = trials
      .map((row) => parseMetrics(row.metrics_json))
      .filter((entry): entry is Partial<TreeMetrics> => entry !== null)
      .reduce<Partial<TreeMetrics> | null>(
        (acc, entry) =>
          acc === null
            ? entry
            : {
                ...acc,
                tokens: Math.max(acc.tokens ?? 0, entry.tokens ?? 0),
                costUsd: Math.max(acc.costUsd ?? 0, entry.costUsd ?? 0),
                wallMs: Math.max(acc.wallMs ?? 0, entry.wallMs ?? 0),
                turns: Math.max(acc.turns ?? 0, entry.turns ?? 0),
                toolCalls: Math.max(acc.toolCalls ?? 0, entry.toolCalls ?? 0),
              },
        null,
      );
    if (worst === null) {
      skipped.push({ case: name, reason: "the trials recorded no metrics" });
      continue;
    }
    input.store.promoteBaselineRow({
      case: name,
      run_id: input.runId,
      metrics_json: JSON.stringify(worst),
      promoted_at: input.promotedAt,
    });
    promoted.push(name);
  }
  return { promoted, skipped };
}
