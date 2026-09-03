import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";

/**
 * B87: the state a thread's DESCENDANTS are in, for a thread that is in no
 * state of its own.
 *
 * A parent that dispatched subagents and is waiting on them reports
 * `indicator: "none"` — its own turn ended. The row then drew nothing while
 * seventeen children worked underneath it, so a collapsed parent looked idle
 * and a whole run was invisible.
 *
 * The roll-up is read-only inference over threads the host already sent. It
 * changes what a row DRAWS and nothing else: the section a thread lands in,
 * the bands, and the sort all still read its own indicator, so a parent never
 * migrates between sections because a child started or stopped.
 */

/**
 * Which working indicator wins when several children are busy, lowest first.
 *
 * The order is bb's own "attention before work": a child blocked on the user
 * outranks any amount of work, then the determinate spinner, then the
 * indefinite work kinds, then planning. A child that is merely finished-and-
 * unread contributes nothing — the parent is not working, and saying so with
 * a green dot would claim the PARENT had output the user has not read.
 */
const ROLLUP_RANK: Partial<Record<PluginSidebarThreadIndicator, number>> = {
  goal: 1,
  "plan-mode": 2,
  "background-command": 3,
  "background-agent": 4,
  workflow: 5,
  runtime: 6,
  "waiting-for-input": 7,
};

/** Parent id → its direct children, over the WHOLE thread set. */
export function childrenByParent(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, PluginSidebarThread[]> {
  const byParent = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (!parentId) continue;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(thread);
    else byParent.set(parentId, [thread]);
  }
  return byParent;
}

/**
 * The indicator `thread` should draw on behalf of its descendants, or null when
 * it has nothing to say.
 *
 * Null in three cases, and each matters:
 *
 * - The thread is in a state of its OWN. Its own indicator is the truth and
 *   this function does not override it — "not doing anything" is exactly the
 *   `none` case and nothing else.
 * - No descendant is working.
 * - It has no descendants at all, which is the overwhelming majority of rows.
 *
 * Walks the whole subtree, not just direct children: a subagent that spawns its
 * own subagents is still work happening under this row. The walk is guarded
 * against a `parentThreadId` cycle, which `buildTree` also tolerates.
 */
export function rollUpIndicator(
  thread: PluginSidebarThread,
  childrenOf: ReadonlyMap<string, PluginSidebarThread[]>,
): PluginSidebarThreadIndicator | null {
  if (thread.indicator !== "none") return null;

  let best: PluginSidebarThreadIndicator | null = null;
  let bestRank = 0;
  const seen = new Set<string>([thread.id]);
  const queue = [...(childrenOf.get(thread.id) ?? [])];
  while (queue.length > 0) {
    const child = queue.pop()!;
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    // `hasPendingInteraction` is the same signal B1 hoists a thread on, and it
    // is authoritative even when the indicator has not caught up to it.
    const kind: PluginSidebarThreadIndicator = child.hasPendingInteraction
      ? "waiting-for-input"
      : child.indicator;
    const rank = ROLLUP_RANK[kind] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = kind;
    }
    queue.push(...(childrenOf.get(child.id) ?? []));
  }
  return best;
}

/**
 * The row's aria-label for a rolled-up state. It names the CHILDREN, because a
 * screen reader reading "running" on a row whose own thread is finished is a
 * false statement about that thread.
 */
export function rollUpLabel(indicator: PluginSidebarThreadIndicator): string {
  return indicator === "waiting-for-input"
    ? "A child thread needs you"
    : "Child threads working";
}
