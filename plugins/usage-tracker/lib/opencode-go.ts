import type { RawProviderUsage } from "./usage.ts";

/**
 * OpenCode Go reports subscription limits through the same Zen API the models
 * run on. The endpoint is unauthenticated-readable (it answers a structured
 * auth error without a key), takes the OpenCode API key as a bearer token, and
 * returns dollar-value usage as percentages per limit window.
 */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export type FetchLike = (url: string, init?: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface OpenCodeGoWindow {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  rolling: "5-hour",
  weekly: "Weekly",
  monthly: "Monthly",
};

function missingKeyUsage(): RawProviderUsage {
  return { status: "unauthenticated" };
}

export function parseOpenCodeGoUsage(body: unknown): RawProviderUsage {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (usage === null || typeof usage !== "object") {
    throw new TypeError("OpenCode Go usage response is missing its windows");
  }

  const windows = Object.entries(WINDOW_LABELS).flatMap(([key, label]) => {
    const window = (usage as Record<string, OpenCodeGoWindow>)[key];
    if (window === undefined || window === null) return [];
    const percent = window.percent;
    const resetsAt = window.resetsAt;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new TypeError(`OpenCode Go ${label} window has no percent`);
    }
    if (resetsAt !== null && typeof resetsAt !== "string") {
      throw new TypeError(`OpenCode Go ${label} window has an invalid reset`);
    }
    return [{ label, usedPercent: percent, resetsAt: resetsAt ?? null }];
  });

  return {
    status: "ok",
    accountEmail: null,
    planLabel: "OpenCode Go",
    windows,
  };
}

export async function fetchOpenCodeGoUsage(
  apiKey: string | undefined,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<RawProviderUsage> {
  if (apiKey === undefined || apiKey.trim() === "") return missingKeyUsage();

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey.trim()}`,
      },
      signal,
    });
  } catch {
    return {
      status: "error",
      message: "OpenCode Go usage could not be reached.",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) {
    return {
      status: "error",
      message:
        response.status === 429
          ? "OpenCode Go usage was rate limited. Try again later."
          : `OpenCode Go usage request failed (HTTP ${response.status}).`,
    };
  }

  try {
    return parseOpenCodeGoUsage(await response.json());
  } catch {
    return {
      status: "error",
      message: "OpenCode Go usage response was unexpected.",
    };
  }
}
