import { useEffect, useState } from "react";
import { z } from "zod";
import { readStore, writeStore } from "./lib/local-store";
import { parseSettings, type BetterSidebarSettings } from "./settings";

const SETTINGS_KEY = "settings";

/**
 * The host's own value shape. Narrowing to `BetterSidebarSettings` stays with
 * `parseSettings`, so the cache validates exactly what a live answer does and
 * a key this build no longer reads cannot reach the list from the store.
 */
const VALUES_SCHEMA = z.record(z.string(), z.union([z.string(), z.boolean()]));

/**
 * B83. The settings the list renders with, answered from localStorage while
 * the host's own settings request is in flight.
 *
 * Measured on a real load: the first row painted at 1.68s and
 * `/api/v1/plugins/better-sidebar/settings` answered at 10.5s. Until it lands
 * `values` is `undefined`, so every setting reads as its default and a user
 * whose density, grouping, or glyph choices differ watches the list re-lay-out
 * nine seconds in. The previous answer is the right thing to draw meanwhile:
 * settings change when the user edits them, not while a sidebar loads.
 *
 * A live answer always wins, so an edit made in another client still lands.
 */
export function useResolvedSettings(
  values: Record<string, string | boolean> | undefined,
): BetterSidebarSettings {
  // Read once per mount, as `useGroupBy`'s stored value is: the store cannot
  // change under a live tab, and a read per render costs a `JSON.parse` per
  // keystroke in the search field.
  const [cached] = useState(() => readStore(SETTINGS_KEY, VALUES_SCHEMA, undefined));

  useEffect(() => {
    if (values === undefined) return;
    writeStore(SETTINGS_KEY, values);
  }, [values]);

  return parseSettings(values ?? cached);
}
