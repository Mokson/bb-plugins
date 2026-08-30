import type { z } from "zod";

const KEY_PREFIX = "better-sidebar:";

/**
 * Namespaced, schema-validated localStorage read. Never throws: a missing key,
 * disabled storage, malformed JSON, or a schema mismatch all fall back to
 * `fallback` rather than blanking the caller.
 */
export function readStore<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(KEY_PREFIX + key);
    if (stored === null) return fallback;
    const parsed = schema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Namespaced localStorage write. Never throws: a disabled or full store is a no-op. */
export function writeStore<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch {
    // storage disabled or full — collapse/preference state degrades to defaults on next read
  }
}
