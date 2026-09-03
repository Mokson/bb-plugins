const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The coarse age label at row 1's right edge: "now", "5m", "2h", "3d", "2w".
 *
 * Deliberately coarse. The exact minute does not help you decide what to look
 * at next, and a precise label would change on every render. B12 turns on it
 * being per-row: a child under an old parent reads its own `updatedAt`, so a
 * recent child is visibly recent.
 *
 * Callers pass a quantized `now` shared by every row in one render, so a
 * timestamp sitting exactly on a bucket boundary can read one unit low for up
 * to a minute. That is the accepted cost of a clock that does not churn.
 */
export function relativeTimeLabel(timestamp: number, now: number): string {
  const elapsed = now - timestamp;
  // Corrupt host data must not print "NaNw". Unknown reads as unknown, never
  // as a false "now".
  if (!Number.isFinite(elapsed)) return "—";
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / (7 * DAY))}w`;
}

/**
 * B70.5. How long a span lasted: "<1m", "47m", "3h", "2d", "2w".
 *
 * The same units as `relativeTimeLabel`, and a separate function on purpose.
 * That one returns "now" under a minute, which is an age; a duration of "now"
 * reads as nonsense, so a short span says "<1m" instead.
 *
 * A negative span — a clock that moved backwards, or an `updatedAt` that
 * precedes its `createdAt` — floors at zero rather than printing a minus sign.
 */
export function durationLabel(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return "—";
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < MINUTE) return "<1m";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / (7 * DAY))}w`;
}
