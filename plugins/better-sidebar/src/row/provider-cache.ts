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
 * Round-2 L2: `iconTint` lands in `backgroundColor`, so it is an allowlist,
 * not a passthrough. Hex (`#rgb`–`#rrggbbaa`) plus the `rgb()`/`rgba()` and
 * `color-mix()` function shapes the directory actually emits; anything else
 * (including an empty string) voids the whole tint — both-or-neither, matching
 * the two-mask drawing — rather than one theme's mask.
 */
const HEX_TINT = /^#[0-9a-fA-F]{3,8}$/;
const FUNCTION_TINT = /^(rgba?|color-mix)\(\s*[^;{}<>"'`\\]*\s*\)$/i;

function isSafeTintColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  return HEX_TINT.test(value) || FUNCTION_TINT.test(value);
}

export function sanitizeIconTint(
  tint: { light: string; dark: string } | undefined,
): { light: string; dark: string } | undefined {
  if (tint === undefined) return undefined;
  if (!isSafeTintColor(tint.light) || !isSafeTintColor(tint.dark)) {
    return undefined;
  }
  return tint;
}

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
