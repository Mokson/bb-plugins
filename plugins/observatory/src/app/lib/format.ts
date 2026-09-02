// Number rendering for every spend surface.
//
// One rule the whole module obeys: a number the ledger does not know renders
// `--`, never `0` and never a guess (PRODUCT invariants 2 and 27). An
// estimated number keeps its digits and gains a superscript `e`, so a reader
// can tell "we did not measure this" from "we measured zero" at a glance.

/** What every unknown numeric cell renders. */
export const UNKNOWN = "--";

/** The marker appended to an estimated number. U+1D49, a superscript e. */
export const ESTIMATE_MARK = "ᵉ";

function marked(text: string, estimated: boolean): string {
  return estimated ? `${text}${ESTIMATE_MARK}` : text;
}

/**
 * A dollar amount. Under a cent but non-zero still shows four decimals: a
 * per-turn bill is often $0.0037 and rounding it to $0.00 reads as free.
 */
export function formatUsd(
  value: number | null | undefined,
  estimated = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return marked(
    value.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
    estimated,
  );
}

/** The marker appended to a total some of whose parts are unknown. */
export const PARTIAL_MARK = "+";

/**
 * A token count. Grouped, never abbreviated: 1.2M hides a 200k difference.
 *
 * `partial` marks an aggregate summed over the rows that HAVE the measurement
 * while at least one row under it does not: `353,000+` is a floor and reads as
 * one. Bare, it would state a total nothing established; `--` (the old
 * behaviour) threw away every proven read because one descendant lacked a
 * split.
 */
export function formatTokens(
  value: number | null | undefined,
  estimated = false,
  partial = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  const text = Math.round(value).toLocaleString("en-US");
  return marked(partial ? `${text}${PARTIAL_MARK}` : text, estimated);
}

/** A plain count. Never estimated, so it takes no mark. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  return Math.round(value).toLocaleString("en-US");
}

/**
 * A duration at the coarsest unit that still says something: `42.0s` under a
 * minute, then `30m`, `1h 12m`, `2d 3h`. A stall measured in hours read as
 * `7200.0s`, which is a number to do arithmetic on rather than a duration to
 * read. Two units is the ceiling; the third never changed a decision.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** A wall-clock stamp for a turn row. Unparseable input renders `--`. */
export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNKNOWN;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

/**
 * How long a thread has been silent, at the coarsest unit that still tells the
 * reader something: seconds under a minute, whole minutes under an hour, hours
 * and minutes above. A stall is judged in minutes, so `842s` would be precision
 * nobody reads.
 */
export function formatSilence(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return UNKNOWN;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How full the silence timer bar is: silent time over the rule's threshold,
 * clamped to 1. A thread three times over threshold still draws a full bar -
 * the bar answers "is this past the line", and the exact number sits beside it.
 */
export function silenceRatio(
  silentMs: number,
  thresholdMs: number | null | undefined,
): number {
  if (
    thresholdMs === null ||
    thresholdMs === undefined ||
    !Number.isFinite(thresholdMs) ||
    thresholdMs <= 0
  ) {
    return 0;
  }
  return Math.max(0, Math.min(1, silentMs / thresholdMs));
}

/**
 * A share held as a fraction (0..1) rendered as a percentage with one
 * decimal. Composition shares are often under 1% and rounding them to `0%`
 * reads as "not present" rather than "small".
 */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  return `${(value * 100).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/**
 * A delta against a median, held as a fraction. Always signed: the sign is
 * the whole message, and an unsigned `12%` beside a median reads as a share.
 */
export function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  const percent = value * 100;
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/** A byte count, grouped like a token count and never abbreviated. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  return Math.round(value).toLocaleString("en-US");
}

/** A percentage for the cache-miss drop line. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  return `${Math.round(value)}%`;
}
