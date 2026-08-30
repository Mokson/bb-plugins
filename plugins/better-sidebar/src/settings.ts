export interface BetterSidebarSettings {
  groupBy: "date" | "project" | "none";
  secondRow: "auto" | "always" | "never";
  tooltip: "rich" | "minimal" | "off";
}

const GROUP_BY_VALUES: readonly string[] = ["date", "project", "none"];
const SECOND_ROW_VALUES: readonly string[] = ["auto", "always", "never"];
const TOOLTIP_VALUES: readonly string[] = ["rich", "minimal", "off"];

const DEFAULTS: BetterSidebarSettings = {
  groupBy: "date",
  secondRow: "auto",
  tooltip: "rich",
};

/**
 * Narrows the SDK's untyped `Record<string, string | boolean> | undefined`
 * settings values to `BetterSidebarSettings`. An absent value, a value of the
 * wrong type, or an unrecognized enum member all fall back to the default —
 * a future settings option added server-side must degrade, never crash.
 */
export function parseSettings(
  values: Record<string, string | boolean> | undefined,
): BetterSidebarSettings {
  return {
    groupBy: pick(values?.groupBy, GROUP_BY_VALUES, DEFAULTS.groupBy),
    secondRow: pick(values?.secondRow, SECOND_ROW_VALUES, DEFAULTS.secondRow),
    tooltip: pick(values?.tooltip, TOOLTIP_VALUES, DEFAULTS.tooltip),
  };
}

function pick<T extends string>(
  value: string | boolean | undefined,
  allowed: readonly string[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}
