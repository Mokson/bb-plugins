import { useCallback, useState } from "react";
import { z } from "zod";
import { readStore, writeStore } from "./lib/local-store";
import type { GroupBy } from "./model/types";

const GROUP_BY_KEY = "group-by";

/** B65's five values. Anything else in the store is a corrupt value. */
const GROUP_BY = z.enum(["date", "project", "host", "status", "none"]).nullable();

export interface GroupByState {
  /** B77.3: the stored value when present, otherwise the `groupBy` setting. */
  readonly groupBy: GroupBy;
  setGroupBy: (value: GroupBy) => void;
}

/**
 * The grouping the list renders with, owned by the browser (B77.2).
 *
 * A plugin cannot write its own settings from the app: `PluginSettingsHandle`
 * exposes `get()` and `onChange()` and no setter, and `PluginSettingsState` is
 * `{values, isLoading}`. The only other route is an RPC to our own server,
 * which would break B60.1's promise that `density: "compact"` performs no
 * backend call. A `localStorage` write costs no request, so the menu writes
 * through the same seam `useCollapse` uses.
 *
 * The setting stays the *default*: it is what a device groups by until its
 * user picks something (B77.3). A stored value outside the five reads back as
 * "nothing stored" (B77.4), matching `parseSettings`' tolerance — a
 * hand-edited store must not blank the sidebar.
 *
 * The choice is per device, because `localStorage` is (B77.5).
 */
export function useGroupBy(fallback: GroupBy): GroupByState {
  const [stored, setStored] = useState<GroupBy | null>(() =>
    readStore(GROUP_BY_KEY, GROUP_BY, null),
  );

  // The write is a side effect, so it happens in the handler rather than
  // inside a state updater, which React is free to invoke more than once.
  const setGroupBy = useCallback((value: GroupBy) => {
    writeStore(GROUP_BY_KEY, value);
    setStored(value);
  }, []);

  return { groupBy: stored ?? fallback, setGroupBy };
}
