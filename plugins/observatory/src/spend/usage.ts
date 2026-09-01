// The absorbed usage-tracker footer strip, server half.
//
// Ported unchanged in behavior from `bb-plugins/plugins/usage-tracker`
// (`lib/usage.ts`, `lib/load-usage.ts`, `lib/preferences.ts`). The strip's app
// code is being absorbed as is, so the normalization rules here are a
// compatibility surface, not a design: bb reports each provider under one of
// two wire ids, an absent provider is an `error` row rather than a missing
// one, and `barPercent` is clamped while `usedPercent` is not, because a plan
// at 118 percent is a true number and a bar at 118 percent is a broken bar.
//
// The presentation helpers (Intl formatters) deliberately did NOT come across:
// they belong to the panel, and this module is the server.
import type { UsagePreferencesView, UsageSnapshotView } from "./contract.js";

export const PROVIDER_IDS = ["codex", "claudeCode", "cursor"] as const;
export const SIDEBAR_PROVIDER_IDS = ["claudeCode", "codex"] as const;
export const COMPACT_LIMIT_OPTIONS = ["Weekly", "Five-hour"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type SidebarProviderId = (typeof SIDEBAR_PROVIDER_IDS)[number];
export type CompactLimitOption = (typeof COMPACT_LIMIT_OPTIONS)[number];
export type RawProviderId = ProviderId | "claude-code" | "acp-cursor";

export interface UsageCost {
  usedUsdCents: number;
  limitUsdCents: number;
}

export interface RawUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: UsageCost;
}

export interface RawHealthyProviderUsage {
  status: "ok";
  accountEmail: string | null;
  planLabel: string | null;
  windows: RawUsageWindow[];
}

export type RawProviderUsage =
  | RawHealthyProviderUsage
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | {
      status: "error";
      message: string;
      planLabel?: string | null;
      accountEmail?: string | null;
    };

export type RawUsageResponse = Partial<Record<RawProviderId, RawProviderUsage>>;

interface ProviderDefinition {
  id: ProviderId;
  wireIds: readonly RawProviderId[];
  name: string;
  loginCommand: string;
}

const PROVIDERS: readonly ProviderDefinition[] = [
  { id: "codex", wireIds: ["codex"], name: "Codex", loginCommand: "codex login" },
  {
    id: "claudeCode",
    wireIds: ["claude-code", "claudeCode"],
    name: "Claude Code",
    loginCommand: "claude",
  },
  {
    id: "cursor",
    wireIds: ["acp-cursor", "cursor"],
    name: "Cursor",
    loginCommand: "cursor-agent login",
  },
];

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Usage percentages must be finite numbers");
  }
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function statusMessage(
  provider: ProviderDefinition,
  usage: Exclude<RawProviderUsage, RawHealthyProviderUsage>,
): string {
  switch (usage.status) {
    case "not_installed":
      return `${provider.name} is not installed on this machine.`;
    case "unauthenticated":
      return `Sign in with \`${provider.loginCommand}\`, then refresh usage.`;
    case "expired":
      return `The ${provider.name} session expired. Run \`${provider.loginCommand}\`, then refresh usage.`;
    case "error":
      return usage.message.trim() || `${provider.name} usage is unavailable.`;
  }
}

type ProviderUsageView = UsageSnapshotView["providers"][number];

function normalizeProvider(
  definition: ProviderDefinition,
  usage: RawProviderUsage | undefined,
): ProviderUsageView {
  if (usage === undefined) {
    return {
      id: definition.id,
      name: definition.name,
      status: "error",
      accountEmail: null,
      planLabel: null,
      message: `${definition.name} usage was not reported by bb.`,
      windows: [],
    };
  }
  if (usage.status !== "ok") {
    return {
      id: definition.id,
      name: definition.name,
      status: usage.status,
      accountEmail:
        usage.status === "error" ? (usage.accountEmail ?? null) : null,
      planLabel: usage.status === "error" ? (usage.planLabel ?? null) : null,
      message: statusMessage(definition, usage),
      windows: [],
    };
  }
  return {
    id: definition.id,
    name: definition.name,
    status: "ok",
    accountEmail: usage.accountEmail,
    planLabel: usage.planLabel,
    message: null,
    windows: usage.windows.map((window) => ({
      label: window.label,
      usedPercent: finiteNumber(window.usedPercent, "usedPercent"),
      barPercent: clampPercent(window.usedPercent),
      resetsAt: window.resetsAt,
      cost:
        window.cost === undefined
          ? null
          : {
              usedUsdCents: finiteNumber(
                window.cost.usedUsdCents,
                "usedUsdCents",
              ),
              limitUsdCents: finiteNumber(
                window.cost.limitUsdCents,
                "limitUsdCents",
              ),
            },
    })),
  };
}

function providerUsage(
  response: RawUsageResponse,
  definition: ProviderDefinition,
): RawProviderUsage | undefined {
  for (const wireId of definition.wireIds) {
    const usage = response[wireId];
    if (usage !== undefined) return usage;
  }
  return undefined;
}

export function normalizeUsage(
  response: RawUsageResponse,
  host: UsageSnapshotView["host"],
  fetchedAt = new Date(),
): UsageSnapshotView {
  return {
    fetchedAt: fetchedAt.toISOString(),
    host,
    providers: PROVIDERS.map((provider) =>
      normalizeProvider(provider, providerUsage(response, provider)),
    ),
  };
}

export interface UsageSdk {
  threads: {
    get(args: { threadId: string }): Promise<{ environmentId: string | null }>;
  };
  environments: {
    get(args: { environmentId: string }): Promise<{ hostId: string }>;
  };
  hosts: { get(args: { hostId: string }): Promise<{ name: string }> };
  system: {
    usageLimits(args?: { hostId?: string }): Promise<RawUsageResponse>;
  };
}

export async function resolveThreadHostId(
  sdk: Pick<UsageSdk, "threads" | "environments">,
  threadId: string,
): Promise<string | null> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) return null;
  try {
    return (await sdk.environments.get({ environmentId: thread.environmentId }))
      .hostId;
  } catch {
    return null;
  }
}

async function resolveHostName(
  sdk: Pick<UsageSdk, "hosts">,
  hostId: string | null,
): Promise<string | null> {
  if (hostId === null) return null;
  try {
    return (await sdk.hosts.get({ hostId })).name;
  } catch {
    return null;
  }
}

export async function loadUsageSnapshot(
  sdk: UsageSdk,
  threadId: string | null,
  fetchedAt = new Date(),
): Promise<UsageSnapshotView> {
  const hostId =
    threadId === null ? null : await resolveThreadHostId(sdk, threadId);
  const [response, hostName] = await Promise.all([
    hostId === null
      ? sdk.system.usageLimits()
      : sdk.system.usageLimits({ hostId }),
    resolveHostName(sdk, hostId),
  ]);
  return normalizeUsage(response, { id: hostId, name: hostName }, fetchedAt);
}

export function normalizeCompactLimitOption(
  value: unknown,
): CompactLimitOption {
  return COMPACT_LIMIT_OPTIONS.find((option) => option === value) ?? "Weekly";
}

export function usagePreferences(values: {
  claudeCode: boolean;
  codex: boolean;
  compactLimit: unknown;
}): UsagePreferencesView {
  const enabled = SIDEBAR_PROVIDER_IDS.filter((providerId) =>
    providerId === "claudeCode" ? values.claudeCode : values.codex,
  );
  return {
    enabledProviderIds: [...enabled],
    compactLimit: normalizeCompactLimitOption(values.compactLimit),
  };
}
