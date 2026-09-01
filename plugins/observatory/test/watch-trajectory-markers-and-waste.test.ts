// A trajectory is the join of the spend module's turns with the watch
// module's signals. Two things must hold: a turn carries a marker only while
// the signal that implies it was actually open, and the waste table attributes
// rather than partitions.
import { describe, expect, it } from "vitest";
import {
  markerForKind,
  trajectoryTurns,
  wasteByRule,
} from "../src/app/lib/trajectory.js";
import type { WatchSignal } from "../src/watch/contract.js";
import type { TurnRow } from "../src/spend/contract.js";

function turn(id: string, startedAt: string, costUsd: number | null): TurnRow {
  return {
    turnId: id,
    startedAt,
    durationMs: 1000,
    modelRequested: "claude-opus-5",
    modelReported: "claude-opus-5",
    effort: "high",
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: null,
    costUsd,
    costSource: "catalog",
    splitSource: "log-exact",
    flags: [],
  };
}

function signal(
  kind: string,
  openedAt: string,
  closedAt: string | null,
): WatchSignal {
  return {
    id: `sig_${kind}_${openedAt}`,
    kind,
    severity: "warn",
    openedAt,
    closedAt,
    evidence: `${kind} evidence`,
    payload: {},
  };
}

describe("marker derivation", () => {
  it("maps each rule family to its uppercase marker", () => {
    expect(markerForKind("read-edit-read-oscillation")).toBe("OSCILLATION");
    expect(markerForKind("repeated-identical-tool")).toBe("LOOP");
    expect(markerForKind("retry-storm")).toBe("LOOP");
    expect(markerForKind("prefix-changed")).toBe("CONTEXT RESET");
    expect(markerForKind("compaction")).toBe("CONTEXT RESET");
  });

  it("gives a rule with no marker family none, rather than a wrong one", () => {
    expect(markerForKind("silence-no-inflight")).toBeNull();
    expect(markerForKind("tree-budget")).toBeNull();
  });
});

describe("the trajectory join", () => {
  const turns = [
    turn("t1", "2026-09-01T09:00:00.000Z", 1),
    turn("t2", "2026-09-01T09:05:00.000Z", 2),
    turn("t3", "2026-09-01T09:20:00.000Z", 4),
  ];
  const signals = [
    signal(
      "repeated-identical-tool",
      "2026-09-01T09:04:00.000Z",
      "2026-09-01T09:10:00.000Z",
    ),
    signal("read-edit-read-oscillation", "2026-09-01T09:04:30.000Z", null),
  ];

  it("marks only the turns a signal was open across", () => {
    const rows = trajectoryTurns(turns, signals);
    expect(rows[0]!.markers).toEqual([]);
    expect(rows[1]!.markers).toEqual(["LOOP", "OSCILLATION"]);
    // The loop closed at 09:10, so only the still-open oscillation reaches t3.
    expect(rows[2]!.markers).toEqual(["OSCILLATION"]);
  });

  it("puts each covering signal's evidence inline on its turn", () => {
    const rows = trajectoryTurns(turns, signals);
    expect(rows[1]!.items).toEqual([
      "repeated-identical-tool evidence",
      "read-edit-read-oscillation evidence",
    ]);
    expect(rows[0]!.items).toEqual([]);
  });

  it("counts one marker per turn however many signals imply it", () => {
    const doubled = [
      signal("repeated-identical-tool", "2026-09-01T09:04:00.000Z", null),
      signal("retry-storm", "2026-09-01T09:04:00.000Z", null),
    ];
    expect(trajectoryTurns(turns, doubled)[1]!.markers).toEqual(["LOOP"]);
  });

  it("treats a signal that closed exactly at a turn's start as not covering", () => {
    const edge = [
      signal(
        "repeated-identical-tool",
        "2026-09-01T09:00:00.000Z",
        "2026-09-01T09:05:00.000Z",
      ),
    ];
    expect(trajectoryTurns(turns, edge)[1]!.markers).toEqual([]);
  });
});

describe("waste attribution", () => {
  const turns = [
    turn("t1", "2026-09-01T09:00:00.000Z", 1),
    turn("t2", "2026-09-01T09:05:00.000Z", 2),
  ];

  it("attributes a turn to every rule covering it, so rules can overlap", () => {
    const rows = wasteByRule(turns, [
      signal("repeated-identical-tool", "2026-09-01T08:00:00.000Z", null),
      signal("read-edit-read-oscillation", "2026-09-01T09:01:00.000Z", null),
    ]);
    expect(rows).toEqual([
      { rule: "repeated-identical-tool", turns: 2, costUsd: 3 },
      { rule: "read-edit-read-oscillation", turns: 1, costUsd: 2 },
    ]);
  });

  it("reports an unpriced rule as unknown cost, never as zero", () => {
    const unpriced = [turn("t1", "2026-09-01T09:00:00.000Z", null)];
    const rows = wasteByRule(unpriced, [
      signal("tree-budget", "2026-09-01T08:00:00.000Z", null),
    ]);
    expect(rows).toEqual([{ rule: "tree-budget", turns: 1, costUsd: null }]);
  });

  it("returns nothing when no rule fired", () => {
    expect(wasteByRule(turns, [])).toEqual([]);
  });
});
