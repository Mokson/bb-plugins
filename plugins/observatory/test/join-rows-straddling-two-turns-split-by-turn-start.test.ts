// Invariant: adjacent turns are separated by the NEXT turn's start, not by
// the previous turn's padded window. The windows overlap by design, so a
// window test hands the second turn's rows to the first one.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("rows straddling two turns", () => {
  it("are cut at the later turn's start, not at the earlier turn's window", () => {
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
        started: "2026-09-01T10:00:11.000Z",
        completed: "2026-09-01T10:00:20.000Z",
        input: 10,
        cached: 110,
        output: 5,
      },
    ]);
    try {
      // 10:00:12 sits inside t1's old window (completed + 10s) AND after t2
      // began. The partition gives it to t2; the window gave it to t1.
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:05.000Z" }),
        row({ key: "b", at: "2026-09-01T10:00:12.000Z" }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));

      expect(summary).toMatchObject({ logExact: 2, unavailable: 0, rows: 2 });
      expect(harness.stats().turns["t1"]?.rows).toBe(1);
      expect(harness.stats().turns["t2"]?.rows).toBe(1);
      expect(harness.matchRows().map((match) => match["log_key"])).toEqual([
        "claude-code:sess-1:a",
        "claude-code:sess-1:b",
      ]);
    } finally {
      harness.dispose();
    }
  });
});
