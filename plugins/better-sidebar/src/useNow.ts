import { useEffect, useState } from "react";

/** B3's resolution: buckets are relative to now, so the clock ticks per minute. */
const MINUTE = 60_000;

/**
 * The quantized clock every row and every bucket boundary reads (B3).
 *
 * Quantizing to the minute is what makes the value a stable `useMemo`
 * dependency: `Date.now()` read per render would rebuild the list model on
 * every keystroke. Ticking at all is what re-partitions a list left open
 * across local midnight without a single thread having changed.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => quantize(Date.now()));

  useEffect(() => {
    const id = window.setInterval(() => setNow(quantize(Date.now())), MINUTE);
    return () => window.clearInterval(id);
  }, []);

  return now;
}

function quantize(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}
