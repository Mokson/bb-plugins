import {
  formatUsedPercent,
  type ProviderUsage,
  type UsageWindow,
} from "./usage.ts";
import type { CompactLimitOption } from "./preferences.ts";

export function formatResetsIn(
  value: string | null,
  now = new Date(),
): string {
  if (value === null) return "Reset unavailable";
  const resetTime = new Date(value).getTime();
  if (Number.isNaN(resetTime)) return "Reset unavailable";
  const minutes = Math.ceil((resetTime - now.getTime()) / 60_000);
  if (minutes <= 0) return "Resets soon";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatRelativeAge(value: string | null, now = new Date()): string {
  if (value === null) return "just now";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function formatResetsInShort(
  value: string | null,
  now = new Date(),
): string {
  if (value === null) return "";
  const resetTime = new Date(value).getTime();
  if (Number.isNaN(resetTime)) return "";
  const minutes = Math.ceil((resetTime - now.getTime()) / 60_000);
  if (minutes <= 0) return "soon";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

export function sidebarUsageShortLabel(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("month")) return "mo";
  if (isWeeklyLabel(label)) return "wk";
  if (isFiveHourLabel(label)) return "ses";
  return label.length <= 6 ? label : label.slice(0, 5) + "…";
}

function isFiveHourLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized.includes("five") ||
    normalized.includes("5 hour") ||
    normalized.includes("5-hour") ||
    normalized.includes("current session")
  );
}

function isWeeklyLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized.includes("week") ||
    normalized.includes("seven day") ||
    normalized.includes("7 day") ||
    normalized.includes("7-day")
  );
}

export interface SidebarUsageWindows {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
}

export function sidebarUsageWindows(
  provider: ProviderUsage,
): SidebarUsageWindows {
  return {
    fiveHour:
      provider.windows.find((window) => isFiveHourLabel(window.label)) ?? null,
    weekly:
      provider.windows.find((window) => isWeeklyLabel(window.label)) ?? null,
  };
}

export interface SidebarUsageDetailRow {
  label: string;
  window: UsageWindow | null;
}

export function sidebarUsageDetailRows(
  provider: ProviderUsage,
): SidebarUsageDetailRow[] {
  const pair = sidebarUsageWindows(provider);
  const selected = new Set<UsageWindow>();
  if (pair.fiveHour !== null) selected.add(pair.fiveHour);
  if (pair.weekly !== null) selected.add(pair.weekly);

  return [
    { label: "5-hour limit", window: pair.fiveHour },
    { label: "Weekly limit", window: pair.weekly },
    ...provider.windows
      .filter((window) => !selected.has(window))
      .map((window) => ({ label: window.label, window })),
  ];
}

export function sidebarUsageSummary(provider: ProviderUsage): string {
  const { fiveHour, weekly } = sidebarUsageWindows(provider);
  const fiveHourValue =
    fiveHour === null ? "—" : formatUsedPercent(fiveHour.usedPercent);
  const weeklyValue =
    weekly === null ? "—" : formatUsedPercent(weekly.usedPercent);
  return `${fiveHourValue}% 5h · ${weeklyValue}% wk`;
}

export type SidebarUsagePrimaryFallback =
  | "none"
  | "current-alternative"
  | "last-known"
  | "unavailable";

export interface SidebarUsagePrimarySelection {
  window: UsageWindow | null;
  actualKind: CompactLimitOption | null;
  fallback: SidebarUsagePrimaryFallback;
}

function windowForKind(
  windows: SidebarUsageWindows,
  kind: CompactLimitOption,
): UsageWindow | null {
  return kind === "Weekly" ? windows.weekly : windows.fiveHour;
}

function alternateKind(kind: CompactLimitOption): CompactLimitOption {
  return kind === "Weekly" ? "Five-hour" : "Weekly";
}

export function selectSidebarUsagePrimary(
  currentProvider: ProviderUsage | undefined,
  lastKnownProvider: ProviderUsage | undefined,
  compactLimit: CompactLimitOption,
): SidebarUsagePrimarySelection {
  const alternative = alternateKind(compactLimit);

  if (currentProvider !== undefined) {
    const currentWindows = sidebarUsageWindows(currentProvider);
    const preferredWindow = windowForKind(currentWindows, compactLimit);
    if (preferredWindow !== null) {
      return {
        window: preferredWindow,
        actualKind: compactLimit,
        fallback: "none",
      };
    }

    const alternativeWindow = windowForKind(currentWindows, alternative);
    if (alternativeWindow !== null) {
      return {
        window: alternativeWindow,
        actualKind: alternative,
        fallback: "current-alternative",
      };
    }
  }

  if (lastKnownProvider !== undefined) {
    const lastKnownWindows = sidebarUsageWindows(lastKnownProvider);
    const preferredWindow = windowForKind(lastKnownWindows, compactLimit);
    if (preferredWindow !== null) {
      return {
        window: preferredWindow,
        actualKind: compactLimit,
        fallback: "last-known",
      };
    }

    const alternativeWindow = windowForKind(lastKnownWindows, alternative);
    if (alternativeWindow !== null) {
      return {
        window: alternativeWindow,
        actualKind: alternative,
        fallback: "last-known",
      };
    }
  }

  return { window: null, actualKind: null, fallback: "unavailable" };
}

export function sidebarUsagePrimarySelectionSummary(
  selection: SidebarUsagePrimarySelection,
): string {
  return selection.window === null
    ? "—%"
    : `${formatUsedPercent(selection.window.usedPercent)}%`;
}

export function sidebarUsagePrimaryAccessibleText(
  providerName: string,
  compactLimit: CompactLimitOption,
  selection: SidebarUsagePrimarySelection,
  expanded = false,
): string {
  const prefix = `${providerName} compact usage: ${compactLimit} configured`;
  const action = `${expanded ? "Close" : "Open"} ${providerName} usage details.`;
  if (selection.window === null || selection.actualKind === null) {
    return `${prefix}; no usage window is available. ${action}`;
  }

  const actual = `${selection.actualKind} ${sidebarUsagePrimarySelectionSummary(selection)}`;
  switch (selection.fallback) {
    case "none":
      return `${prefix}; showing ${actual}. ${action}`;
    case "current-alternative":
      return `${prefix}; showing ${actual} as fallback because ${compactLimit} is not currently reported. ${action}`;
    case "last-known":
      return `${prefix}; showing last-known ${actual} as fallback because no current usage window is reported. ${action}`;
    case "unavailable":
      return `${prefix}; no usage window is available. ${action}`;
  }
}

export function sidebarUsagePrimaryWindow(
  provider: ProviderUsage,
  compactLimit: CompactLimitOption,
): UsageWindow | null {
  return selectSidebarUsagePrimary(provider, undefined, compactLimit).window;
}

export function sidebarUsagePrimarySummary(
  provider: ProviderUsage,
  compactLimit: CompactLimitOption,
): string {
  return sidebarUsagePrimarySelectionSummary(
    selectSidebarUsagePrimary(provider, undefined, compactLimit),
  );
}

export function mergeLastKnownWindows(
  current: ProviderUsage,
  previous: ProviderUsage | undefined,
): ProviderUsage {
  if (previous === undefined || previous.windows.length === 0) return current;

  const currentPair = sidebarUsageWindows(current);
  const previousPair = sidebarUsageWindows(previous);
  const windows = [...current.windows];
  const handledPrevious = new Set<UsageWindow>();

  if (previousPair.fiveHour !== null) {
    handledPrevious.add(previousPair.fiveHour);
    if (currentPair.fiveHour === null) {
      windows.unshift(previousPair.fiveHour);
    }
  }
  if (previousPair.weekly !== null) {
    const alreadyHandled = handledPrevious.has(previousPair.weekly);
    handledPrevious.add(previousPair.weekly);
    if (currentPair.weekly === null && !alreadyHandled) {
      windows.push(previousPair.weekly);
    }
  }

  const currentLabels = new Set(windows.map((window) => window.label));
  for (const window of previous.windows) {
    if (handledPrevious.has(window) || currentLabels.has(window.label)) continue;
    windows.push(window);
    currentLabels.add(window.label);
  }

  return { ...current, windows };
}
