// The threshold table's edit model.
//
// The settings page edits numbers inline and writes only what changed. That
// "only what changed" is the whole point: `observatory_watch_settings_set`
// takes a partial map, and sending every threshold back would rewrite each one
// into KV, converting every `setting`-sourced row into a `kv`-sourced one and
// quietly detaching the whole table from the plugin's settings.
import type { WatchSettings, WatchSource } from "../../watch/contract.js";

/** One row of the editable table. */
export interface ThresholdRow {
  key: string;
  /** The value the server last reported. */
  value: number;
  /** What the reader has typed, verbatim, so a half-typed number survives. */
  draft: string;
  source: WatchSource;
}

/** Build the table from a settings response, in stable key order. */
export function thresholdRows(settings: WatchSettings): ThresholdRow[] {
  return Object.keys(settings.thresholds)
    .sort()
    .map((key) => ({
      key,
      value: settings.thresholds[key]!,
      draft: String(settings.thresholds[key]!),
      source: settings.source[key] ?? "setting",
    }));
}

/**
 * Parse one draft.
 *
 * Blank or unparseable is `null`, which the caller treats as "not an edit"
 * rather than as zero: a reader who cleared a box to retype it has not asked
 * for a threshold of nothing.
 */
export function parseDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The thresholds to send: every row whose draft parses to a different number
 * than the server reported. An empty result means there is nothing to write,
 * and the page disables its save control on exactly that condition.
 */
export function changedThresholds(
  rows: readonly ThresholdRow[],
): Record<string, number> {
  const changed: Record<string, number> = {};
  for (const row of rows) {
    const parsed = parseDraft(row.draft);
    if (parsed === null || parsed === row.value) continue;
    changed[row.key] = parsed;
  }
  return changed;
}

/** True when at least one row differs, so the page can gate its save button. */
export function hasChanges(rows: readonly ThresholdRow[]): boolean {
  return Object.keys(changedThresholds(rows)).length > 0;
}

/** Replace one row's draft, returning a new list so React sees the change. */
export function withDraft(
  rows: readonly ThresholdRow[],
  key: string,
  draft: string,
): ThresholdRow[] {
  return rows.map((row) => (row.key === key ? { ...row, draft } : row));
}

/**
 * Discard one row's unsaved edit.
 *
 * Distinct from resetting to the setting, which only the server can do (it
 * drops the KV override; see `reset` on `observatory_watch_settings_set`).
 * The page calls this after that write returns, so the box stops showing a
 * number the server no longer holds.
 */
export function discardDraft(
  rows: readonly ThresholdRow[],
  key: string,
): ThresholdRow[] {
  return rows.map((row) =>
    row.key === key ? { ...row, draft: String(row.value) } : row,
  );
}
