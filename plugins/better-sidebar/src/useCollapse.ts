import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { readStore, writeStore } from "./lib/local-store";
import type { SectionKey } from "./model/types";

const SECTIONS_KEY = "collapsed-sections";
// A NEW key on purpose. The stored list flipped meaning from "collapsed" to
// "expanded", and reading an old value under the old key would hand a user
// exactly the inverse of the tree they left.
const THREADS_KEY = "expanded-threads";

/** Ids are opaque strings; anything else in the store is a corrupt value. */
const ID_LIST = z.array(z.string());

export interface CollapseState {
  /** B7: sections the user has folded away. */
  readonly collapsedSections: ReadonlySet<SectionKey>;
  /**
   * B10, inverted: parent rows whose subtree the user has OPENED.
   *
   * A parent is collapsed by default, so the stored set is the exception
   * list rather than the rule. Storing collapsed ids instead would have meant
   * every newly discovered parent arrived open, which is the opposite of the
   * default and unstorable without knowing every id in advance.
   */
  readonly expandedThreadIds: ReadonlySet<string>;
  toggleSection: (key: SectionKey) => void;
  toggleThread: (threadId: string) => void;
}

/**
 * Collapse state, owned by the browser rather than the backend.
 *
 * Which sections a user has folded is a per-device view preference, not shared
 * data, so it lives in `localStorage`: no RPC, no kv table, no realtime
 * channel, and no blank first paint while a round trip resolves. A corrupt or
 * absent stored value reads back as an empty list (`local-store.ts`): no
 * section folded, and every subtree at its default, which is closed.
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
  const expandedThreadIds = useMemo(() => new Set(threads), [threads]);

  return { collapsedSections, expandedThreadIds, toggleSection, toggleThread };
}

function toggle(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

function persist(key: string, next: string[]): string[] {
  writeStore(key, next);
  return next;
}
