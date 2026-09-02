// Reading an eval result row without trusting it.
//
// `assertions` and `metrics` cross the rpc as `unknown` on purpose: the eval
// contract keeps their shape opaque so the engine can grow keys without a wire
// change. That makes every read here defensive - a row written by an older
// build, or a JSON column that no longer parses, renders as absent rather than
// throwing inside a table body.
import type { EvalCaseResultView } from "../../eval/contract.js";

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
