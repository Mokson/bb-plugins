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
               AND inner.provider_thread_id = lt.provider_thread_id
               AND inner.cache_write IS NOT NULL
               AND inner.cache_write > 0)
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
  /** Multiplier to apply to raw chars/3.6. Null when never learned. */
  factor: number | null;
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
 * Judge the current factor against fresh evidence, then update it.
 *
 * Order matters: the reported error is out of sample. Fitting the factor first
 * and then measuring would report zero every time, which is the shape of a
 * metric that has stopped saying anything.
 */
export function calibrate(input: CalibrateInput): Calibration {
  const { db, provider, rawEstimate } = input;
  if (!provider || rawEstimate <= 0) {
    return { factor: null, error: null, samples: 0 };
  }
  const key = calibrationKey(provider);
  const stored = Number.parseFloat(input.getMeta(key) ?? "");
  const prior = Number.isFinite(stored) && stored > 0 ? stored : null;
  const samples = firstTurnCacheWrites(db, provider, input.sinceMs);
  const observed = median(samples);
  if (observed === null || observed <= 0) {
    return { factor: prior, error: null, samples: 0 };
  }
  const predicted = rawEstimate * (prior ?? 1);
  const error = Math.abs(predicted - observed) / observed;
  const factor = observed / rawEstimate;
  input.setMeta(key, String(factor));
  return { factor, error, samples: samples.length };
}
