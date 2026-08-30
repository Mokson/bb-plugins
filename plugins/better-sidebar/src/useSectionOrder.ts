import { useMemo, useRef } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { SectionKey, SectionOrder, SectionOrderEntry } from "./model/types";

/**
 * B68.3: the first-mount seed, in the order sequences are HANDED OUT.
 *
 * Sequences ascend and B68.2 renders the highest first, so the thread that must
 * render last is seeded first: oldest `latestAttentionAt`, then oldest
 * `createdAt`, then the larger `id`. Reversed, that is exactly B5's
 * `latestAttentionAt` descending with `id` ascending — the first render is the
 * order B5 produced, and it is total.
 */
function compareSeed(left: PluginSidebarThread, right: PluginSidebarThread): number {
  if (left.latestAttentionAt !== right.latestAttentionAt) {
    return left.latestAttentionAt - right.latestAttentionAt;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * Reconcile every thread against its entrance order (B68).
 *
 * A thread already recorded in the section it is still in keeps its sequence,
 * so it holds its position (B68.1). A thread that arrived, or that moved to a
 * different section, is a new entrant and takes the next sequence, which puts
 * it at the top of its section and moves nothing below it (B68.2). A thread no
 * longer in `threads` simply has no entry written, so returning later is a new
 * entrance (B68.6).
 *
 * `sectionOf` is the LIVE model's own `sectionKeyOf`. This function never
 * decides which section a thread is in; it only records where within one it
 * sits. The deleted freeze shipped a blocker by inverting exactly that.
 *
 * Callers must pass the UNFILTERED thread set (B68.5). Project scope, search
 * and child hiding are presentation: a thread hidden by a filter has not left
 * its section, and re-sequencing it would reshuffle the list when the filter
 * clears.
 */
export function reconcileSectionOrder(
  current: SectionOrder | null,
  threads: readonly PluginSidebarThread[],
  sectionOf: (thread: PluginSidebarThread) => SectionKey,
): SectionOrder {
  const entries = new Map<string, SectionOrderEntry>();
  const entrants: PluginSidebarThread[] = [];
  let nextSequence = current?.nextSequence ?? 0;

  for (const thread of threads) {
    const section = sectionOf(thread);
    const existing = current?.entries.get(thread.id);
    if (existing !== undefined && existing.section === section) {
      entries.set(thread.id, existing);
    } else {
      entrants.push(thread);
    }
  }

  entrants.sort(compareSeed);
  for (const thread of entrants) {
    entries.set(thread.id, { section: sectionOf(thread), sequence: nextSequence });
    nextSequence += 1;
  }

  return { entries, nextSequence };
}

/**
 * B68.4: entrance order as session state.
 *
 * A ref rather than `useState` because reconciliation is a pure function of the
 * previous order and the current threads — deriving it during render keeps the
 * list one render behind nothing, where a state update in an effect would show
 * one stale frame on every thread change. Re-running it on an unchanged input
 * is a no-op, so a double render assigns no second sequence.
 *
 * Nothing here persists. A reload re-seeds from B68.3, which is a defensible
 * order rather than an arbitrary one.
 */
export function useSectionOrder(
  threads: readonly PluginSidebarThread[],
  sectionOf: (thread: PluginSidebarThread) => SectionKey,
): SectionOrder {
  const held = useRef<SectionOrder | null>(null);
  return useMemo(() => {
    held.current = reconcileSectionOrder(held.current, threads, sectionOf);
    return held.current;
  }, [threads, sectionOf]);
}
