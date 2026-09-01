// Invariant: joining a session twice produces the same rows. The backfill
// re-runs the join over sessions it has already seen, and a join that appends
// on the second pass would double a bill nobody would think to re-check.
import { describe, expect, it } from "vitest";
import { joinPendingTurns, joinSession } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

const TURNS = [
  {
    id: "t1",
    started: "2026-09-01T10:00:00.000Z",
    completed: "2026-09-01T10:00:10.000Z",
    input: 10,
    cached: 110,
    output: 5,
  },
  {
    id: "t2",
    started: "2026-09-01T10:00:12.000Z",
    completed: "2026-09-01T10:00:30.000Z",
    input: 0,
    cached: 0,
    output: 0,
  },
];

const ROWS = [
  row({ key: "m1", at: "2026-09-01T10:00:05.000Z" }),
  row({ key: "m2", at: "2026-09-01T10:00:15.000Z" }),
  row({ key: "m3", at: "2026-09-01T10:00:18.000Z" }),
  row({
    key: "s1",
    at: "2026-09-01T10:00:16.000Z",
    sidechain: true,
    agentId: "qa",
  }),
];

function dump(harness: JoinHarness) {
  return {
    turns: harness.store.db
      .prepare("SELECT * FROM obs_turn ORDER BY turn_id")
      .all(),
    matches: harness.matchRows(),
    stats: harness.stats(),
  };
}

describe("rejoining a session", () => {
  it("writes identical rows the second time", () => {
    const harness = new JoinHarness(TURNS);
    try {
      const deps = harness.deps(ROWS);
      // The same pending list both times, so the second pass really re-joins
      // rather than finding nothing left to do.
      const pending = harness.events.listTurnsPendingSplit();
      joinSession(deps, pending);
      const first = dump(harness);
      const second = joinSession(deps, pending);
      expect(dump(harness)).toEqual(first);
      expect(second.considered).toBe(2);
    } finally {
      harness.dispose();
    }
  });

  it("is a no-op through the pending queue once every turn is matched", () => {
    const harness = new JoinHarness(TURNS);
    try {
      const deps = harness.deps(ROWS);
      joinPendingTurns(deps);
      const first = dump(harness);
      expect(joinPendingTurns(deps)).toMatchObject({ considered: 0 });
      expect(dump(harness)).toEqual(first);
    } finally {
      harness.dispose();
    }
  });
});
