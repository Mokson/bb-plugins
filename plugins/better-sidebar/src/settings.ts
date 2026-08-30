import type { BetterSidebarSettings } from "./model/types";

export type { BetterSidebarSettings };

const GROUP_BY_VALUES: readonly string[] = [
  "date",
  "project",
  "host",
  "status",
  "none",
];
const DENSITY_VALUES: readonly string[] = ["compact", "default", "detailed"];

export const SETTINGS_DEFAULTS: BetterSidebarSettings = {
  groupBy: "date",
  density: "default",
  showPrChip: true,
  showProviderGlyph: true,
  showRelativeTime: true,
  showArchivedChildren: true,
  showHeaderChip: true,
};

/**
 * Narrows the SDK's untyped `Record<string, string | boolean> | undefined`
 * settings values to `BetterSidebarSettings`. An absent value, a value of the
 * wrong type, or an unrecognized enum member all fall back to the default
 * (B59.2) — a future settings option added server-side must degrade, never
 * crash. B59 removed `secondRow` and `tooltip`; their stored values orphan
 * here, because a key this function does not read cannot reach the list.
 */
export function parseSettings(
  values: Record<string, string | boolean> | undefined,
): BetterSidebarSettings {
  return {
    groupBy: pick(values?.groupBy, GROUP_BY_VALUES, SETTINGS_DEFAULTS.groupBy),
    density: pick(values?.density, DENSITY_VALUES, SETTINGS_DEFAULTS.density),
    showPrChip: flag(values?.showPrChip, SETTINGS_DEFAULTS.showPrChip),
    showProviderGlyph: flag(
      values?.showProviderGlyph,
      SETTINGS_DEFAULTS.showProviderGlyph,
    ),
    showRelativeTime: flag(
      values?.showRelativeTime,
      SETTINGS_DEFAULTS.showRelativeTime,
    ),
    showArchivedChildren: flag(
      values?.showArchivedChildren,
      SETTINGS_DEFAULTS.showArchivedChildren,
    ),
    showHeaderChip: flag(values?.showHeaderChip, SETTINGS_DEFAULTS.showHeaderChip),
  };
}

function pick<T extends string>(
  value: string | boolean | undefined,
  allowed: readonly string[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}

/**
 * The host stores a boolean setting as a boolean, but the settings route and
 * the CLI both carry values as text, so `"true"` and `"false"` read through
 * rather than falling back to a default the user did not choose.
 */
function flag(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
