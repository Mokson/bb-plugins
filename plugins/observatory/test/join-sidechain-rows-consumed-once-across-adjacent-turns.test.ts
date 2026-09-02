// Invariant: a subagent row is spend, and spend is counted once. Turn windows
// overlap, so a window test billed the same sidechain row to every turn whose
// window covered it; the partition makes single consumption structural rather
// than a claimed-key set the next refactor can drop.
import { describe, expect, it } from "vitest";
import { joinPendingTurns, sidechainTurnId } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("sidechain rows", () => {
  it("are consumed once across adjacent turns and grouped per agent", () => {
    const harness = new JoinHarness([
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
        completed: "2026-09-01T10:00:20.000Z",
        input: 10,
        cached: 110,
        output: 5,
      },
    ]);
    try {
      const rows = [
        row({ key: "m1", at: "2026-09-01T10:00:05.000Z" }),
        row({ key: "m2", at: "2026-09-01T10:00:15.000Z" }),
        // Two rows of one seat inside t1: one seat, not two.
        row({
          key: "s1",
          at: "2026-09-01T10:00:04.000Z",
          sidechain: true,
          agentId: "qa",
          output: 8,
        }),
        row({
          key: "s2",
          at: "2026-09-01T10:00:06.000Z",
          sidechain: true,
          agentId: "qa",
          output: 9,
        }),
        // Inside t1's padded window AND after t2 began: t2's, and only t2's.
        row({
          key: "s3",
          at: "2026-09-01T10:00:14.000Z",
          sidechain: true,
          agentId: "qa",
          output: 7,
        }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));

      expect(summary.sidechain).toBe(2);
      expect(harness.turnRow(sidechainTurnId("t1", "qa"))).toMatchObject({
        split_source: "sidechain",
        cache_read_tokens: 200,
        cache_write_tokens: 20,
        output_tokens: 17,
      });
      expect(harness.turnRow(sidechainTurnId("t2", "qa"))).toMatchObject({
        output_tokens: 7,
      });
      // Every sidechain output token appears exactly once in the ledger.
      const total = harness.store.db
        .prepare(
          "SELECT SUM(output_tokens) AS n FROM obs_turn WHERE split_source = 'sidechain'",
        )
        .get() as { n: number };
      expect(total.n).toBe(24);
    } finally {
      harness.dispose();
    }
  });
});
