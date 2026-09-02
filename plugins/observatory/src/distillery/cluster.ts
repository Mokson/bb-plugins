// Clustering: many observations of one failure become one candidate.
//
// The threshold is the whole point of the module. A failure seen once is an
// anecdote and drafting a harness rule from it is exactly the "speculative
// change is worse than none" mistake; a failure seen twice IN TWO DIFFERENT
// RUNS is a pattern, because a second run is an independent trial. Two hits
// inside one run is usually one root cause counted twice — the same nudge
// echoed by the QA row it caused — which is why `runs` is counted separately
// from `size` and both must clear the bar.
import { createHash } from "node:crypto";
import type { ClusterView, TopCluster } from "./contract.js";
import type { CorrectionView } from "./contract.js";

/** Corrections needed before a cluster may be drafted. */
export const MIN_CLUSTER_SIZE = 2;

/** Distinct run folders needed before a cluster may be drafted. */
export const MIN_CLUSTER_RUNS = 2;

/** Words carried in a shingle. Long enough to be specific, short enough to
 * survive rewording between two runs describing the same failure. */
const SHINGLE_WORDS = 6;

/**
 * Words that appear in nearly every ledger line and so carry no signal. Left
 * in, they would cluster "the seat stopped correctly" with "the seat ran over
 * budget" on the strength of "the" and "seat".
 */
const STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "have",
  "been",
  "were",
  "when",
  "then",
  "than",
  "which",
  "would",
  "could",
  "should",
  "there",
  "their",
  "about",
  "after",
  "before",
  "seat",
  "run",
  "runs",
  "thread",
  "agent",
]);

/**
 * The clustering key: cause class plus a sorted shingle of the preview.
 *
 * Sorted, because two people describing one failure reliably pick the same
 * nouns and reliably order them differently. Digits are stripped for the same
 * reason `signatureOf` strips them: the numbers are what VARY between two
 * instances of one failure.
 */
export function normalizeSignature(
  causeClass: string | null,
  preview: string,
): string {
  const words = preview
    .toLowerCase()
    .replace(/\[redacted:[^\]]*\]/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word));
  const shingle = [...new Set(words)].sort().slice(0, SHINGLE_WORDS);
  return `${causeClass ?? "untagged"}|${shingle.join(" ")}`;
}

/** A short stable id for a normalized signature. */
export function clusterId(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export interface Cluster extends ClusterView {
  /** The corrections that built it, newest last. */
  members: CorrectionView[];
  /** True when it clears BOTH thresholds. */
  qualifies: boolean;
}

/**
 * Group corrections into clusters. Pure: it neither reads nor writes the
 * database, so a test can drive it with hand-built rows.
 */
export function clusterCorrections(
  corrections: readonly CorrectionView[],
): Cluster[] {
  const groups = new Map<string, CorrectionView[]>();
  for (const item of corrections) {
    const key = normalizeSignature(item.causeClass, item.preview);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const clusters: Cluster[] = [];
  for (const [normalized, members] of groups) {
    const sorted = [...members].sort((a, b) => a.at.localeCompare(b.at));
    // A correction with no run folder cannot prove independence, so it counts
    // toward `size` but never toward `runs`. Otherwise every unattributed
    // transcript guess would clear the two-run bar by itself.
    const runs = new Set(
      sorted
        .map((item) => item.runFolder)
        .filter((folder): folder is string => folder !== null),
    ).size;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) continue;
    clusters.push({
      id: clusterId(normalized),
      signature: normalized,
      // The most common tag among members, so one untagged member does not
      // erase a cause class three tagged members agree on.
      causeClass: dominantCauseClass(sorted),
      size: sorted.length,
      runs,
      firstAt: first.at,
      lastAt: last.at,
      status: "open",
      members: sorted,
      qualifies: sorted.length >= MIN_CLUSTER_SIZE && runs >= MIN_CLUSTER_RUNS,
    });
  }

  return clusters.sort(
    (a, b) => b.size - a.size || b.runs - a.runs || a.id.localeCompare(b.id),
  );
}

function dominantCauseClass(members: readonly CorrectionView[]): string | null {
  const tally = new Map<string, number>();
  for (const member of members) {
    if (!member.causeClass) continue;
    tally.set(member.causeClass, (tally.get(member.causeClass) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [tag, count] of tally) {
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

/** The status view's top clusters, biggest first, signatures only. */
export function topClusters(
  clusters: readonly Cluster[],
  limit = 5,
): TopCluster[] {
  return clusters.slice(0, limit).map((cluster) => ({
    signature: cluster.signature,
    cause_class: cluster.causeClass,
    size: cluster.size,
    runs: cluster.runs,
  }));
}
