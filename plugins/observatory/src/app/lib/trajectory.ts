// The trajectory tab's two derivations: which markers a turn carries, and
// where the thread's wasted money went.
//
// Neither rpc returns a trajectory. `observatory_spend_thread` returns the
// turns with their bills and `observatory_watch_explain` returns the signals
// with their open/close stamps; a trajectory is the join of the two on time.
// Doing that join here, as pure functions over both shapes, keeps the page a
// renderer and makes the interesting part testable without a browser.
import type { WatchSignal } from "../../watch/contract.js";
import type { TurnRow } from "../../spend/contract.js";

/**
 * The three markers a turn row can carry, uppercase because PRODUCT invariant
 * 34 forbids colour as hierarchy: an uppercase word is the only emphasis left
 * that survives a screenshot and a colour-blind reader.
 */
export const MARKERS = ["OSCILLATION", "LOOP", "CONTEXT RESET"] as const;
export type Marker = (typeof MARKERS)[number];

/**
 * Which rule kinds mean which marker.
 *
 * Matching is by substring on the rule kind rather than by equality: the
 * server owns the exact rule ids (PRODUCT invariant 21 names them in prose),
 * and a marker that silently vanishes when a rule is renamed is worse than one
 * that matches a family.
 */
const MARKER_PATTERNS: ReadonlyArray<{ marker: Marker; pattern: RegExp }> = [
  { marker: "OSCILLATION", pattern: /oscillat/i },
  { marker: "LOOP", pattern: /repeated-identical|loop|retry-storm/i },
  { marker: "CONTEXT RESET", pattern: /compact|prefix-changed|context-reset/i },
];

/** The marker one signal kind implies, or null when it implies none. */
export function markerForKind(kind: string): Marker | null {
  return (
    MARKER_PATTERNS.find((entry) => entry.pattern.test(kind))?.marker ?? null
  );
}

/**
 * Whether a signal was open at an instant.
 *
 * Half-open on the close side: a signal that closed exactly at a turn's start
 * did not cover that turn. An unparseable stamp is treated as not covering,
 * never as covering everything.
 */
function coversInstant(signal: WatchSignal, atMs: number): boolean {
  const opened = Date.parse(signal.openedAt);
  if (Number.isNaN(opened) || atMs < opened) return false;
  if (signal.closedAt === null) return true;
  const closed = Date.parse(signal.closedAt);
  if (Number.isNaN(closed)) return true;
  return atMs < closed;
}

/** One turn with everything the trajectory row draws. */
export interface TrajectoryTurn {
  turn: TurnRow;
  markers: Marker[];
  /** The evidence lines of every signal covering this turn, in signal order. */
  items: string[];
}

/**
 * Join turns to the signals open during them.
 *
 * Markers are de-duplicated per turn: three repeated-tool signals inside one
 * turn are one LOOP, not three, and the reader is counting turns, not signals.
 */
export function trajectoryTurns(
  turns: readonly TurnRow[],
  signals: readonly WatchSignal[],
): TrajectoryTurn[] {
  return turns.map((turn) => {
    const atMs = Date.parse(turn.startedAt);
    const covering = Number.isNaN(atMs)
      ? []
      : signals.filter((signal) => coversInstant(signal, atMs));
    const markers: Marker[] = [];
    for (const signal of covering) {
      const marker = markerForKind(signal.kind);
      if (marker !== null && !markers.includes(marker)) markers.push(marker);
    }
    return {
      turn,
      markers,
      items: covering.map((signal) => signal.evidence),
    };
  });
}

/** One row of the waste attribution table. */
export interface WasteRow {
  /** The signal kind, which is the rule that fired. */
  rule: string;
  turns: number;
  /** Sum of the covered turns' bills, or null when none of them was priced. */
  costUsd: number | null;
}

/**
 * What the waste table says when it has no rows.
 *
 * Two different empties, and the page conflated them: an attribution row
 * exists only where a turn's start falls inside a signal's open window, so a
 * thread with several fired rules produces no rows at all when its turns began
 * before the first signal opened. The turn table directly above is meanwhile
 * showing those rules as markers, which is how "No rule fired on this thread."
 * came to sit on top of the evidence that it had.
 */
export function wasteEmptyMessage(firedSignals: number): string {
  if (firedSignals === 0) return "No rule fired on this thread.";
  const plural = firedSignals === 1 ? "signal" : "signals";
  return `${firedSignals} rule ${plural} fired, but no turn started inside one of their windows, so there is nothing to attribute.`;
}

/**
 * What each rule cost, by attributing every turn a signal covered to that
 * signal's rule.
 *
 * A turn covered by two rules counts once under each: this is attribution, not
 * a partition, and splitting a bill between two rules would invent a precision
 * the ledger does not have. The table therefore does not sum to the thread's
 * total, and the page says so.
 */
export function wasteByRule(
  turns: readonly TurnRow[],
  signals: readonly WatchSignal[],
): WasteRow[] {
  const byRule = new Map<string, { turns: number; costUsd: number | null }>();

  for (const turn of turns) {
    const atMs = Date.parse(turn.startedAt);
    if (Number.isNaN(atMs)) continue;
    for (const signal of signals) {
      if (!coversInstant(signal, atMs)) continue;
      const entry = byRule.get(signal.kind) ?? { turns: 0, costUsd: null };
      entry.turns += 1;
      if (turn.costUsd !== null) {
        entry.costUsd = (entry.costUsd ?? 0) + turn.costUsd;
      }
      byRule.set(signal.kind, entry);
    }
  }

  // Most expensive first, then most turns, then the rule name, so the order is
  // total and an unpriced rule still has a stable place.
  return [...byRule.entries()]
    .map(([rule, entry]) => ({ rule, ...entry }))
    .sort(
      (left, right) =>
        (right.costUsd ?? -1) - (left.costUsd ?? -1) ||
        right.turns - left.turns ||
        (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0),
    );
}
