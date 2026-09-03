/** Display helpers. Pure, so the awkward rounding is covered by tests. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact age of a timestamp: "now", "12m", "3h", "5d", then a date. Rollup
 * rows carry one of these per skill and per thread, so it stays short.
 */
export function relativeAge(timestampMs: number, nowMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  const delta = nowMs - timestampMs;
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d`;
  return new Date(timestampMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Clock time for a single invocation in thread scope. */
export function clockTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Backfill progress as a fraction, or null before the pass counts threads. */
export function progressLabel(done: number, total: number): string | null {
  if (total <= 0) return null;
  return `${Math.min(done, total)}/${total} threads`;
}
