// Three facets, and one question asked of each: is this row concentrated
// enough that changing it would change the bill?
//
// A facet with twenty even rows is a description of normal operation and gets
// no flag. A facet where one row is a quarter of the total is a lever, and the
// flag is what tells the reader which of the three tables to read first.
import type { Database } from "better-sqlite3";
import type { SpendRange } from "../spend/contract.js";
import { rangeStart } from "../spend/rollup.js";
import type { AuditInsightFacet, AuditInsightRow } from "./contract.js";
import { failureRows, type FailuresDeps } from "./failures.js";

/** A row at or above this share of its facet is worth acting on. */
export const ACTIONABLE_SHARE = 0.25;

/** Rows kept per facet. Beyond this the tail is noise on any real range. */
const FACET_ROWS = 10;

function toRows(
  entries: ReadonlyArray<{ label: string; value: number }>,
): AuditInsightRow[] {
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  return entries
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, FACET_ROWS)
    .map((entry) => {
      const share = total > 0 ? entry.value / total : 0;
      return {
        label: entry.label,
        value: entry.value,
        share,
        actionable: share >= ACTIONABLE_SHARE,
      };
    });
}

function costBy(
  db: Database,
  since: string,
  expression: string,
): Array<{ label: string; value: number }> {
  return db
    .prepare<[string], { label: string | null; value: number | null }>(
      `SELECT ${expression} AS label, SUM(t.cost_usd) AS value
         FROM obs_turn AS t
         LEFT JOIN obs_thread AS th ON th.thread_id = t.thread_id
        WHERE COALESCE(t.completed_at, t.started_at, '') >= ?
        GROUP BY label`,
    )
    .all(since)
    .map((row) => ({ label: row.label ?? "unattributed", value: row.value ?? 0 }));
}

export function auditInsights(
  deps: FailuresDeps,
  range: SpendRange,
): AuditInsightFacet[] {
  const now = deps.now?.() ?? new Date();
  const since = rangeStart(range, now.getTime());
  return [
    {
      facet: "cost-by-seat",
      unit: "usd",
      rows: toRows(costBy(deps.db, since, "COALESCE(th.seat, th.title)")),
    },
    {
      facet: "cost-by-model",
      unit: "usd",
      rows: toRows(
        costBy(deps.db, since, "COALESCE(t.model_reported, t.model_requested)"),
      ),
    },
    {
      facet: "failures-by-signature",
      unit: "count",
      rows: toRows(
        failureRows(deps, { range }).map((row) => ({
          label: row.signature,
          value: row.count,
        })),
      ),
    },
  ];
}

export function formatInsights(facets: readonly AuditInsightFacet[]): string {
  const lines: string[] = [];
  for (const facet of facets) {
    lines.push(`${facet.facet} (${facet.unit})`);
    if (facet.rows.length === 0) lines.push("  no rows in range");
    for (const row of facet.rows) {
      const value =
        facet.unit === "usd" ? row.value.toFixed(4) : String(row.value);
      lines.push(
        `  ${value.padStart(10)} ${(row.share * 100)
          .toFixed(1)
          .padStart(6)}%  ${row.actionable ? "*" : " "} ${row.label}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
