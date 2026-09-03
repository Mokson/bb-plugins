export const SIDEBAR_PROVIDER_IDS = [
  "claudeCode",
  "codex",
  "opencodeGo",
] as const;
export const COMPACT_LIMIT_OPTIONS = ["Weekly", "Five-hour"] as const;

export type SidebarProviderId = (typeof SIDEBAR_PROVIDER_IDS)[number];
export type CompactLimitOption = (typeof COMPACT_LIMIT_OPTIONS)[number];

export function normalizeCompactLimitOption(
  value: unknown,
): CompactLimitOption {
  return COMPACT_LIMIT_OPTIONS.find((option) => option === value) ?? "Weekly";
}

export interface UsageTrackerPreferences {
  enableClaudeCode: boolean;
  enableCodex: boolean;
  enableOpenCodeGo: boolean;
  compactLimit: CompactLimitOption;
}

const PROVIDER_TOGGLE: Readonly<
  Record<
    SidebarProviderId,
    "enableClaudeCode" | "enableCodex" | "enableOpenCodeGo"
  >
> = {
  claudeCode: "enableClaudeCode",
  codex: "enableCodex",
  opencodeGo: "enableOpenCodeGo",
};

export function enabledSidebarProviderIds(
  preferences: Pick<
    UsageTrackerPreferences,
    "enableClaudeCode" | "enableCodex" | "enableOpenCodeGo"
  >,
): SidebarProviderId[] {
  return SIDEBAR_PROVIDER_IDS.filter(
    (providerId) => preferences[PROVIDER_TOGGLE[providerId]] === true,
  );
}
