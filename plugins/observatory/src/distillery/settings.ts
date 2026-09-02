// Distillery's configuration.
//
// `distillery_improvementsDir` and `distillery_monthlyBudgetUsd` are declared
// by phase 0 in `server.ts` and are deliberately absent here: declaring one
// twice would fork its default. Everything below is new in phase 6.
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";

export const PROVIDER_KEY = "distillery_provider";
export const MODEL_KEY = "distillery_model";
export const EFFORT_KEY = "distillery_effort";
export const APPEND_FINDINGS_KEY = "distillery_appendFindings";
export const IMPROVEMENTS_DIR_KEY = "distillery_improvementsDir";
export const MONTHLY_BUDGET_KEY = "distillery_monthlyBudgetUsd";

export const DEFAULT_PROVIDER = "claude-code";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "low";
export const DEFAULT_IMPROVEMENTS_DIR = "~/.agents/improvements";
export const DEFAULT_MONTHLY_BUDGET_USD = 10;

export const DISTILLERY_SETTING_DESCRIPTORS = {
  [PROVIDER_KEY]: {
    type: "string",
    label: "Distillery: drafting provider",
    description:
      "Provider for the hidden drafting thread. Pinned rather than inherited so a draft's cost and behaviour do not drift with the UI's current provider.",
    default: DEFAULT_PROVIDER,
  },
  [MODEL_KEY]: {
    type: "string",
    label: "Distillery: drafting model",
    default: DEFAULT_MODEL,
  },
  [EFFORT_KEY]: {
    type: "select",
    label: "Distillery: drafting effort",
    description:
      "Drafting is a structured extraction over evidence that is already assembled, not a reasoning task.",
    options: ["none", "low", "medium", "high"],
    default: DEFAULT_EFFORT,
  },
  [APPEND_FINDINGS_KEY]: {
    type: "boolean",
    label: "Distillery: append proposed rows to a repo's FINDINGS register",
    description:
      "Off by default. When on, apply also appends a `proposed` row to the target repo's .agents/retro/FINDINGS.md, and only when that repo is on its default branch.",
    default: false,
  },
} satisfies PluginSettingDescriptors;

export interface DistilleryConfig {
  provider: string;
  model: string;
  effort: string;
  improvementsDir: string;
  monthlyBudgetUsd: number;
  appendFindings: boolean;
}

function str(
  value: string | boolean | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

/**
 * Resolve the effective config from settings alone.
 *
 * Unlike watch there is no KV override layer: none of these knobs is one
 * someone reaches for mid-incident, and drafting spend is bounded by the
 * budget rather than by a switch someone has to flip in time.
 */
export function readDistilleryConfig(
  settings: Record<string, string | boolean | undefined>,
): DistilleryConfig {
  const budget = Number(settings[MONTHLY_BUDGET_KEY]);
  return {
    provider: str(settings[PROVIDER_KEY], DEFAULT_PROVIDER),
    model: str(settings[MODEL_KEY], DEFAULT_MODEL),
    effort: str(settings[EFFORT_KEY], DEFAULT_EFFORT),
    improvementsDir: str(
      settings[IMPROVEMENTS_DIR_KEY],
      DEFAULT_IMPROVEMENTS_DIR,
    ),
    // A budget that fails to parse falls back to the default rather than to
    // zero or Infinity: zero would silently disable drafting forever, and
    // Infinity would spend without a ceiling. Both are worse than the default.
    monthlyBudgetUsd: Number.isFinite(budget)
      ? budget
      : DEFAULT_MONTHLY_BUDGET_USD,
    appendFindings: settings[APPEND_FINDINGS_KEY] === true,
  };
}
