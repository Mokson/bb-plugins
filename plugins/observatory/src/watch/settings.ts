// Watch's configuration: seven rule toggles, seven thresholds, a mode, and
// quiet hours.
//
// Two layers, and KV always wins. A setting needs a plugin reload to take
// effect, which is exactly wrong for the knob a person reaches for while
// staring at a false positive, so the panel writes KV and the setting is only
// the durable default underneath.
import type {
  BbPluginApi,
  PluginSettingDescriptors,
} from "@get-bb/plugin-sdk";
import { RULE_IDS, WATCH_MODES, type RuleId, type WatchMode } from "./contract.js";

/** KV key holding the threshold overrides, `{ watch_silenceMinutes: 4 }`. */
export const THRESHOLDS_KV_KEY = "watch:thresholds";
/** KV key holding the mode override. Outranks the `watch_mode` setting. */
export const MODE_KV_KEY = "watch:mode";

/**
 * The threshold each rule reads, and its default.
 *
 * Setting keys are camelCase after the `watch_` prefix because bb rejects a
 * key that is not letters, digits, "-" or "_", and the rule ids are
 * hyphenated. The mapping is explicit so neither name has to be derived from
 * the other.
 */
export const RULE_THRESHOLDS = {
  "silence-no-inflight": { key: "watch_silenceMinutes", default: 4 },
  "repeated-identical-tool": { key: "watch_repeatCount", default: 3 },
  "read-edit-read": { key: "watch_oscillationCycles", default: 2 },
  "active-no-turn": { key: "watch_activeNoTurnMinutes", default: 10 },
  "burn-no-change": { key: "watch_burnTokens", default: 150_000 },
  "retry-storm": { key: "watch_retryCount", default: 3 },
  // Tree budget reuses the two budget settings phase 0 already declared, so a
  // person sets their spend ceiling once and both modules honour it.
  "tree-budget": { key: "budget_perTreeUsd", default: 50 },
} as const satisfies Record<RuleId, { key: string; default: number }>;

/** The second tree-budget threshold; the rule reads both. */
export const PER_DAY_KEY = "budget_perDayUsd";
export const PER_DAY_DEFAULT = 500;

/** The enable flag for a rule. */
export const RULE_ENABLED_KEYS = {
  "silence-no-inflight": "watch_silenceNoInflight_enabled",
  "repeated-identical-tool": "watch_repeatedIdenticalTool_enabled",
  "read-edit-read": "watch_readEditRead_enabled",
  "active-no-turn": "watch_activeNoTurn_enabled",
  "burn-no-change": "watch_burnNoChange_enabled",
  "retry-storm": "watch_retryStorm_enabled",
  "tree-budget": "watch_treeBudget_enabled",
} as const satisfies Record<RuleId, string>;

export const QUIET_HOURS_KEY = "watch_quietHours";

/**
 * Descriptors this module adds to the plugin's set. `watch_mode`,
 * `budget_perTreeUsd` and `budget_perDayUsd` are declared by phase 0 and are
 * deliberately absent here: declaring one twice would fork its default.
 */
export const WATCH_SETTING_DESCRIPTORS = {
  ...Object.fromEntries(
    RULE_IDS.map((rule) => [
      RULE_ENABLED_KEYS[rule],
      {
        type: "boolean",
        label: `Watch rule: ${rule}`,
        description: `Evaluate the ${rule} rule.`,
        default: true,
      },
    ]),
  ),
  "watch_silenceMinutes": {
    type: "string",
    label: "Watch: silence with nothing in flight (minutes)",
    default: "4",
  },
  "watch_repeatCount": {
    type: "string",
    label: "Watch: identical tool calls in the last 20 items",
    default: "3",
  },
  "watch_oscillationCycles": {
    type: "string",
    label: "Watch: read/edit/read cycles on one path",
    default: "2",
  },
  "watch_activeNoTurnMinutes": {
    type: "string",
    label: "Watch: active with no turn started (minutes)",
    default: "10",
  },
  "watch_burnTokens": {
    type: "string",
    label: "Watch: tokens burned since the last file change",
    default: "150000",
  },
  "watch_retryCount": {
    type: "string",
    label: "Watch: retrying provider errors within 10 minutes",
    default: "3",
  },
  [QUIET_HOURS_KEY]: {
    type: "string",
    label: "Watch: quiet hours",
    description:
      'Local-time window that suppresses notifications, "22-07" style. Signals are still recorded. Empty disables it.',
    default: "22-07",
  },
} satisfies PluginSettingDescriptors;

export interface QuietHours {
  /** Inclusive local hour the window opens. */
  from: number;
  /** Exclusive local hour it closes; less than `from` means it wraps midnight. */
  to: number;
}

/**
 * Parse `"22-07"`. Anything unparseable disables the window rather than
 * guessing: a typo must not silence every notification forever.
 */
export function parseQuietHours(
  value: string | boolean | undefined,
): QuietHours | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(value);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from > 23 || to > 23 || from === to) return null;
  return { from, to };
}

/** True inside the window, which may wrap midnight (`22-07`). */
export function inQuietHours(hours: QuietHours | null, at: Date): boolean {
  if (!hours) return false;
  const hour = at.getHours();
  return hours.from < hours.to
    ? hour >= hours.from && hour < hours.to
    : hour >= hours.from || hour < hours.to;
}

export type ThresholdSource = "kv" | "setting";

export interface WatchConfig {
  mode: WatchMode;
  enabled: Record<RuleId, boolean>;
  thresholds: Record<string, number>;
  source: Record<string, ThresholdSource>;
  quietHours: QuietHours | null;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "boolean" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve the effective config. KV first, then the setting, then the coded
 * default — and `source` reports which layer answered, because "I changed the
 * setting and nothing happened" is otherwise indistinguishable from a bug.
 */
export async function readWatchConfig(
  bb: BbPluginApi,
  settings: Record<string, string | boolean | undefined>,
): Promise<WatchConfig> {
  const kvThresholds =
    (await bb.storage.kv.get<Record<string, unknown>>(THRESHOLDS_KV_KEY)) ??
    {};
  const kvMode = await bb.storage.kv.get<string>(MODE_KV_KEY);

  const thresholds: Record<string, number> = {};
  const source: Record<string, ThresholdSource> = {};
  for (const rule of RULE_IDS) {
    const { key, default: fallback } = RULE_THRESHOLDS[rule];
    fill(key, fallback);
  }
  fill(PER_DAY_KEY, PER_DAY_DEFAULT);

  function fill(key: string, fallback: number): void {
    const override = kvThresholds[key];
    if (override !== undefined && Number.isFinite(Number(override))) {
      thresholds[key] = Number(override);
      source[key] = "kv";
      return;
    }
    thresholds[key] = toNumber(settings[key], fallback);
    source[key] = "setting";
  }

  const modeFromKv =
    typeof kvMode === "string" &&
    (WATCH_MODES as readonly string[]).includes(kvMode);
  const settingMode = settings["watch_mode"];
  const mode: WatchMode = modeFromKv
    ? (kvMode as WatchMode)
    : typeof settingMode === "string" &&
        (WATCH_MODES as readonly string[]).includes(settingMode)
      ? (settingMode as WatchMode)
      : "observe";
  source["mode"] = modeFromKv ? "kv" : "setting";

  const enabled = Object.fromEntries(
    RULE_IDS.map((rule) => {
      const value = settings[RULE_ENABLED_KEYS[rule]];
      // Absent means on: a rule ships enabled, and a fake host that declares
      // no settings at all must still evaluate.
      return [rule, value === undefined ? true : value === true];
    }),
  ) as Record<RuleId, boolean>;

  return {
    mode,
    enabled,
    thresholds,
    source,
    quietHours: parseQuietHours(settings[QUIET_HOURS_KEY]),
  };
}
