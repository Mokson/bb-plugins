import { z } from "zod";
import { readStore, writeStore } from "../lib/local-store";

/**
 * The four fields a row's provider mark draws, and nothing else.
 *
 * `ProviderInfo` also carries capabilities, composer actions and maintenance
 * flags — none of which a glyph reads. Storing the narrow shape keeps the
 * cache small and keeps it valid when the host grows a field.
 */
export interface ProviderMark {
  id: string;
  displayName: string;
  /** Server-relative (`/api/v1/system/providers/<id>/logo`), so it survives a reload. */
  logoUrl: string | null;
  iconTint?: { light: string; dark: string };
}

const STORE_KEY = "provider-marks";

const MARKS_SCHEMA = z.array(
  z.object({
    id: z.string(),
    displayName: z.string(),
    logoUrl: z.string().nullable(),
    iconTint: z.object({ light: z.string(), dark: z.string() }).optional(),
  }),
);

/**
 * Read once per page load and kept in a module variable, because every row
 * asks for it: 41 rows must not mean 41 `JSON.parse` calls of the same string.
 */
let marks: ProviderMark[] | null = null;

export function cachedMarks(): readonly ProviderMark[] {
  marks ??= readStore(STORE_KEY, MARKS_SCHEMA, []);
  return marks;
}

/**
 * Replaces the cache when the host's directory lands. An empty list is not
 * written: a host that answers with nothing must not erase the marks that are
 * already drawing.
 */
export function cacheMarks(next: readonly ProviderMark[]): void {
  if (next.length === 0) return;
  marks = [...next];
  writeStore(STORE_KEY, marks);
}

/** Test seam: drops the in-memory copy so the next read hits localStorage. */
export function resetCachedMarks(): void {
  marks = null;
}
