import {
  normalizeUsage,
  type RawUsageResponse,
  type UsageSnapshot,
} from "./usage.ts";

export interface UsageSdk {
  threads: {
    get(args: { threadId: string }): Promise<{ environmentId: string | null }>;
  };
  environments: {
    get(args: { environmentId: string }): Promise<{ hostId: string }>;
  };
  hosts: {
    get(args: { hostId: string }): Promise<{ name: string }>;
  };
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
    const environment = await sdk.environments.get({
      environmentId: thread.environmentId,
    });
    return environment.hostId;
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

/**
 * Provider usage the plugin gathers itself, layered under whatever bb reports.
 * bb never emits these keys, so the overlay can only ever add providers.
 */
export async function loadUsageSnapshot(
  sdk: UsageSdk,
  threadId: string | null,
  fetchedAt = new Date(),
  extra: RawUsageResponse = {},
): Promise<UsageSnapshot> {
  const hostId =
    threadId === null ? null : await resolveThreadHostId(sdk, threadId);
  const [bbResponse, hostName] = await Promise.all([
    hostId === null
      ? sdk.system.usageLimits()
      : sdk.system.usageLimits({ hostId }),
    resolveHostName(sdk, hostId),
  ]);
  const response: RawUsageResponse = { ...extra, ...bbResponse };

  return normalizeUsage(response, { id: hostId, name: hostName }, fetchedAt);
}
