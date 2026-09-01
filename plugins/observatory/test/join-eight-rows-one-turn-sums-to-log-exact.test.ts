// Invariant: one bb turn is a whole agentic loop, so its log slice is MANY
// rows and the turn's split is their SUM. Requiring a single row to equal the
// turn's totals is what held claude-code coverage at 5.4%.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("a turn's whole slice", () => {
  it("sums eight rows into one log-exact split", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:01:00.000Z",
        input: 80,
        cached: 880,
        output: 40,
      },
    ]);
    try {
      const rows = Array.from({ length: 8 }, (_, index) =>
        row({
          key: `r${index}`,
          at: `2026-09-01T10:00:${String(5 + index).padStart(2, "0")}.000Z`,
          model: index === 7 ? "claude-sonnet-4.6" : "claude-opus-5",
        }),
      );

      const summary = joinPendingTurns(harness.deps(rows));

      expect(summary).toMatchObject({ logExact: 1, logWindow: 0, rows: 8 });
      expect(harness.turnRow("t1")).toMatchObject({
        cache_read_tokens: 800,
        cache_write_tokens: 80,
        split_source: "log-exact",
        // The model the turn ENDED on, not the one it opened with.
        model_reported: "claude-sonnet-4.6",
      });
      expect(harness.matchRows()).toEqual([
        expect.objectContaining({ method: "partition", confidence: 1 }),
      ]);
      const detail = harness.stats().turns["t1"];
      expect(detail?.rows).toBe(8);
      expect(detail?.models.sort()).toEqual([
        "claude-opus-5",
        "claude-sonnet-4.6",
      ]);
    } finally {
      harness.dispose();
    }
  });
});
