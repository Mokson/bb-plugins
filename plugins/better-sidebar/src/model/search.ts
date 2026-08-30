import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** One row offered to the B43 ranker, with its title already resolved (B13). */
export interface SearchCandidate {
  readonly thread: PluginSidebarThread;
  readonly title: string;
  /** Never null for a search row (B43): the project label shows on every result. */
  readonly projectName: string;
}

/**
 * Higher is a better match. `null` means no match at all, so the row is filtered
 * out. The tiers are coarse on purpose: within a tier B43 orders by
 * `latestAttentionAt`, which is what the user is actually scanning for.
 */
export function matchScore(title: string, query: string): number | null {
  const haystack = title.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  if (haystack === needle) return 4;
  if (haystack.startsWith(needle)) return 3;
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  // A match starting a word reads as more relevant than one inside one.
  return /\s|[-_/:.]/.test(haystack.charAt(index - 1)) ? 2 : 1;
}

/**
 * B43: one flat list ranked by match score, then `latestAttentionAt` descending,
 * with `id` breaking ties so the order is total and stable.
 */
export function rankSearch(
  candidates: readonly SearchCandidate[],
  query: string,
): readonly SearchCandidate[] {
  const scored: { candidate: SearchCandidate; score: number }[] = [];
  for (const candidate of candidates) {
    const score = matchScore(candidate.title, query);
    if (score !== null) scored.push({ candidate, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const attention =
      b.candidate.thread.latestAttentionAt - a.candidate.thread.latestAttentionAt;
    if (attention !== 0) return attention;
    return a.candidate.thread.id < b.candidate.thread.id ? -1 : 1;
  });
  return scored.map((entry) => entry.candidate);
}
