// Invariant: the last turn does not absorb the rest of the session. Nothing
// closes its slice from the right, so without a tail trim every row a later
// unjoined turn wrote would inflate it.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("rows past the last turn's completion", () => {
  it("are counted as unattributed rather than folded into the tail turn", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:10.000Z",
        input: 10,
        cached: 110,
        output: 5,
      },
    ]);
    try {
      const rows = [
        // Before the session's first turn began: nobody's spend.
        row({ key: "pre", at: "2026-09-01T09:59:00.000Z" }),
        row({ key: "a", at: "2026-09-01T10:00:05.000Z" }),
        // Past completion + the 10s flush window.
        row({ key: "tail", at: "2026-09-01T10:00:25.000Z" }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));

      expect(summary).toMatchObject({
        rows: 1,
        unattributedBefore: 1,
        unattributedAfter: 1,
        logExact: 1,
      });
      expect(harness.turnRow("t1")).toMatchObject({
        cache_read_tokens: 100,
        cache_write_tokens: 10,
      });
      expect(harness.stats()).toMatchObject({
        unattributedBefore: 1,
        unattributedAfter: 1,
      });
    } finally {
      harness.dispose();
    }
  });

  it("keeps a row inside the flush window on the tail turn", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:10.000Z",
        input: 20,
        cached: 220,
        output: 10,
      },
    ]);
    try {
      const summary = joinPendingTurns(
        harness.deps([
          row({ key: "a", at: "2026-09-01T10:00:05.000Z" }),
          row({ key: "flush", at: "2026-09-01T10:00:19.000Z" }),
        ]),
      );
      expect(summary).toMatchObject({ rows: 2, unattributedAfter: 0, logExact: 1 });
    } finally {
      harness.dispose();
    }
  });
});
