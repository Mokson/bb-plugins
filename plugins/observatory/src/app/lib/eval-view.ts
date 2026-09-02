// Reading an eval result row without trusting it.
//
// `assertions` and `metrics` cross the rpc as `unknown` on purpose: the eval
// contract keeps their shape opaque so the engine can grow keys without a wire
// change. That makes every read here defensive - a row written by an older
// build, or a JSON column that no longer parses, renders as absent rather than
// throwing inside a table body.
import type {
  EvalBaselineView,
  EvalCaseResultView,
} from "../../eval/contract.js";
// The gate's own thresholds, imported rather than restated: a page that drew
// its WARN marks at a different number than the gate would be a second, wrong
// answer to "is this a regression". `gate.ts` is type-only in its own imports,
// so nothing node-shaped follows it into the panel bundle.
import { DRIFT } from "../../eval/gate.js";

/**
 * A status or gate value as its display word.
 *
 * The store writes trial statuses (`pass`, `fail`) and the gate writes its own
 * verdicts (`pass`, `warn`, `fail`, `not-run`); both land in the same columns,
 * so one mapping serves both. An unknown value keeps its own text uppercased
 * rather than being flattened into a word it does not mean.
 */
export function verdictWord(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "--";
  const normalised = value.toLowerCase();
  if (normalised === "pass") return "PASS";
  if (normalised === "warn") return "WARN";
  if (normalised === "fail") return "FAIL";
  if (normalised === "not-run" || normalised === "n/a" || normalised === "na") {
    return "N-A";
  }
  return value.toUpperCase();
}

/** One assertion the engine evaluated and did not pass. */
export interface AssertionFailureView {
  key: string;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The assertions that did NOT pass, in the order the engine recorded them.
 *
 * Only failures: a passing case would otherwise bury its one red key under a
 * dozen green ones, and the page is read to find what broke.
 */
export function failedAssertions(assertions: unknown): AssertionFailureView[] {
  if (!isRecord(assertions)) return [];
  const outcomes = assertions["outcomes"];
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((entry): AssertionFailureView[] => {
    if (!isRecord(entry)) return [];
    if (entry["pass"] === true) return [];
    const key = typeof entry["key"] === "string" ? entry["key"] : "assertion";
    const detail = typeof entry["detail"] === "string" ? entry["detail"] : "";
    return [{ key, detail }];
  });
}

/** The metric fields a run page shows. Every one may be absent. */
export interface CaseMetricsView {
  tokens: number | null;
  costUsd: number | null;
  wallMs: number | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read one result's metrics blob. A missing or malformed blob is all nulls. */
export function readMetrics(metrics: unknown): CaseMetricsView {
  if (!isRecord(metrics)) return { tokens: null, costUsd: null, wallMs: null };
  return {
    tokens: num(metrics["tokens"]),
    costUsd: num(metrics["costUsd"]),
    wallMs: num(metrics["wallMs"]),
  };
}

/** One metric measured against its baseline. */
export interface MetricDeltaView {
  /** Fractional growth over the baseline. Negative means it got cheaper. */
  growth: number;
  /** True when the growth clears the gate's WARN threshold for this metric. */
  warn: boolean;
}

/** A case's three metrics against baseline. A field is null when either side is. */
export interface BaselineDeltaView {
  tokens: MetricDeltaView | null;
  costUsd: MetricDeltaView | null;
  wallMs: MetricDeltaView | null;
}

function delta(
  now: number | null,
  before: number | null,
  allowed: number,
): MetricDeltaView | null {
  // A zero or negative baseline has no growth to express: dividing by it would
  // print an infinity, which reads as a regression it is not.
  if (now === null || before === null || before <= 0) return null;
  const growth = (now - before) / before;
  return { growth, warn: growth > allowed };
}

/**
 * The baselines a run page compares against, keyed by case name.
 *
 * Built once per render rather than scanned per row, and returned as a Map so
 * a case with no promoted baseline is a plain miss rather than a special row.
 */
export function baselineMetrics(
  view: EvalBaselineView | null,
): Map<string, CaseMetricsView> {
  const byCase = new Map<string, CaseMetricsView>();
  for (const entry of view?.cases ?? []) {
    byCase.set(entry.case, readMetrics(entry.metrics));
  }
  return byCase;
}

function worst(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * The WORST trial's figure per metric, which is what a baseline holds.
 *
 * `promoteBaseline` promotes the worst passing trial, so comparing the best
 * trial of this run against it would flatter the run: the delta must be
 * measured the same way the number it is measured against was chosen.
 */
export function worstMetrics(
  trials: readonly EvalCaseResultView[],
): CaseMetricsView {
  return trials.reduce<CaseMetricsView>(
    (acc, row) => {
      const metrics = readMetrics(row.metrics);
      return {
        tokens: worst(acc.tokens, metrics.tokens),
        costUsd: worst(acc.costUsd, metrics.costUsd),
        wallMs: worst(acc.wallMs, metrics.wallMs),
      };
    },
    { tokens: null, costUsd: null, wallMs: null },
  );
}

/**
 * Compare one case's metrics against its baseline.
 *
 * The thresholds are the gate's `DRIFT`, so a row the page marks WARN is
 * exactly a row `bb observatory eval gate` would have warned about.
 */
export function baselineDelta(
  now: CaseMetricsView,
  before: CaseMetricsView | undefined,
): BaselineDeltaView {
  if (before === undefined) {
    return { tokens: null, costUsd: null, wallMs: null };
  }
  return {
    tokens: delta(now.tokens, before.tokens, DRIFT.tokens),
    costUsd: delta(now.costUsd, before.costUsd, DRIFT.cost),
    wallMs: delta(now.wallMs, before.wallMs, DRIFT.wall),
  };
}

/**
 * A growth fraction as a signed percentage, e.g. `+75%`.
 *
 * Rounded to whole points: the gate's thresholds are coarse and a decimal here
 * would suggest a precision the two-or-three-trial sample does not have.
 */
export function growthLabel(metric: MetricDeltaView | null): string {
  if (metric === null) return "--";
  const points = Math.round(metric.growth * 100);
  return `${points > 0 ? "+" : ""}${points}%`;
}

/** Sum a run's cost across every recorded trial. Null when none recorded. */
export function totalCostUsd(results: readonly EvalCaseResultView[]): number | null {
  let total: number | null = null;
  for (const row of results) {
    const cost = readMetrics(row.metrics).costUsd;
    if (cost === null) continue;
    total = (total ?? 0) + cost;
  }
  return total;
}

/** Elapsed wall clock between two stamps. Null unless both parse. */
export function elapsedMs(
  startedAt: string | null,
  finishedAt: string | null,
): number | null {
  if (startedAt === null || finishedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/** Case names in the order a run page should list them. */
export function runCaseOrder(
  cases: readonly string[],
  results: readonly EvalCaseResultView[],
): string[] {
  // The run's frozen list leads, because a case selected at run time that
  // produced no row at all is the failure a reader most needs to see. Names
  // that only appear in the results follow, so nothing is dropped.
  const order = [...cases];
  for (const row of results) {
    if (!order.includes(row.case)) order.push(row.case);
  }
  return order;
}
