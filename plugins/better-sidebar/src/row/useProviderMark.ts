import { useEffect } from "react";
import { experimental_useProviders as useProviders } from "@get-bb/plugin-sdk/app";
import { cacheMarks, cachedMarks, type ProviderMark } from "./provider-cache";

export interface ProviderMarkState {
  /** The mark to draw, or null when no answer — live or cached — names this provider. */
  mark: ProviderMark | null;
  /** `loading` only while nothing is known; a cache hit reads as `ready`. */
  status: "error" | "loading" | "ready";
}

/**
 * One row's provider mark, answered from localStorage while the host's own
 * directory is still in flight.
 *
 * B80 measured `GET /api/v1/system/providers` at 5.97s on a real reload, and
 * withheld the mark for that whole window rather than drawing a wrong one. The
 * directory is near-static — providers change when one is installed, not while
 * a sidebar is open — so the previous answer is the right thing to draw
 * meanwhile. `logoUrl` is server-relative and provider ids are stable, so a
 * cached entry stays addressable across reloads; the logo bytes behind it come
 * from the browser's own HTTP cache.
 *
 * A live answer always wins over the cache, so an uninstalled provider stops
 * drawing the moment the host says so.
 */
export function useProviderMark(providerId: string): ProviderMarkState {
  const { providers, status } = useProviders();

  useEffect(() => {
    if (status !== "ready") return;
    cacheMarks(
      providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        logoUrl: provider.logoUrl,
        iconTint: provider.strings?.iconTint,
      })),
    );
  }, [providers, status]);

  if (status === "ready") {
    const live = providers.find((provider) => provider.id === providerId);
    return {
      mark:
        live === undefined
          ? null
          : {
              id: live.id,
              displayName: live.displayName,
              logoUrl: live.logoUrl,
              iconTint: live.strings?.iconTint,
            },
      status: "ready",
    };
  }

  // `error` falls through here too: a directory that will never answer still
  // has last run's marks to draw, which beats a dot on every row.
  const cached = cachedMarks().find((entry) => entry.id === providerId);
  return cached === undefined ? { mark: null, status } : { mark: cached, status: "ready" };
}
