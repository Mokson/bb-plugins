import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { readStore, writeStore } from "./lib/local-store";
import type { SectionKey } from "./model/types";

const SECTIONS_KEY = "collapsed-sections";
const THREADS_KEY = "collapsed-threads";

/** Ids are opaque strings; anything else in the store is a corrupt value. */
const ID_LIST = z.array(z.string());

export interface CollapseState {
  /** B7: sections the user has folded away. */
  readonly collapsedSections: ReadonlySet<SectionKey>;
  /** B10: parent rows whose subtree the user has folded away. */
  readonly collapsedThreadIds: ReadonlySet<string>;
  toggleSection: (key: SectionKey) => void;
  toggleThread: (threadId: string) => void;
}

/**
 * Collapse state, owned by the browser rather than the backend.
 *
 * Which sections a user has folded is a per-device view preference, not shared
 * data, so it lives in `localStorage`: no RPC, no kv table, no realtime
 * channel, and no blank first paint while a round trip resolves. A corrupt or
 * absent stored value reads back as "nothing collapsed" (`local-store.ts`),
 * which is the only failure mode that never hides a thread from the user.
 */
export function useCollapse(): CollapseState {
  const [sections, setSections] = useState<readonly string[]>(() =>
    readStore(SECTIONS_KEY, ID_LIST, []),
  );
  const [threads, setThreads] = useState<readonly string[]>(() =>
    readStore(THREADS_KEY, ID_LIST, []),
  );

  // The write is a side effect, so it happens in the handler rather than inside
  // a state updater, which React is free to invoke more than once.
  const toggleSection = useCallback(
    (key: SectionKey) => setSections(persist(SECTIONS_KEY, toggle(sections, key))),
    [sections],
  );

  const toggleThread = useCallback(
    (threadId: string) => setThreads(persist(THREADS_KEY, toggle(threads, threadId))),
    [threads],
  );

  // SAFETY: `SectionKey` is a union of opaque strings and the set is only ever
  // membership-tested, so a stale key from an older build reads as "not
  // collapsed" rather than mistyping anything the model then trusts.
  const collapsedSections = useMemo(() => new Set(sections) as Set<SectionKey>, [sections]);
  const collapsedThreadIds = useMemo(() => new Set(threads), [threads]);

  return { collapsedSections, collapsedThreadIds, toggleSection, toggleThread };
}

function toggle(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

function persist(key: string, next: string[]): string[] {
  writeStore(key, next);
  return next;
}
