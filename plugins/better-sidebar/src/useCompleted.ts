import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { readStore, writeStore } from "./lib/local-store";
import { betterSidebarRpcContract, type CompletedEntry } from "./server-contract";

const MIRROR_KEY = "completed-threads";

const MIRROR = z.array(
  z.object({ threadId: z.string(), completedAt: z.number() }),
);

export interface CompletedState {
  /** Thread id → the epoch ms the user filed it at. */
  readonly completedAt: ReadonlyMap<string, number>;
  /** Files the thread, or puts it back. Optimistic; reverts on a failed write. */
  setCompleted: (threadId: string, completed: boolean) => void;
}

/**
 * B86: which threads the user has filed.
 *
 * The truth is server-side, in one `bb.storage.kv` row, so a thread filed on
 * one machine is filed on every bb client the user opens. That is the whole
 * reason this is not `localStorage` like the collapse state next door: collapse
 * is a view preference, and completion is a decision about the work.
 *
 * `localStorage` still holds a MIRROR. The kv read is a round trip, and without
 * the mirror every cold load paints the filed threads in the active list and
 * then drops them out from under the pointer a moment later. The mirror is the
 * first paint; the server's answer replaces it whole the moment it lands.
 */
export function useCompleted(threads: readonly PluginSidebarThread[]): CompletedState {
  const rpc = useRpc<typeof betterSidebarRpcContract>();
  const callRef = useRef(rpc.call);
  callRef.current = rpc.call;

  const [entries, setEntries] = useState<readonly CompletedEntry[]>(() =>
    readStore(MIRROR_KEY, MIRROR, []),
  );

  // One read per mount. There is no realtime channel for this row: the only
  // writer is this same client, and its own writes return the new map.
  useEffect(() => {
    let live = true;
    callRef
      .current("completedThreads", {})
      .then((result) => {
        if (!live) return;
        // Identity matters, not just contents: `completedAt` feeds
        // `sectionKeyOf`, and `useSectionOrder` re-reconciles whenever that
        // predicate's identity changes. A server answer equal to the mirror —
        // the common case, and always the case for a user who has filed
        // nothing — would otherwise reseed every thread's entrance sequence
        // and visibly reshuffle the list one round trip after it painted.
        setEntries((current) =>
          sameEntries(current, result.entries) ? current : persist(result.entries),
        );
      })
      .catch((error: unknown) => {
        // The mirror stays on screen. A failed read must not silently unfile
        // everything the user filed.
        console.warn(`better-sidebar: completedThreads failed: ${String(error)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  const completedAt = useMemo(
    () => new Map(entries.map((entry) => [entry.threadId, entry.completedAt])),
    [entries],
  );

  const setCompleted = useCallback(
    (threadId: string, completed: boolean) => {
      const previous = entries;
      const optimistic = entries.filter((entry) => entry.threadId !== threadId);
      if (completed) optimistic.push({ threadId, completedAt: Date.now() });
      setEntries(persist(optimistic));
      callRef
        .current("setThreadCompleted", { threadId, completed })
        .then((result) =>
          setEntries((current) =>
            sameEntries(current, result.entries) ? current : persist(result.entries),
          ),
        )
        .catch((error: unknown) => {
          // B86.6: the row moves on click and moves back if the write is
          // refused. Awaiting the round trip instead would put a network
          // latency between the click and the row leaving the list.
          setEntries(persist(previous));
          console.warn(
            `better-sidebar: setThreadCompleted failed: ${String(error)}`,
          );
        });
    },
    [entries],
  );

  // B86.2: a filed thread that blocks on the user is not filed any more. This
  // is the ONE auto-reopen: the SDK reports no message authorship, so "the user
  // came back to it" is not observable, and any weaker signal (a background
  // agent writing output) would unfile threads the user deliberately put away.
  useEffect(() => {
    const reopen = threads.filter(
      (thread) =>
        thread.hasPendingInteraction &&
        entries.some((entry) => entry.threadId === thread.id),
    );
    for (const thread of reopen) setCompleted(thread.id, false);
    // `setCompleted` closes over `entries`, so firing more than one of these in
    // a render would drop all but the last. It is rare enough — a filed thread
    // has to newly block — that the next render picks up the rest.
  }, [threads, entries, setCompleted]);

  // B86.7: entries for threads bb no longer reports are dropped. Guarded on a
  // non-empty list: the host reports zero threads while a subscription
  // refreshes, and pruning against that would wipe the whole map.
  useEffect(() => {
    if (threads.length === 0 || entries.length === 0) return;
    const live = new Set(threads.map((thread) => thread.id));
    const kept = entries.filter((entry) => live.has(entry.threadId));
    if (kept.length === entries.length) return;
    setEntries(persist(kept));
    for (const entry of entries) {
      if (live.has(entry.threadId)) continue;
      callRef
        .current("setThreadCompleted", {
          threadId: entry.threadId,
          completed: false,
        })
        .catch((error: unknown) => {
          console.warn(`better-sidebar: prune failed: ${String(error)}`);
        });
    }
  }, [threads, entries]);

  return { completedAt, setCompleted };
}

/**
 * Whether two maps say the same thing. Order-insensitive: the server returns
 * whatever order its row holds, and a reorder is not a change the list can see.
 */
export function sameEntries(
  a: readonly CompletedEntry[],
  b: readonly CompletedEntry[],
): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((entry) => [entry.threadId, entry.completedAt]));
  return b.every((entry) => byId.get(entry.threadId) === entry.completedAt);
}

/** The mirror is written wherever the list is, so the write sits in one place. */
function persist(entries: readonly CompletedEntry[]): readonly CompletedEntry[] {
  writeStore(MIRROR_KEY, entries);
  return entries;
}
