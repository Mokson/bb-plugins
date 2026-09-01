// How the attention inbox orders and words its rows.
//
// PRODUCT invariant 25: the inbox ranks open signals across modules with one
// evidence line each and is the panel's landing page. Ranking and wording are
// pure functions here rather than JSX in the page, so the rule is testable
// without a browser and cannot drift between the panel and any later surface
// that reproduces the list.
import type { InboxAction, InboxRow, WatchSeverity } from "../../watch/contract.js";

/** Highest first. The inbox's whole job is to put the worst row on top. */
const SEVERITY_RANK: Record<WatchSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/**
 * Which actions phase 2 can actually perform.
 *
 * `steer` and `escalate` are the steer ladder (PRODUCT invariant 22), which
 * lands in phase 3. They render, disabled, rather than being hidden: a reader
 * who can see the rung exists learns the shape of the tool, and a row whose
 * buttons appear later moves under the cursor.
 */
export const ENABLED_ACTIONS: readonly InboxAction[] = ["open", "review"];

/** The tooltip a disabled ladder action carries. */
export const LADDER_TOOLTIP = "steer ladder arrives in phase 3";

export function isActionEnabled(action: InboxAction): boolean {
  return ENABLED_ACTIONS.includes(action);
}

/**
 * The inbox order: severity first, then oldest first inside a severity.
 *
 * Oldest first, not newest: a signal that has been open for an hour is the one
 * the reader has been failing to answer. Ties break on `id` so the order is
 * total and a re-render never reshuffles equal rows under the cursor.
 */
export function rankInboxRows(rows: readonly InboxRow[]): InboxRow[] {
  return [...rows].sort((left, right) => {
    const bySeverity =
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    if (left.openedAt !== right.openedAt) {
      return left.openedAt < right.openedAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * The middle column: `<source> <kind>`, lower case, no punctuation.
 *
 * The source is repeated into the phrase because a reader scanning the column
 * needs to know a `stalled` came from watch and an `over-budget` from spend
 * without matching it back to another column.
 */
export function statusPhrase(row: InboxRow): string {
  return `${row.source} ${row.kind}`.toLowerCase();
}

/**
 * Whether the filter box keeps a row.
 *
 * A plain case-insensitive substring over the text the reader can actually
 * see. No query language: the list is short, and a language the user must
 * learn to filter twelve rows is a worse tool than scrolling.
 */
export function matchesFilter(row: InboxRow, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return [row.title, row.subtitle, statusPhrase(row), row.threadId ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
