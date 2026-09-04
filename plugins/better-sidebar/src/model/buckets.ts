import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { NO_HOST_KEY, type DateBucketKey, type SectionKey, type StatusGroupKey } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** B41: the dimmest level any bucket may reach, so `OLDER` stays legible. */
export const DIM_FLOOR = 3 as const;

/** Start of the local calendar day containing `at`, as epoch ms. */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * B2. `today` and `yesterday` are local calendar days; the wider buckets are
 * rolling windows measured from `now`.
 */
export function bucketOf(latestAttentionAt: number, now: number): DateBucketKey {
  const todayStart = startOfLocalDay(now);
  if (latestAttentionAt >= todayStart) return "today";
  const yesterdayStart = startOfLocalDay(todayStart - 1);
  if (latestAttentionAt >= yesterdayStart) return "yesterday";
  const age = now - latestAttentionAt;
  if (age <= 7 * DAY_MS) return "last-7";
  if (age <= 30 * DAY_MS) return "last-30";
  return "older";
}

const DIM_BY_BUCKET: Record<DateBucketKey, 0 | 1 | 2 | 3> = {
  today: 0,
  yesterday: 1,
  "last-7": 2,
  "last-30": 3,
  older: DIM_FLOOR,
};

/**
 * B41 under the §7 B41-vs-B14 ruling: `needs-you`, `pinned`, `today` and the
 * search list are never dimmed; date buckets step down to `DIM_FLOOR`.
 */
export function dimLevelFor(section: SectionKey): 0 | 1 | 2 | 3 {
  // B86.3: a filed thread reads like an old one. Reusing `OLDER`'s level keeps
  // the panel on one dim scale rather than inventing a second row style.
  if (isCompletedSection(section)) return DIM_FLOOR;
  // B89: a WORKING subgroup inherits its group's own level, so a thread in
  // `working:older` still reads as old now that the subgroups hold the rows.
  if (isWorkingSection(section)) {
    const group = section.slice(WORKING_PREFIX.length);
    return Object.hasOwn(DIM_BY_BUCKET, group)
      ? DIM_BY_BUCKET[group as DateBucketKey]
      : 0;
  }
  return Object.hasOwn(DIM_BY_BUCKET, section)
    ? DIM_BY_BUCKET[section as DateBucketKey]
    : 0;
}

const STATIC_LABELS: Record<string, string> = {
  "needs-you": "NEEDS YOU",
  done: "DONE",
  pinned: "PINNED",
  // B65.4: the same five words the row's glyph legend uses, plus the `unread`
  // state B67.7 folds the DONE band into.
  "status:needs-you": "NEEDS YOU",
  "status:unread": "UNREAD",
  "status:working": "WORKING",
  "status:planning": "PLANNING",
  "status:draft": "DRAFT",
  "status:idle": "IDLE",
  [NO_HOST_KEY]: "NO MACHINE",
  today: "TODAY",
  yesterday: "YESTERDAY",
  "last-7": "LAST 7 DAYS",
  "last-30": "LAST 30 DAYS",
  older: "OLDER",
  all: "THREADS",
  search: "RESULTS",
};

/**
 * `dynamicLabels` resolves the `project:<id>` and `host:<id>` sections, keyed by
 * the WHOLE section key so a project id and a host id can never collide.
 * An unresolved key falls back to its own id.
 */
export function labelFor(
  section: SectionKey,
  dynamicLabels: ReadonlyMap<SectionKey, string>,
): string {
  // B86.1: every subgroup reads COMPLETED. Its own group's name is already the
  // header directly above it, so repeating it here would say the same word
  // twice in two rows. This test comes FIRST: the generic fallback below would
  // otherwise turn `completed:project:p1` into "PROJECT:P1".
  if (isCompletedSection(section)) return "COMPLETED";
  if (isWorkingSection(section)) return "WORKING";
  const staticLabel = STATIC_LABELS[section];
  if (staticLabel !== undefined) return staticLabel;
  const resolved = dynamicLabels.get(section);
  if (resolved !== undefined) return resolved.toUpperCase();
  return section.slice(section.indexOf(":") + 1).toUpperCase();
}

/**
 * B7: `NEEDS YOU` and `PINNED` are not collapsible; every other section is,
 * including the B67.6 `DONE` band and the B65 host and status groups.
 */
export function isCollapsibleSection(section: SectionKey): boolean {
  return section !== "needs-you" && section !== "pinned" && section !== "search";
}

/** B86.1: the prefix every COMPLETED subgroup key carries. */
export const COMPLETED_PREFIX = "completed:";

/** B89: the prefix every WORKING subgroup key carries. */
export const WORKING_PREFIX = "working:";


/**
 * True for either per-group subgroup, whichever group it hangs off.
 *
 * One predicate rather than two string tests at every site: the header's
 * indent, size and fold handling key off exactly this.
 */
export function isSubgroupSection(section: SectionKey): boolean {
  return (
    section.startsWith(COMPLETED_PREFIX) ||
    section.startsWith(WORKING_PREFIX)
  );
}

/**
 * True for a COMPLETED subgroup, whichever group it hangs off.
 *
 * One predicate rather than four string tests: the label, the dim level, the
 * fold default and the count all key off exactly this, and four copies of a
 * `startsWith` drift the moment the prefix changes.
 */
export function isCompletedSection(section: SectionKey): boolean {
  return section.startsWith(COMPLETED_PREFIX);
}

/** B89: true for a WORKING subgroup, whichever group it hangs off. */
export function isWorkingSection(section: SectionKey): boolean {
  return section.startsWith(WORKING_PREFIX);
}

/**
 * B86.4: a COMPLETED subgroup starts folded; every other section starts open.
 *
 * `useCollapse` stores the sections the user has FOLDED, so an absent key
 * means "never touched", which for every other section reads as open. This
 * inverts that test for the completed keys. The stored set still records the
 * user's first toggle either way, so one click settles it for good — and it
 * settles that ONE subgroup, not the rest.
 */
export function isCollapsedByDefault(section: SectionKey): boolean {
  return isCompletedSection(section);
}

/**
 * B86.4: the one section whose header draws its own count.
 *
 * Superseding B53.1 dropped the tally from every header, because it answered a
 * question nobody asks of a date bucket. `COMPLETED` is the exception it did
 * not have to consider: it is folded on arrival, so without a number the
 * header is a closed box whose contents cannot be seen at all.
 */
export function showsCount(section: SectionKey): boolean {
  return isCompletedSection(section);
}

/** B65.5/B67.7: the status groups, in the order they render. */
export const STATUS_GROUP_ORDER: readonly StatusGroupKey[] = [
  "needs-you",
  "unread",
  "working",
  "planning",
  "draft",
  "idle",
];

/**
 * B65.4. The row's own five-state vocabulary, read off the same `indicator`
 * values `StatusGlyph` reads, so a user who learned the glyphs reads the same
 * words here. `hasPendingInteraction` is the B1 needs-you signal and outranks
 * the indicator, exactly as it does in the band.
 */
export function statusGroupOf(thread: PluginSidebarThread): StatusGroupKey {
  if (thread.hasPendingInteraction) return "needs-you";
  switch (thread.indicator) {
    case "waiting-for-input":
      return "needs-you";
    case "unread-success":
    case "unread-error":
      return "unread";
    case "runtime":
    case "workflow":
    case "background-agent":
    case "background-command":
      return "working";
    case "plan-mode":
    case "goal":
      return "planning";
    case "draft":
    case "working-draft":
      return "draft";
    // B20: `none` and any future indicator kind read as idle rather than
    // throwing or vanishing.
    default:
      return "idle";
  }
}

/** Section render order within a group-by mode, ignoring emptiness. */
export const DATE_BUCKET_ORDER: readonly DateBucketKey[] = [
  "today",
  "yesterday",
  "last-7",
  "last-30",
  "older",
];
