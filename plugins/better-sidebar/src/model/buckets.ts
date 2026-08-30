import type { DateBucketKey, SectionKey } from "./types";

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
  return Object.hasOwn(DIM_BY_BUCKET, section)
    ? DIM_BY_BUCKET[section as DateBucketKey]
    : 0;
}

const STATIC_LABELS: Record<string, string> = {
  "needs-you": "NEEDS YOU",
  pinned: "PINNED",
  today: "TODAY",
  yesterday: "YESTERDAY",
  "last-7": "LAST 7 DAYS",
  "last-30": "LAST 30 DAYS",
  older: "OLDER",
  all: "THREADS",
  search: "RESULTS",
};

/** `projectNames` resolves the `project:<id>` sections; unknown ids fall back to the id. */
export function labelFor(
  section: SectionKey,
  projectNames: ReadonlyMap<string, string>,
): string {
  const staticLabel = STATIC_LABELS[section];
  if (staticLabel !== undefined) return staticLabel;
  const projectId = section.slice("project:".length);
  return (projectNames.get(projectId) ?? projectId).toUpperCase();
}

/** B7: `NEEDS YOU` and `PINNED` are not collapsible; every other section is. */
export function isCollapsibleSection(section: SectionKey): boolean {
  return section !== "needs-you" && section !== "pinned" && section !== "search";
}

/** Section render order within a group-by mode, ignoring emptiness. */
export const DATE_BUCKET_ORDER: readonly DateBucketKey[] = [
  "today",
  "yesterday",
  "last-7",
  "last-30",
  "older",
];
