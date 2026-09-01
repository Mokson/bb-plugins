// Invariant: a turn whose slice holds exactly one row keeps that row. The
// greedy cursor used to advance past it whenever an earlier turn matched a
// LATER row exactly, and the turn fell to `unavailable` with its evidence
// sitting one index behind the cursor.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("a turn with one row in its slice", () => {
  it("is never stranded by an earlier turn's match", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:10.000Z",
        // Deliberately unequal to its own slice: only t2 can match exactly.
        input: 999,
        cached: 999,
        output: 99,
      },
      {
        id: "t2",
        started: "2026-09-01T10:00:20.000Z",
        completed: "2026-09-01T10:00:24.000Z",
        input: 10,
        cached: 110,
        output: 5,
      },
    ]);
    try {
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:05.000Z" }),
        row({ key: "c", at: "2026-09-01T10:00:17.000Z" }),
        row({ key: "b", at: "2026-09-01T10:00:19.000Z" }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));

      expect(summary).toMatchObject({ logExact: 1, logWindow: 1, unavailable: 0 });
      expect(harness.turnRow("t2")).toMatchObject({
        split_source: "log-exact",
        cache_read_tokens: 100,
        cache_write_tokens: 10,
      });
      expect(harness.stats().turns["t2"]?.rows).toBe(1);
      expect(harness.stats().turns["t1"]?.rows).toBe(2);
    } finally {
      harness.dispose();
    }
  });
});
