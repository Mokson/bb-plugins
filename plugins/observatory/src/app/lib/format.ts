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

/** A turn duration in seconds, one decimal. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  return `${(ms / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}s`;
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

/** A percentage for the cache-miss drop line. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  return `${Math.round(value)}%`;
}
