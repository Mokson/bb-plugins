// Turning characters into a token estimate, and then checking that estimate
// against the only ground truth a provider gives us.
//
// Nobody ships the tokenizer these numbers would need, so the estimate is
// chars/3.6 with a learned per-provider correction. The correction is learned
// from `cache_write` on the FIRST logged turn of a thread, which is the
// provider writing the whole prefix into its cache exactly once: it is the
// prefix size, measured by the party doing the billing. `cached_input` is not
// the same number — it is what a LATER turn re-read, so it counts the prefix
// plus whatever history had accumulated, and calibrating against it would
// inflate every estimate by the size of the conversation.
import type { Database } from "better-sqlite3";

/** Characters per token. The starting point every provider is corrected from. */
export const CHARS_PER_TOKEN = 3.6;

/** Meta key holding the learned multiplier for one provider. */
export function calibrationKey(provider: string): string {
  return `context:calibration:${provider}`;
}

export function estimateTokens(text: string, factor = 1): number {
  return Math.round((text.length / CHARS_PER_TOKEN) * factor);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The `cache_write` of the first logged turn of each recent session.
 *
 * Grouped by session and reduced to the earliest row: a later turn's write is
 * an incremental top-up of the cache, not the prefix.
 */
export function firstTurnCacheWrites(
  db: Database,
  provider: string,
  sinceMs: number,
  limit = 50,
): number[] {
  const rows = db
    .prepare<[string, number, number], { cache_write: number }>(
      `SELECT cache_write FROM obs_log_turn AS lt
        WHERE lt.provider = ?
          AND lt.ts >= ?
          AND lt.cache_write IS NOT NULL
          AND lt.cache_write > 0
          AND lt.is_sidechain IS NOT 1
          AND lt.ts = (
            SELECT MIN(inner.ts) FROM obs_log_turn AS inner
             WHERE inner.provider = lt.provider
               -- IS rather than =: a NULL thread id must group with the other
               -- NULL ones instead of matching nothing.
               AND inner.provider_thread_id IS lt.provider_thread_id
               AND inner.cache_write IS NOT NULL
               AND inner.cache_write > 0
               -- Mirror the outer predicate: a sidechain's first write is not
               -- the thread's prefix, so it must not become the row picked.
               AND inner.is_sidechain IS NOT 1)
        ORDER BY lt.ts DESC
        LIMIT ?`,
    )
    .all(provider, sinceMs, limit);
  return rows.map((row) => row.cache_write);
}

/** The provider with the most recent logged turn, when the caller named none. */
export function newestProvider(db: Database): string | null {
  const row = db
    .prepare<[], { provider: string | null }>(
      "SELECT provider FROM obs_log_turn ORDER BY ts DESC LIMIT 1",
    )
    .get();
  return row?.provider ?? null;
}

export interface Calibration {
  /**
   * The freshly fitted multiplier, persisted for the NEXT scan. Null when
   * there was no evidence to fit against.
   */
  factor: number | null;
  /**
   * The factor persisted BEFORE this call. Null when none was, which is the
   * honest report: the scan then carries no calibration at all.
   */
  prior: number | null;
  /**
   * The multiplier this scan is priced with: `prior`, or 1 when there is none.
   * Pricing with `factor` instead would make the total equal the observed
   * prefix by construction.
   */
  applied: number;
  /**
   * How far the PREVIOUS factor's prediction fell from the observed prefix,
   * relative to it. Null when there is nothing to check against. This is the
   * number the phase's done-check reads, so it is measured before the factor
   * is updated, never after.
   */
  error: number | null;
  samples: number;
}

export interface CalibrateInput {
  db: Database;
  provider: string | null;
  rawEstimate: number;
  sinceMs: number;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/**
 * Judge the stored factor against fresh evidence, then update it.
 *
 * Order matters twice over. The reported error is out of sample: fitting the
 * factor first and then measuring would report zero every time, which is the
 * shape of a metric that has stopped saying anything. And the caller prices
 * its scan with `applied` — the PRIOR factor — for the same reason: a scan
 * priced with a factor fitted from the very cache writes it is compared
 * against would always land exactly on the observed median.
 */
export function calibrate(input: CalibrateInput): Calibration {
  const { db, provider, rawEstimate } = input;
  if (!provider || rawEstimate <= 0) {
    return { factor: null, prior: null, applied: 1, error: null, samples: 0 };
  }
  const key = calibrationKey(provider);
  const stored = Number.parseFloat(input.getMeta(key) ?? "");
  const prior = Number.isFinite(stored) && stored > 0 ? stored : null;
  const samples = firstTurnCacheWrites(db, provider, input.sinceMs);
  const observed = median(samples);
  const applied = prior ?? 1;
  if (observed === null || observed <= 0) {
    return { factor: prior, prior, applied, error: null, samples: 0 };
  }
  const predicted = rawEstimate * applied;
  const error = Math.abs(predicted - observed) / observed;
  const factor = observed / rawEstimate;
  input.setMeta(key, String(factor));
  return { factor, prior, applied, error, samples: samples.length };
}
