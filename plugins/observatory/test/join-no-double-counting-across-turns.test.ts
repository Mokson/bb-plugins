// Invariant: the partition is a partition. Every main-chain row of a session
// lands in exactly one turn's slice or in one of the two unattributed
// buckets, so the counts reconcile against the log without a residual.
import { describe, expect, it } from "vitest";
import { joinPendingTurns, partitionRows } from "../src/core/join.js";
import type { PendingSplitTurn } from "../src/core/store-events.js";
import { JoinHarness, row } from "./join-harness.js";

describe("the row partition", () => {
  it("accounts for every row exactly once", () => {
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
      },
      {
        id: "t3",
        started: "2026-09-01T10:00:22.000Z",
        completed: "2026-09-01T10:00:30.000Z",
      },
    ]);
    try {
      const rows = [
        row({ key: "pre", at: "2026-09-01T09:58:00.000Z" }),
        row({ key: "a", at: "2026-09-01T10:00:03.000Z" }),
        row({ key: "b", at: "2026-09-01T10:00:09.000Z" }),
        row({ key: "c", at: "2026-09-01T10:00:13.000Z" }),
        row({ key: "d", at: "2026-09-01T10:00:23.000Z" }),
        row({ key: "e", at: "2026-09-01T10:00:29.000Z" }),
        row({ key: "tail", at: "2026-09-01T10:01:00.000Z" }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));
      const stats = harness.stats();
      const attributed = Object.values(stats.turns).reduce(
        (total, detail) => total + detail.rows,
        0,
      );

      expect(attributed + stats.unattributedBefore + stats.unattributedAfter).toBe(
        rows.length,
      );
      expect(summary.rows).toBe(5);
      expect(stats.turns["t1"]?.rows).toBe(2);
      expect(stats.turns["t2"]?.rows).toBe(1);
      expect(stats.turns["t3"]?.rows).toBe(2);
    } finally {
      harness.dispose();
    }
  });

  it("holds for turns whose start cannot be parsed", () => {
    const turns = [
      { turn_id: "t1", started_at: null, completed_at: null },
      { turn_id: "t2", started_at: "2026-09-01T10:00:00.000Z", completed_at: null },
    ] as unknown as PendingSplitTurn[];
    const rows = [
      row({ key: "a", at: "2026-09-01T09:00:00.000Z" }),
      row({ key: "b", at: "2026-09-01T10:00:05.000Z" }),
    ];
    const partition = partitionRows(turns, rows);
    expect(partition.buckets[0]).toHaveLength(0);
    expect(partition.buckets[1]).toHaveLength(1);
    expect(partition.before).toHaveLength(1);
    expect(partition.after).toHaveLength(0);
  });
});
