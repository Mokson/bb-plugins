// Collapse state over the flat row list the overview rpc returns.
//
// The server owns row order and depth; the panel owns only which subtrees are
// folded. Keeping it that way means the table renders in one pass with no
// recursion, and the same helper serves lineage, model and day grouping
// unchanged - the flat list is already correct for the latter two, where every
// row sits at depth 0 and nothing can collapse.
import type { SpendRow } from "../../spend/contract.js";

/** A row plus what the table needs to draw its disclosure control. */
export interface VisibleRow {
  row: SpendRow;
  /** True when this row has at least one child in the list. */
  hasChildren: boolean;
  /** True when this row is collapsed, so its subtree is hidden. */
  collapsed: boolean;
}

/**
 * Which keys have children, derived from `parentKey` rather than trusted from
 * `childCount`: the server reports `childCount` for a total, and a filtered
 * range can leave a parent whose children fell outside the window.
 */
export function parentKeys(rows: readonly SpendRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.parentKey !== undefined) keys.add(row.parentKey);
  }
  return keys;
}

/**
 * The rows the table draws, in server order, with every descendant of a
 * collapsed row removed.
 *
 * A collapsed row hides its whole subtree, not just its direct children, so
 * folding a thread folds its seats and their groups with it. Depth alone
 * decides that: once a row is hidden, every following row deeper than the
 * collapsed row belongs to it.
 */
export function visibleRows(
  rows: readonly SpendRow[],
  collapsedKeys: ReadonlySet<string>,
): VisibleRow[] {
  const parents = parentKeys(rows);
  const visible: VisibleRow[] = [];
  // The depth of the shallowest currently-folded subtree, or null when none.
  let hiddenBelowDepth: number | null = null;

  for (const row of rows) {
    if (hiddenBelowDepth !== null) {
      if (row.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = null;
    }
    const hasChildren = parents.has(row.key);
    const collapsed = hasChildren && collapsedKeys.has(row.key);
    visible.push({ row, hasChildren, collapsed });
    if (collapsed) hiddenBelowDepth = row.depth;
  }

  return visible;
}

/** Toggle one key, returning a new set so React sees the change. */
export function toggleKey(
  collapsedKeys: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(collapsedKeys);
  if (!next.delete(key)) next.add(key);
  return next;
}
