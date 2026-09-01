// Invariant: an already-matched turn is still a partition boundary. The
// pending queue skips it, so partitioning over the queue alone folded its
// rows into the pending turn before it and counted that spend twice.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("a matched turn between two pending turns", () => {
  it("keeps its rows out of its neighbours", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:10.000Z",
      },
      {
        id: "t2",
        started: "2026-09-01T10:00:12.000Z",
        completed: "2026-09-01T10:00:20.000Z",
        // `log-exact` is the terminal match: it and `sidechain` are the only
        // states the pending queue skips, so this is what a boundary that is
        // not itself re-joined looks like.
        split: "log-exact",
      },
      {
        id: "t3",
        started: "2026-09-01T10:00:22.000Z",
        completed: "2026-09-01T10:00:30.000Z",
      },
    ]);
    try {
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:03.000Z" }),
        row({ key: "mid", at: "2026-09-01T10:00:15.000Z" }),
        row({ key: "c", at: "2026-09-01T10:00:24.000Z" }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));
      const stats = harness.stats();

      expect(summary.considered).toBe(2);
      expect(stats.turns["t1"]?.rows).toBe(1);
      expect(stats.turns["t3"]?.rows).toBe(1);
      expect(stats.turns["t2"]).toBeUndefined();
      expect(summary.rows).toBe(2);
    } finally {
      harness.dispose();
    }
  });
});
