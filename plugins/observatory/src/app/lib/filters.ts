// The cost overview's filter state and its precedence rule.
//
// PRODUCT invariant 33: path owns identity, query owns filters, filters
// persist, and the URL wins on conflict. `resolveFilters` is that sentence as
// a pure function, so the rule is testable without a browser and cannot drift
// between the panel route and the thread tab.
//
// Persistence note: `@get-bb/plugin-sdk/app` exposes no app-side storage API
// (`useRpc`, `useSettings`, `useBbContext`, `useBbNavigate` and the component
// exports are the whole surface), so the sticky half lives in `localStorage`
// under one namespaced key - the same technique the absorbed usage strip uses.
import type { SpendGroup, SpendRange } from "../../spend/contract.js";

export const STORAGE_KEY = "bb:observatory:cost:filters";

export const RANGES: readonly SpendRange[] = ["1d", "7d", "30d", "90d"];
export const GROUPS: readonly SpendGroup[] = ["lineage", "model", "day"];

export interface Filters {
  range: SpendRange;
  group: SpendGroup;
  /** Empty string means "every host"; the rpc omits the field entirely. */
  host: string;
  provider: string;
}

export const DEFAULT_FILTERS: Filters = {
  range: "7d",
  group: "lineage",
  host: "",
  provider: "",
};

function asRange(value: string | null | undefined): SpendRange | null {
  return RANGES.find((range) => range === value) ?? null;
}

function asGroup(value: string | null | undefined): SpendGroup | null {
  return GROUPS.find((group) => group === value) ?? null;
}

/**
 * Merge the URL query over the persisted filters over the defaults.
 *
 * An unrecognised query value is treated as absent rather than as an error:
 * a hand-edited or stale deep link should still render the page, and falling
 * through to the stored value is the least surprising repair.
 */
export function resolveFilters(
  query: URLSearchParams,
  stored: Partial<Filters> | null,
): Filters {
  return {
    range:
      asRange(query.get("range")) ??
      asRange(stored?.range) ??
      DEFAULT_FILTERS.range,
    group:
      asGroup(query.get("group")) ??
      asGroup(stored?.group) ??
      DEFAULT_FILTERS.group,
    host: query.get("host") ?? stored?.host ?? DEFAULT_FILTERS.host,
    provider:
      query.get("provider") ?? stored?.provider ?? DEFAULT_FILTERS.provider,
  };
}

/**
 * The filters written back over a query string, every other parameter kept.
 *
 * `resolveFilters` already gave the URL precedence, but nothing ever wrote the
 * URL: selecting `1d` left `?range=7d` in the address bar, so the link a
 * reader copied showed a different slice than the one on screen, and a reload
 * snapped back. Round-tripping is what makes "the URL wins" (PRODUCT invariant
 * 33) true rather than merely stated.
 *
 * A pure function over a search string, so the rule is testable without a
 * browser.
 */
export function filterSearch(filters: Filters, current: string): string {
  const params = new URLSearchParams(current);
  params.set("range", filters.range);
  params.set("group", filters.group);
  // An empty filter means "every value", and `?provider=` reads as a filter
  // that is on and matching nothing. Absent is the honest encoding.
  for (const key of ["host", "provider"] as const) {
    if (filters[key] === "") params.delete(key);
    else params.set(key, filters[key]);
  }
  return params.toString();
}

/**
 * Push the filters into the address bar without touching panel history.
 *
 * `replaceState`, not a navigation: the SDK's `toPluginPanel` carries a
 * subPath and no query, so a filter change cannot push a new address without
 * losing the panel's own history.
 */
export function syncFilterSearch(filters: Filters): void {
  if (typeof window === "undefined") return;
  try {
    const search = filterSearch(filters, window.location.search);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${search}${window.location.hash}`,
    );
  } catch {
    // A sandboxed frame can refuse `replaceState`. The page still works from
    // its in-memory state; only the copyable link is lost.
  }
}

/** Read the persisted filters. A corrupt value is discarded, never thrown. */
export function readStoredFilters(): Partial<Filters> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    return value as Partial<Filters>;
  } catch {
    return null;
  }
}

/** Persist the filters. Storage is an optimisation; failure is not an error. */
export function writeStoredFilters(filters: Filters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Private-mode or quota. The page still works from the in-memory state.
  }
}

/** The rpc input, with the "every host" and "every provider" fields dropped. */
export function overviewInput(filters: Filters): {
  range: SpendRange;
  group: SpendGroup;
  host?: string;
  provider?: string;
} {
  return {
    range: filters.range,
    group: filters.group,
    ...(filters.host === "" ? {} : { host: filters.host }),
    ...(filters.provider === "" ? {} : { provider: filters.provider }),
  };
}
